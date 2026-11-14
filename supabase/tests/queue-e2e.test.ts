// D2 — Fila ponta a ponta com o fluxo FALSO de teste:
// banco real (PGlite + migrations) ↔ modelo do worker do desktop ↔ processo REAL do motor Python.
// Nada aqui toca o Consig, o Supabase real ou dados reais. O fluxo falso fica em
// services/engine/tests/fake_engine.py e nunca é registrado em PRODUCTION_WORKFLOWS.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { activateTestForm, as, createMember, errorCode, FAKE_CPF, freshDb, rpc } from "./harness/db";
import { FakeDesktop, waitFor } from "./harness/desktop";
import { EngineProcess, prepareEngine } from "./harness/engine";

const ENGINE_READY = prepareEngine();
if (!ENGINE_READY && process.env.FIC_REQUIRE_E2E === "1") {
  throw new Error("FIC_REQUIRE_E2E=1, mas o uv não está disponível para iniciar o motor");
}

const FAKE_ADHESION = "ADE-FALSO-0001";
const CLIENT_NAME = "Cliente Fictício E2E";

let db: PGlite;
let op: string;
let bo: string;
let dirs: string[] = [];
let engines: EngineProcess[] = [];

const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const count = async (sql: string, params: unknown[] = []) => (await one<{ n: number }>(`select count(*)::int n from ${sql}`, params)).n;
const reqStatus = async (id: string) =>
  one<{ status: string; status_reason: string | null; pii_purged_at: Date | null }>(
    "select status, status_reason, pii_purged_at from public.proposal_requests where id = $1", [id]);

function submit(cpf = FAKE_CPF[0]) {
  return as(db, { sub: op }, (tx) => rpc<{ request_id: string; public_ref: string }>(tx,
    "public.submit_proposal_request($1, 1, $2::jsonb)",
    [crypto.randomUUID(), JSON.stringify({ documento: cpf, nome_teste: CLIENT_NAME, valor_teste: 1000 })]));
}

/** "Liga o PC do backoffice": motor real com o cenário falso + modelo do worker, na mesma pasta de dados. */
function boot(scenario: string, dataDir?: string) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "fic-d2-"));
  if (!dataDir) dirs.push(dir);
  const engine = new EngineProcess(dir, scenario);
  engines.push(engine);
  return { engine, desktop: new FakeDesktop(db, bo, engine, dir), dir };
}

/** Simula o relógio: a reserva do job venceu e o pg_cron rodou recover_stale_jobs. */
async function expireLeaseAndRecover() {
  await db.query("update public.automation_jobs set lease_expires_at = now() - interval '1 second' where status in ('leased', 'running')");
  return (await one<{ n: number }>("select private.recover_stale_jobs() n")).n;
}

const auditActions = async (requestId: string) =>
  (await db.query<{ action: string }>("select action from public.audit_logs where request_id = $1 order by occurred_at, id", [requestId]))
    .rows.map((r) => r.action);

beforeAll(() => {
  if (!ENGINE_READY) console.warn("D2: uv indisponível — testes ponta a ponta com o motor foram pulados");
});

beforeEach(async () => {
  db = await freshDb();
  await activateTestForm(db);
  op = await createMember(db, "operator");
  bo = await createMember(db, "backoffice");
}, 30_000);

afterEach(async () => {
  await Promise.all(engines.map((e) => e.stop()));
  engines = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
}, 30_000);

describe.skipIf(!ENGINE_READY)("D2 — fila ponta a ponta (fluxo falso)", { timeout: 90_000 }, () => {
  it("envio → reserva → execução → resultado no portal → exclusão dos dados pessoais", async () => {
    const r = await submit();
    const { engine, desktop } = boot("ok");
    expect(await desktop.cycle()).toBeNull();

    await waitFor(async () => (await reqStatus(r.request_id)).status === "completed", "solicitação concluída");
    await desktop.settle();

    const req = await reqStatus(r.request_id);
    expect(req.pii_purged_at).not.toBeNull();
    expect(await count("public.clients_temp")).toBe(0);
    const result = await one<{ adhesion_number: string; source: string; external_operation_id: string }>(
      "select * from public.proposal_results where request_id = $1", [r.request_id]);
    expect(result).toMatchObject({ adhesion_number: FAKE_ADHESION, source: "rpa", external_operation_id: "OP-FALSO-1" });
    const job = await one<{ status: string; side_effect_started_at: Date | null; current_step: string }>(
      "select * from public.automation_jobs where request_id = $1", [r.request_id]);
    expect(job.status).toBe("succeeded");
    expect(job.side_effect_started_at).not.toBeNull();
    expect(desktop.loadPending()).toEqual([]);

    // Trilha de auditoria completa, em ordem.
    expect(await auditActions(r.request_id)).toEqual([
      "request.received", "job.claimed", "job.running", "job.side_effect_started", "pii.purged", "request.completed",
    ]);

    // Aviso ao operador: só no portal (sem e-mail). É a mesma consulta da RequestsPage, filtrada pelo RLS.
    const seen = (await as(db, { sub: op }, (tx) => tx.query<{ public_ref: string; status: string; adhesion_number: string }>(
      `select r.public_ref, r.status, pr.adhesion_number
         from public.proposal_requests r left join public.proposal_results pr on pr.request_id = r.id`))).rows;
    expect(seen).toEqual([{ public_ref: r.public_ref, status: "completed", adhesion_number: FAKE_ADHESION }]);

    // LGPD: o dado pessoal nunca volta pelo canal do motor, nem aparece em log, arquivo local, auditoria ou portal.
    const leaks = [engine.allOutput(), JSON.stringify(desktop.loadPending()), JSON.stringify(seen),
      JSON.stringify((await db.query("select * from public.audit_logs")).rows)].join("\n");
    expect(leaks).not.toContain(FAKE_CPF[0]);
    expect(leaks).not.toContain(CLIENT_NAME);
  });

  it("falha antes do ponto sem retorno: volta para a fila e a 2ª tentativa conclui", async () => {
    const r = await submit();
    const { desktop } = boot("fail_first_attempt");
    await desktop.cycle();
    await waitFor(async () => (await reqStatus(r.request_id)).status === "queued", "re-enfileirada após falha");
    await desktop.settle();
    expect((await reqStatus(r.request_id)).status_reason).toBe("STEP_TIMEOUT");

    await desktop.cycle();
    await waitFor(async () => (await reqStatus(r.request_id)).status === "completed", "concluída na 2ª tentativa");
    const jobs = (await db.query<{ attempt: number; status: string; side_effect_started_at: Date | null; error_code: string | null }>(
      "select attempt, status, side_effect_started_at, error_code from public.automation_jobs order by attempt")).rows;
    expect(jobs).toMatchObject([
      { attempt: 1, status: "failed", side_effect_started_at: null, error_code: "STEP_TIMEOUT" },
      { attempt: 2, status: "succeeded" },
    ]);
    expect(await count("public.clients_temp")).toBe(0);
  });

  it("falha antes do ponto sem retorno em todas as tentativas: vira falha e os dados ficam para reprocesso manual", async () => {
    const r = await submit();
    const { desktop } = boot("fail_before");
    for (let i = 1; i <= 3; i++) {
      await desktop.cycle();
      await waitFor(async () => desktop.current === null && (await reqStatus(r.request_id)).status !== "running", `tentativa ${i}`);
      await desktop.settle();
    }
    expect((await reqStatus(r.request_id)).status).toBe("failed");
    expect(await count("public.automation_jobs where side_effect_started_at is not null")).toBe(0);
    expect(await count("public.clients_temp")).toBe(1);
    expect(await desktop.cycle()).toBe("QUEUE_EMPTY");
    await desktop.api("public.requeue_failed_request($1)", [r.request_id]);
    expect((await reqStatus(r.request_id)).status).toBe("queued");
  });

  it("falha depois do ponto sem retorno: aguarda confirmação humana e a fila não anda sozinha", async () => {
    const r = await submit(FAKE_CPF[0]);
    const { desktop } = boot("fail_after");
    await desktop.cycle();
    await waitFor(async () => (await reqStatus(r.request_id)).status === "awaiting_confirmation", "escalada");
    await desktop.settle();
    expect((await reqStatus(r.request_id)).status_reason).toBe("STEP_CRASHED");

    await submit(FAKE_CPF[1]); // outra solicitação na fila
    expect(await desktop.cycle()).toBe("QUEUE_EMPTY"); // sessão única: nada é reservado enquanto aguarda
    expect(await count("public.automation_jobs")).toBe(1);

    await desktop.api("public.resolve_awaiting_request($1, 'completed', 'ADE-MANUAL-FALSO', 'GERADA', 'conferido')", [r.request_id]);
    expect((await reqStatus(r.request_id)).status).toBe("completed");
    expect((await one<{ source: string }>("select source from public.proposal_results")).source).toBe("manual");
    expect(await count("public.clients_temp where request_id = $1", [r.request_id])).toBe(0);
  });

  it("queda de rede no ponto sem retorno: a etapa com efeito não roda e o job é recuperado", async () => {
    const r = await submit();
    const { desktop, engine } = boot("ok");
    desktop.beforeEvent = (ev) => {
      if (ev.type === "step_started" && ev.step === "falso_enviar") desktop.online = false;
    };
    await desktop.cycle();
    await waitFor(() => engine.stdout.some((l) => l.includes('"failed"')), "motor recusa a etapa sem confirmação");
    await desktop.settle();
    expect(engine.allOutput()).toContain("HOST_REJECTED_SIDE_EFFECT");
    expect(await count("public.automation_jobs where side_effect_started_at is not null")).toBe(0);
    expect((await reqStatus(r.request_id)).status).toBe("running"); // fail_job não chegou ao servidor

    desktop.online = true;
    expect(await expireLeaseAndRecover()).toBe(1);
    expect(await reqStatus(r.request_id)).toMatchObject({ status: "queued", status_reason: "LEASE_EXPIRED" });
  });

  it("queda do app antes do ponto sem retorno: reserva expira, volta à fila e outra execução conclui", async () => {
    const r = await submit();
    const first = boot("hang_before");
    await first.desktop.cycle();
    await waitFor(async () => (await reqStatus(r.request_id)).status === "running", "em execução");
    await first.engine.kill(); // PC desligado: ninguém reporta nada

    expect(await expireLeaseAndRecover()).toBe(1);
    expect(await reqStatus(r.request_id)).toMatchObject({ status: "queued", status_reason: "LEASE_EXPIRED" });

    const second = boot("ok", first.dir); // app reinicia na mesma pasta de dados
    await second.desktop.cycle();
    await waitFor(async () => (await reqStatus(r.request_id)).status === "completed", "concluída após reinício");
    const jobs = (await db.query<{ attempt: number; status: string; error_code: string | null }>(
      "select attempt, status, error_code from public.automation_jobs order by attempt")).rows;
    expect(jobs).toMatchObject([{ attempt: 1, status: "released", error_code: "LEASE_EXPIRED" }, { attempt: 2, status: "succeeded" }]);
  });

  it("queda do app depois do ponto sem retorno: reserva expira e vai para confirmação humana (sem repetir)", async () => {
    const r = await submit();
    const first = boot("hang_after");
    await first.desktop.cycle();
    await waitFor(async () => (await count("public.automation_jobs where side_effect_started_at is not null")) === 1, "efeito marcado");
    await first.engine.kill();

    await expireLeaseAndRecover();
    expect(await reqStatus(r.request_id)).toMatchObject({
      status: "awaiting_confirmation", status_reason: "LEASE_EXPIRED_AFTER_SIDE_EFFECT" });
    const second = boot("ok", first.dir);
    expect(await second.desktop.cycle()).toBe("QUEUE_EMPTY");
    expect(await count("public.clients_temp")).toBe(1); // dados mantidos para a conferência humana
  });

  it("queda de rede curta com resultado pendente: sobrevive ao reinício do app e é confirmado ao reconectar", async () => {
    const r = await submit();
    const first = boot("ok");
    first.desktop.beforeEvent = (ev) => {
      if (ev.type === "step_started" && ev.step === "falso_resultado") first.desktop.online = false;
    };
    await first.desktop.cycle();
    await waitFor(() => first.desktop.loadPending().length === 1, "resultado salvo localmente");
    await first.desktop.settle();
    expect((await reqStatus(r.request_id)).status).toBe("running");
    expect(first.desktop.loadPending()[0]).toMatchObject({ adhesion_number: FAKE_ADHESION });
    expect(JSON.stringify(first.desktop.loadPending())).not.toContain(FAKE_CPF[0]);

    // App fecha e reabre ainda sem rede: o resultado continua no disco e a fila fica bloqueada.
    await first.engine.stop();
    const second = boot("ok", first.dir);
    second.desktop.online = false;
    expect(await second.desktop.cycle()).toBe("NETWORK");
    expect(second.desktop.loadPending()).toHaveLength(1);

    second.desktop.online = true;
    expect(await second.desktop.cycle()).toBe("QUEUE_EMPTY");
    expect(second.desktop.loadPending()).toEqual([]);
    expect(await reqStatus(r.request_id)).toMatchObject({ status: "completed" });
    expect(await count("public.clients_temp")).toBe(0);

    // Reenvio do mesmo resultado (ex.: confirmação perdida) é idempotente.
    const job = await one<{ id: string }>("select id from public.automation_jobs");
    second.desktop.savePending([{ job_id: job.id, adhesion_number: FAKE_ADHESION, result_status: "GERADA", external_operation_id: null }]);
    expect(await second.desktop.flushPending()).toBe(0);
    expect(await count("public.proposal_results")).toBe(1);
    expect(await count("public.audit_logs where action = 'request.completed'")).toBe(1);
  });

  it("queda de rede maior que a reserva com resultado pendente: fica preso até a decisão humana (comportamento atual)", async () => {
    const r = await submit();
    const { desktop } = boot("ok");
    desktop.beforeEvent = (ev) => {
      if (ev.type === "step_started" && ev.step === "falso_resultado") desktop.online = false;
    };
    await desktop.cycle();
    await waitFor(() => desktop.loadPending().length === 1, "resultado salvo localmente");
    await desktop.settle();

    await expireLeaseAndRecover(); // pg_cron roda no servidor mesmo com o PC sem rede
    expect((await reqStatus(r.request_id)).status).toBe("awaiting_confirmation");

    desktop.online = true;
    expect(await desktop.cycle()).toBe("PENDING_RESULTS");
    const job = await one<{ id: string }>("select id from public.automation_jobs");
    expect(await errorCode(desktop.api("public.complete_job($1, $2)", [job.id, FAKE_ADHESION]))).toBe("JOB_NOT_ACTIVE");
    expect(desktop.loadPending()).toHaveLength(1);

    // Humano confere no Consig e informa o mesmo número: o pendente local é aceito como duplicado e libera a fila.
    await desktop.api("public.resolve_awaiting_request($1, 'completed', $2, 'GERADA', 'conferido')", [r.request_id, FAKE_ADHESION]);
    expect(await desktop.cycle()).toBe("QUEUE_EMPTY");
    expect(desktop.loadPending()).toEqual([]);
  });

  // BUG-QA-002: se o humano escolhe "requeue" (ou "failed") enquanto o desktop guarda o resultado RPA dessa
  // solicitação, complete_job responde JOB_NOT_ACTIVE para sempre: o item nunca sai de pending-results.json e o
  // worker fica bloqueado em PENDING_RESULTS indefinidamente — e a nova tentativa pode gerar proposta duplicada.
  it.fails("BUG-QA-002: resultado pendente não bloqueia a fila para sempre após decisão humana diferente de 'completed'", async () => {
    const r = await submit();
    const { desktop } = boot("ok");
    desktop.beforeEvent = (ev) => {
      if (ev.type === "step_started" && ev.step === "falso_resultado") desktop.online = false;
    };
    await desktop.cycle();
    await waitFor(() => desktop.loadPending().length === 1, "resultado salvo localmente");
    await desktop.settle();
    await expireLeaseAndRecover();
    desktop.online = true;
    await desktop.api("public.resolve_awaiting_request($1, 'failed', null, null, 'sem confirmação')", [r.request_id]);
    expect(await desktop.cycle()).not.toBe("PENDING_RESULTS");
  });
});
