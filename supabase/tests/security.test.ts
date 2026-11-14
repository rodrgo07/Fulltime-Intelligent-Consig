// D3 — Segurança do banco (RLS, anônimo, rate limit, idempotência, entrada hostil) em PGlite.
// Complementa database.test.ts. Dados 100% fictícios. A versão para o projeto real está em live/.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { activateTestForm, as, createMember, errorCode, FAKE_CPF, freshDb, rpc } from "./harness/db";

let db: PGlite;
let op: string;
let op2: string;
let bo: string;
let admin: string;

type Submit = { request_id: string; public_ref: string; status: string; duplicate: boolean };

const payload = (cpf = FAKE_CPF[0], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ documento: cpf, nome_teste: "Cliente Fictício", valor_teste: 1500.5, ...extra });

const submit = (uid: string, key: string | null = crypto.randomUUID(), body = payload()) =>
  as(db, { sub: uid }, (tx) => rpc<Submit>(tx, "public.submit_proposal_request($1, 1, $2::jsonb)", [key, body]));

const asBo = <T>(fn: Parameters<typeof as<T>>[2]) => as(db, { sub: bo, aal: "aal2" }, fn);
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const count = async (table: string) => (await one<{ n: number }>(`select count(*)::int n from ${table}`)).n;
const setSetting = (key: string, value: number) =>
  db.query("update public.app_settings set value = $2::jsonb where key = $1", [key, JSON.stringify(value)]);

async function completeFor(uid: string, cpf = FAKE_CPF[0]) {
  const r = await submit(uid, undefined, payload(cpf));
  await asBo((tx) => rpc(tx, "public.acknowledge_received_requests()"));
  const job = await asBo((tx) => rpc<{ job_id: string }>(tx, "public.claim_next_job('pc-teste')"));
  await asBo((tx) => rpc(tx, "public.mark_job_running($1)", [job.job_id]));
  await asBo((tx) => rpc(tx, "public.complete_job($1, 'ADE-TESTE-77', null, 'GERADA')", [job.job_id]));
  return r;
}

beforeEach(async () => {
  db = await freshDb();
  await activateTestForm(db);
  op = await createMember(db, "operator");
  op2 = await createMember(db, "operator");
  bo = await createMember(db, "backoffice");
  admin = await createMember(db, "admin");
}, 30_000);

describe("D3 — chamadas anônimas recusadas", () => {
  it("anon não lê nenhuma tabela do schema public", async () => {
    const tables = (await db.query<{ t: string }>(
      "select tablename t from pg_tables where schemaname = 'public' order by 1")).rows.map((r) => r.t);
    // Núcleo que deve existir em qualquer versão do schema (a lista completa muda com as migrations).
    expect(tables).toEqual(expect.arrayContaining(["profiles", "operators", "form_definitions", "proposal_requests",
      "clients_temp", "automation_jobs", "proposal_results", "audit_logs", "app_versions", "app_settings"]));
    for (const t of tables) {
      expect(await errorCode(as(db, { role: "anon" }, (tx) => tx.query(`select 1 from public.${t} limit 1`))), t)
        .toMatch(/permission denied/);
    }
  });

  it("anon não executa RPCs de operador, backoffice, admin nem de serviço", async () => {
    const calls = [
      "public.submit_proposal_request(gen_random_uuid(), 1, '{}'::jsonb)",
      "public.cancel_proposal_request(gen_random_uuid())",
      "public.backoffice_presence()",
      "public.acknowledge_received_requests()",
      "public.claim_next_job('x')",
      "public.complete_job(gen_random_uuid(), 'ADE')",
      "public.storage_usage()",
      "public.admin_set_member_active(gen_random_uuid(), false)",
    ];
    for (const c of calls) {
      expect(await errorCode(as(db, { role: "anon" }, (tx) => rpc(tx, c))), c).toMatch(/permission denied/);
    }
  });

  it("funções de serviço (svc_*) não são executáveis por anon nem por usuários da API", async () => {
    // Pelo catálogo: vale para qualquer assinatura (svc_register_member muda de assinatura no PR-B1).
    const svc = (await db.query<{ sig: string; anon: boolean; auth: boolean; service: boolean }>(`
      select p.oid::regprocedure::text sig,
             has_function_privilege('anon', p.oid, 'execute') anon,
             has_function_privilege('authenticated', p.oid, 'execute') auth,
             has_function_privilege('service_role', p.oid, 'execute') service
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'svc\_%'`)).rows;
    expect(svc.map((f) => f.sig)).toEqual(expect.arrayContaining([expect.stringMatching(/^svc_register_member\(/)]));
    for (const f of svc) expect(f, f.sig).toMatchObject({ anon: false, auth: false, service: true });
  });

  it("operador e admin não registram membros (svc_register_member é só do SQL Editor)", async () => {
    const sig = (await one<{ sig: string }>(
      "select p.oid::regprocedure::text sig from pg_proc p where p.proname = 'svc_register_member'")).sig;
    const args = sig.split(",").length >= 5 ? "$1, 'admin', 'x', 'x@exemplo.test', null" : "$1, 'admin', 'x'";
    for (const claims of [{ sub: op }, { sub: admin, aal: "aal2" as const }]) {
      expect(await errorCode(as(db, claims, (tx) => rpc(tx, `public.svc_register_member(${args})`, [op]))))
        .toMatch(/permission denied/);
    }
    expect((await one<{ role: string }>("select role from public.profiles where id = $1", [op])).role).toBe("operator");
  });

  it("anon não alcança o schema private", async () => {
    expect(await errorCode(as(db, { role: "anon" }, (tx) => rpc(tx, "private.recover_stale_jobs()"))))
      .toMatch(/permission denied/);
    expect(await errorCode(as(db, { sub: op }, (tx) => rpc(tx, "private.run_retention()"))))
      .toMatch(/permission denied/);
    expect(await errorCode(as(db, { sub: op }, (tx) => rpc(tx, "private.purge_request_pii(gen_random_uuid(), 'x')"))))
      .toMatch(/permission denied/);
  });

  it("JWT autenticado sem membro cadastrado não envia, não reserva e não vê nada", async () => {
    const orphan = crypto.randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, 'orfao@exemplo.test')", [orphan]);
    await submit(op);
    expect(await errorCode(submit(orphan))).toBe("FORBIDDEN");
    expect(await errorCode(as(db, { sub: orphan, aal: "aal2" }, (tx) => rpc(tx, "public.claim_next_job('x')"))))
      .toBe("FORBIDDEN");
    for (const t of ["proposal_requests", "profiles", "operators", "proposal_results", "audit_logs"]) {
      const rows = await as(db, { sub: orphan, aal: "aal2" }, (tx) => tx.query(`select * from public.${t}`));
      expect(rows.rows, t).toHaveLength(0);
    }
  });

  it("papel authenticated sem sub é tratado como não autenticado", async () => {
    expect(await errorCode(as(db, {}, (tx) =>
      rpc(tx, "public.submit_proposal_request(gen_random_uuid(), 1, '{}'::jsonb)")))).toBe("UNAUTHENTICATED");
  });
});

describe("D3 — isolamento entre operadores (RLS)", () => {
  it("operador não vê resultado, job nem auditoria de outro operador", async () => {
    await completeFor(op);
    for (const t of ["proposal_requests", "proposal_results", "automation_jobs", "audit_logs"]) {
      const seen = await as(db, { sub: op2 }, (tx) => tx.query(`select * from public.${t}`));
      expect(seen.rows, t).toHaveLength(0);
    }
    // O dono vê a própria solicitação e o resultado (número de adesão), mas não a fila interna.
    const own = await as(db, { sub: op }, (tx) => tx.query<{ adhesion_number: string }>("select * from public.proposal_results"));
    expect(own.rows.map((r) => r.adhesion_number)).toEqual(["ADE-TESTE-77"]);
    expect((await as(db, { sub: op }, (tx) => tx.query("select * from public.automation_jobs"))).rows).toHaveLength(0);
  });

  it("operador não lê perfil nem e-mail de outro membro", async () => {
    const profiles = await as(db, { sub: op }, (tx) => tx.query<{ id: string }>("select id from public.profiles"));
    expect(profiles.rows.map((r) => r.id)).toEqual([op]);
    const ops = await as(db, { sub: op }, (tx) => tx.query<{ id: string }>("select id from public.operators"));
    expect(ops.rows.map((r) => r.id)).toEqual([op]);
  });

  it("operador não cancela solicitação de outro e a resposta não revela que ela existe", async () => {
    const r = await submit(op);
    expect(await errorCode(as(db, { sub: op2 }, (tx) =>
      rpc(tx, "public.cancel_proposal_request($1)", [r.request_id])))).toBe("NOT_FOUND");
    expect(await errorCode(as(db, { sub: op2 }, (tx) =>
      rpc(tx, "public.cancel_proposal_request(gen_random_uuid())")))).toBe("NOT_FOUND");
    expect((await one<{ status: string }>("select status from public.proposal_requests")).status).toBe("received");
    expect(await count("public.clients_temp")).toBe(1);
  });

  it("reusar a chave de idempotência de outro operador não devolve a solicitação dele", async () => {
    const key = crypto.randomUUID();
    const a = await submit(op, key, payload(FAKE_CPF[0]));
    const b = await submit(op2, key, payload(FAKE_CPF[1]));
    expect(b.duplicate).toBe(false);
    expect(b.request_id).not.toBe(a.request_id);
    expect(b.public_ref).not.toBe(a.public_ref);
    const mine = await as(db, { sub: op2 }, (tx) => tx.query<{ id: string }>("select id from public.proposal_requests"));
    expect(mine.rows.map((r) => r.id)).toEqual([b.request_id]);
  });

  it("claims forjadas no JWT não elevam o operador (papel vem do banco)", async () => {
    const forged = { sub: op, aal: "aal2" as const, app_role: "backoffice", user_role: "admin" };
    expect(await errorCode(as(db, forged, (tx) => rpc(tx, "public.claim_next_job('x')")))).toBe("FORBIDDEN");
    expect(await errorCode(as(db, forged, (tx) => rpc(tx, "public.storage_usage()")))).toBe("FORBIDDEN");
    expect(await errorCode(as(db, forged, (tx) => rpc(tx, "public.admin_set_member_active($1, false)", [op2]))))
      .toBe("FORBIDDEN");
    expect((await one<{ active: boolean }>("select active from public.profiles where id = $1", [op2])).active).toBe(true);
    expect((await as(db, forged, (tx) => tx.query("select * from public.app_settings"))).rows).toHaveLength(0);
  });

  it("operador não vê formulários inativos nem configurações", async () => {
    await db.query("insert into public.form_definitions (version, title, fields, active) values (2, 'Rascunho', '[]', false)");
    const forms = await as(db, { sub: op }, (tx) => tx.query<{ version: number }>("select version from public.form_definitions"));
    expect(forms.rows.map((r) => r.version)).toEqual([1]);
    expect((await as(db, { sub: op }, (tx) => tx.query("select * from public.app_settings"))).rows).toHaveLength(0);
  });

  it("backoffice e admin não enviam como operador e ninguém lê clients_temp pela API", async () => {
    expect(await errorCode(submit(bo))).toBe("FORBIDDEN");
    expect(await errorCode(as(db, { sub: admin, aal: "aal2" }, (tx) =>
      rpc(tx, "public.submit_proposal_request(gen_random_uuid(), 1, $1::jsonb)", [payload()])))).toBe("FORBIDDEN");
    await submit(op);
    for (const claims of [{ sub: bo, aal: "aal2" as const }, { sub: admin, aal: "aal2" as const }]) {
      expect(await errorCode(as(db, claims, (tx) => tx.query("select * from public.clients_temp"))))
        .toMatch(/permission denied/);
    }
  });

  it("backoffice desativado perde acesso à fila imediatamente", async () => {
    await submit(op);
    await as(db, { sub: admin, aal: "aal2" }, (tx) => rpc(tx, "public.admin_set_member_active($1, false)", [bo]));
    expect(await errorCode(asBo((tx) => rpc(tx, "public.acknowledge_received_requests()")))).toBe("FORBIDDEN");
    expect((await asBo((tx) => tx.query("select * from public.proposal_requests"))).rows).toHaveLength(0);
  });
});

describe("D3 — rate limit", () => {
  it("é isolado por operador", async () => {
    await setSetting("rate_limit_per_minute", 1);
    await submit(op, undefined, payload(FAKE_CPF[0]));
    expect(await errorCode(submit(op, undefined, payload(FAKE_CPF[1])))).toBe("RATE_LIMITED");
    expect((await submit(op2, undefined, payload(FAKE_CPF[1]))).duplicate).toBe(false);
  });

  it("a janela de 1 minuto desliza: envio antigo deixa de contar", async () => {
    await setSetting("rate_limit_per_minute", 1);
    await submit(op, undefined, payload(FAKE_CPF[0]));
    await db.query("update public.proposal_requests set received_at = now() - interval '61 seconds'");
    expect((await submit(op, undefined, payload(FAKE_CPF[1]))).duplicate).toBe(false);
  });

  it("aplica o limite diário mesmo fora da janela de 1 minuto", async () => {
    await setSetting("rate_limit_per_day", 2);
    await submit(op, undefined, payload(FAKE_CPF[0]));
    await submit(op, undefined, payload(FAKE_CPF[1]));
    await db.query("update public.proposal_requests set received_at = now() - interval '2 hours'");
    expect(await errorCode(submit(op, undefined, payload(FAKE_CPF[0], { nome_teste: "Outro" })))).toBe("RATE_LIMITED");
  });

  it("envio barrado não grava nada (nem metadados, nem dados pessoais)", async () => {
    await setSetting("rate_limit_per_minute", 1);
    await submit(op, undefined, payload(FAKE_CPF[0]));
    await errorCode(submit(op, undefined, payload(FAKE_CPF[1])));
    expect(await count("public.proposal_requests")).toBe(1);
    expect(await count("public.clients_temp")).toBe(1);
  });

  it("retry com a mesma chave não é barrado pelo rate limit (devolve o registro existente)", async () => {
    await setSetting("rate_limit_per_minute", 1);
    const key = crypto.randomUUID();
    const a = await submit(op, key);
    const b = await submit(op, key);
    expect(b).toMatchObject({ request_id: a.request_id, duplicate: true });
  });

  // BUG-QA-001: private.audit('request.rate_limited') roda antes do RAISE e é desfeito pelo rollback da
  // mesma transação. Resultado: abuso barrado não deixa rastro na auditoria. Quando corrigido, este teste
  // passa a falhar — troque it.fails por it.
  it.fails("BUG-QA-001: tentativa barrada por rate limit fica registrada na auditoria", async () => {
    await setSetting("rate_limit_per_minute", 1);
    await submit(op, undefined, payload(FAKE_CPF[0]));
    expect(await errorCode(submit(op, undefined, payload(FAKE_CPF[1])))).toBe("RATE_LIMITED");
    expect(await count("public.audit_logs where action = 'request.rate_limited'")).toBe(1);
  });
});

describe("D3 — replay da chave de idempotência", () => {
  it("mesma chave com payload diferente não sobrescreve os dados guardados", async () => {
    const key = crypto.randomUUID();
    const a = await submit(op, key, payload(FAKE_CPF[0]));
    const b = await submit(op, key, payload(FAKE_CPF[1], { nome_teste: "Outro Nome" }));
    expect(b).toMatchObject({ request_id: a.request_id, duplicate: true });
    expect(await count("public.clients_temp")).toBe(1);
    const pii = await one<{ payload: { documento: string } }>("select payload from public.clients_temp");
    expect(pii.payload.documento).toBe(FAKE_CPF[0]);
  });

  it("replay depois da conclusão não recria dados pessoais nem nova solicitação", async () => {
    const key = crypto.randomUUID();
    await submit(op, key);
    await asBo((tx) => rpc(tx, "public.acknowledge_received_requests()"));
    const job = await asBo((tx) => rpc<{ job_id: string }>(tx, "public.claim_next_job('pc')"));
    await asBo((tx) => rpc(tx, "public.mark_job_running($1)", [job.job_id]));
    await asBo((tx) => rpc(tx, "public.complete_job($1, 'ADE-9')", [job.job_id]));
    const again = await submit(op, key);
    expect(again).toMatchObject({ status: "completed", duplicate: true });
    expect(await count("public.clients_temp")).toBe(0);
    expect(await count("public.proposal_requests")).toBe(1);
  });

  it("replay depois do cancelamento devolve o estado cancelado sem regravar dados", async () => {
    const key = crypto.randomUUID();
    const r = await submit(op, key);
    await as(db, { sub: op }, (tx) => rpc(tx, "public.cancel_proposal_request($1)", [r.request_id]));
    expect(await submit(op, key)).toMatchObject({ status: "cancelled", duplicate: true });
    expect(await count("public.clients_temp")).toBe(0);
  });

  it("chave ausente é recusada", async () => {
    expect(await errorCode(submit(op, null))).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});

describe("D3 — entrada hostil", () => {
  it("texto com SQL e HTML é guardado como dado, sem efeito no banco", async () => {
    const evil = ["Robert'); drop table public.proposal_requests;--", "<img src=x onerror=alert(1)>"];
    for (const [i, nome] of evil.entries()) {
      await submit(op, undefined, payload(FAKE_CPF[i], { nome_teste: nome }));
    }
    expect(await count("public.proposal_requests")).toBe(2);
    const stored = (await db.query<{ n: string }>("select payload->>'nome_teste' n from public.clients_temp order by created_at")).rows;
    expect(stored.map((r) => r.n).sort()).toEqual([...evil].sort());
  });

  it("payload acima do limite é recusado antes de gravar", async () => {
    await setSetting("payload_max_bytes", 256);
    expect(await errorCode(submit(op, undefined, payload(FAKE_CPF[0], { lixo: "x".repeat(400) }))))
      .toBe("PAYLOAD_TOO_LARGE");
    expect(await count("public.clients_temp")).toBe(0);
  });

  it("payload que não é objeto é recusado", async () => {
    const err = await submit(op, undefined, JSON.stringify([1, 2])).catch((e: { message: string; detail: string }) => e);
    expect((err as { message: string }).message).toBe("PAYLOAD_INVALID");
    expect(JSON.parse((err as { detail: string }).detail)).toEqual([{ field: null, code: "NOT_AN_OBJECT" }]);
  });

  it("motivo de cancelamento gigante é truncado", async () => {
    const r = await submit(op);
    await as(db, { sub: op }, (tx) => rpc(tx, "public.cancel_proposal_request($1, $2)", [r.request_id, "a".repeat(10_000)]));
    expect((await one<{ n: number }>("select char_length(status_reason)::int n from public.proposal_requests")).n).toBe(500);
  });
});
