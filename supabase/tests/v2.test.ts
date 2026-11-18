// v2 — correções da revisão de 17/11 e controle do robô pelo banco (migration 0007).
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { activateTestForm, as, createMember, errorCode, FAKE_CPF, freshDb, rpc } from "./harness/db";

let db: PGlite;
let op: string;
let bo: string;
let admin: string;

const payload = (cpf = FAKE_CPF[0], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ documento: cpf, nome_teste: "Cliente Fictício", valor_teste: 1500.5, ...extra });
const submit = (body = payload()) =>
  as(db, { sub: op }, (tx) => rpc<Record<string, unknown>>(tx,
    "public.submit_proposal_request($1, 1, $2::jsonb)", [crypto.randomUUID(), body]));
const asBo = <T>(fn: Parameters<typeof as<T>>[2]) => as(db, { sub: bo, aal: "aal2" }, fn);
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const count = async (sql: string) => (await one<{ n: number }>(`select count(*)::int n from ${sql}`)).n;

async function claimRunning() {
  await asBo((tx) => rpc(tx, "public.acknowledge_received_requests()"));
  const job = await asBo((tx) => rpc<{ job_id: string; request_id: string }>(
    tx, "public.claim_next_job('pc-backoffice', '2.0.0')"));
  await asBo((tx) => rpc(tx, "public.mark_job_running($1)", [job.job_id]));
  return job;
}

async function escalatedAfterSideEffect() {
  const r = await submit();
  const job = await claimRunning();
  await asBo((tx) => rpc(tx, "public.mark_side_effect_started($1, 'enviar_proposta')", [job.job_id]));
  await asBo((tx) => rpc(tx, "public.escalate_job($1, 'UNEXPECTED_SCREEN', 'tela inesperada')", [job.job_id]));
  return { r, job };
}

beforeEach(async () => {
  db = await freshDb();
  await activateTestForm(db);
  op = await createMember(db, "operator");
  bo = await createMember(db, "backoffice");
  admin = await createMember(db, "admin");
}, 30_000);

describe("P3 — rate limit (BUG-QA-001)", () => {
  it("recusa com {error: RATE_LIMITED} e a auditoria fica gravada", async () => {
    await db.query("update public.app_settings set value = '1' where key = 'rate_limit_per_minute'");
    await submit(payload(FAKE_CPF[0]));
    expect(await submit(payload(FAKE_CPF[1]))).toEqual({ error: "RATE_LIMITED" });
    expect(await count("public.audit_logs where action = 'request.rate_limited'")).toBe(1);
    expect(await count("public.proposal_requests")).toBe(1);
  });
});

describe("P4 — fingerprint com HMAC", () => {
  it("é HMAC-SHA256 com o segredo do servidor, não sha256 puro", async () => {
    const body = payload();
    await submit(body);
    const { fp, canon } = await one<{ fp: string; canon: string }>(
      "select fingerprint fp, (select payload::text from public.clients_temp) canon from private.request_fingerprints");
    const { key } = await one<{ key: string }>("select encode(value, 'hex') key from private.secrets where name = 'payload_fingerprint'");
    expect(fp).toBe(createHmac("sha256", Buffer.from(key, "hex")).update(canon, "utf8").digest("hex"));
  });

  it("não fica em proposal_requests (legível pela API) e some ao apagar os dados pessoais", async () => {
    const r = await submit();
    const row = await as(db, { sub: op }, (tx) => tx.query<{ payload_fingerprint: string | null }>(
      "select * from public.proposal_requests"));
    expect(row.rows[0].payload_fingerprint).toBeNull();
    expect(await errorCode(as(db, { sub: op }, (tx) => tx.query("select * from private.request_fingerprints"))))
      .toMatch(/permission denied/);
    await asBo((tx) => rpc(tx, "public.cancel_request_backoffice($1, 'teste')", [r.request_id]));
    expect(await count("private.request_fingerprints")).toBe(0);
  });

  it("segredo não é legível pela API", async () => {
    expect(await errorCode(as(db, { sub: bo, aal: "aal2" }, (tx) => tx.query("select * from private.secrets"))))
      .toMatch(/permission denied/);
  });

  it("mesmo cliente em andamento continua barrado como duplicado", async () => {
    await submit(payload(FAKE_CPF[0]));
    expect(await errorCode(submit(payload(FAKE_CPF[0])))).toBe("DUPLICATE_REQUEST");
  });
});

describe("P5 — contagens do painel", () => {
  it("agrupa por status, sem limite de linhas", async () => {
    for (let i = 0; i < 3; i++) {
      await as(db, { sub: op }, (tx) => rpc(tx, "public.submit_proposal_request($1, 1, $2::jsonb)",
        [crypto.randomUUID(), payload(FAKE_CPF[i % 2], { nome_teste: `Cliente ${i}` })]));
    }
    await asBo((tx) => rpc(tx, "public.acknowledge_received_requests()"));
    expect(await asBo((tx) => rpc(tx, "public.dashboard_counts()"))).toEqual({ queued: 3 });
  });

  it("exige backoffice com MFA", async () => {
    expect(await errorCode(as(db, { sub: op }, (tx) => rpc(tx, "public.dashboard_counts()")))).toBe("FORBIDDEN");
    expect(await errorCode(as(db, { sub: bo }, (tx) => rpc(tx, "public.dashboard_counts()")))).toBe("MFA_REQUIRED");
  });
});

describe("P6 — release_job conta tentativas", () => {
  it("abaixo do limite volta para a fila; no limite falha com MAX_ATTEMPTS", async () => {
    const r = await submit();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = await claimRunning();
      await asBo((tx) => rpc(tx, "public.release_job($1, 'CONSIG_SESSION_EXPIRED')", [job.job_id]));
      const req = await one<{ status: string; status_reason: string }>(
        "select status, status_reason from public.proposal_requests where id = $1", [r.request_id]);
      if (attempt < 3) expect(req.status).toBe("queued");
      else expect(req).toEqual({ status: "failed", status_reason: "MAX_ATTEMPTS" });
    }
  });
});

describe("P2 — resultado do robô vale (BUG-QA-002)", () => {
  it("complete_job aceita job escalado depois do ponto sem retorno", async () => {
    const { r, job } = await escalatedAfterSideEffect();
    const out = await asBo((tx) => rpc(tx, "public.complete_job($1, 'ADE-0001')", [job.job_id]));
    expect(out).toMatchObject({ status: "completed" });
    expect((await one<{ status: string }>("select status from public.proposal_requests where id = $1", [r.request_id])).status)
      .toBe("completed");
    expect(await count("public.clients_temp")).toBe(0);
  });

  it("complete_job continua recusando job escalado antes do ponto sem retorno", async () => {
    await submit();
    const job = await claimRunning();
    await asBo((tx) => rpc(tx, "public.escalate_job($1, 'UNEXPECTED_SCREEN')", [job.job_id]));
    expect(await errorCode(asBo((tx) => rpc(tx, "public.complete_job($1, 'ADE-0001')", [job.job_id]))))
      .toBe("JOB_NOT_ACTIVE");
  });

  it("com número capturado, reprocessar ou falhar é recusado (evita duplicata)", async () => {
    const { r, job } = await escalatedAfterSideEffect();
    await asBo((tx) => rpc(tx, "public.report_captured_result($1, 'ADE-0002')", [job.job_id]));
    for (const res of ["requeue", "failed"]) {
      expect(await errorCode(asBo((tx) => rpc(tx, "public.resolve_awaiting_request($1, $2)", [r.request_id, res]))))
        .toBe("ROBOT_RESULT_EXISTS");
    }
  });

  it("concluir sem digitar número usa o número capturado pelo robô", async () => {
    const { r, job } = await escalatedAfterSideEffect();
    await asBo((tx) => rpc(tx, "public.report_captured_result($1, 'ADE-0003')", [job.job_id]));
    await asBo((tx) => rpc(tx, "public.resolve_awaiting_request($1, 'completed')", [r.request_id]));
    expect((await one<{ adhesion_number: string }>("select adhesion_number from public.proposal_results")).adhesion_number)
      .toBe("ADE-0003");
  });

  it("complete_job repetido depois da resolução manual é idempotente", async () => {
    const { r, job } = await escalatedAfterSideEffect();
    await asBo((tx) => rpc(tx, "public.resolve_awaiting_request($1, 'completed', 'ADE-0004')", [r.request_id]));
    expect(await asBo((tx) => rpc(tx, "public.complete_job($1, 'ADE-0004')", [job.job_id])))
      .toMatchObject({ duplicate: true });
  });
});

describe("P7/P8 — controle do robô", () => {
  it("painel enfileira comando; robô recebe cada um uma vez, em ordem", async () => {
    await asBo((tx) => rpc(tx, "public.robot_command('pause')"));
    await asBo((tx) => rpc(tx, "public.robot_command('open_consig')"));
    const first = await asBo((tx) => rpc<{ kind: string }[]>(tx, "public.robot_poll_commands()"));
    expect(first.map((c) => c.kind)).toEqual(["pause", "open_consig"]);
    expect(await asBo((tx) => rpc(tx, "public.robot_poll_commands()"))).toEqual([]);
    expect(await count("public.audit_logs where action = 'robot.command'")).toBe(2);
  });

  it("comando inválido e papéis errados são recusados", async () => {
    expect(await errorCode(asBo((tx) => rpc(tx, "public.robot_command('rm -rf')")))).toBe("INVALID_COMMAND");
    expect(await errorCode(as(db, { sub: op }, (tx) => rpc(tx, "public.robot_command('pause')")))).toBe("FORBIDDEN");
    expect(await errorCode(as(db, { sub: admin, aal: "aal2" }, (tx) => rpc(tx, "public.robot_command('pause')"))))
      .toBe("FORBIDDEN");
  });

  it("ninguém escreve direto nas tabelas do robô", async () => {
    expect(await errorCode(asBo((tx) => tx.query("update public.robot_state set paused = true"))))
      .toMatch(/permission denied/);
    expect(await errorCode(asBo((tx) => tx.query(`insert into public.robot_commands (kind, requested_by) values ('pause', '${bo}')`))))
      .toMatch(/permission denied/);
  });

  it("robot_report_state grava sinal de vida e devolve as opções da IA", async () => {
    await asBo((tx) => rpc(tx, "public.robot_set_ai(true, 'qwen-small')"));
    const out = await asBo((tx) => rpc(tx,
      "public.robot_report_state(p_paused => false, p_consig_session => 'authenticated', p_version => '2.0.0', p_flow_ready => true)"));
    expect(out).toEqual({ paused: false, ai_enabled: true, ai_model: "qwen-small" });
    const st = await one<{ consig_session: string; last_seen_at: Date | null; version: string }>(
      "select consig_session, last_seen_at, version from public.robot_state");
    expect(st.consig_session).toBe("authenticated");
    expect(st.version).toBe("2.0.0");
    expect(st.last_seen_at).not.toBeNull();
  });

  it("operador não lê o estado do robô; backoffice lê", async () => {
    expect((await as(db, { sub: op }, (tx) => tx.query("select * from public.robot_state"))).rows).toHaveLength(0);
    expect((await asBo((tx) => tx.query("select * from public.robot_state"))).rows).toHaveLength(1);
  });
});
