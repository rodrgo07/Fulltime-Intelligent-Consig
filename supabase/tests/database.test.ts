import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { activateTestForm, applyMigrations, as, createMember, errorCode, FAKE_CPF, freshDb, rpc } from "./harness/db";

let db: PGlite;
let op: string;
let op2: string;
let bo: string;
let admin: string;

const payload = (cpf = FAKE_CPF[0], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ documento: cpf, nome_teste: "Cliente Fictício", valor_teste: 1500.5, ...extra });

const submit = (uid: string, key = crypto.randomUUID(), body = payload(), owner: string | null = null) =>
  as(db, { sub: uid }, (tx) =>
    rpc<{ request_id: string; public_ref: string; status: string; duplicate: boolean }>(
      tx, "public.submit_proposal_request($1, 1, $2::jsonb, $3)", [key, body, owner]));

const asBo = <T>(fn: Parameters<typeof as<T>>[2]) => as(db, { sub: bo, aal: "aal2" }, fn);

async function claimRunning() {
  await asBo((tx) => rpc(tx, "public.acknowledge_received_requests()"));
  const job = await asBo((tx) => rpc<{ job_id: string; request_id: string; payload: Record<string, unknown> }>(
    tx, "public.claim_next_job('pc-backoffice', '0.1.0')"));
  await asBo((tx) => rpc(tx, "public.mark_job_running($1)", [job.job_id]));
  return job;
}

const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

beforeEach(async () => {
  db = await freshDb();
  await activateTestForm(db);
  op = await createMember(db, "operator");
  op2 = await createMember(db, "operator");
  bo = await createMember(db, "backoffice");
  admin = await createMember(db, "admin");
}, 30_000);

describe("envio de solicitações (portal)", () => {
  it("grava metadados em proposal_requests e dados pessoais só em clients_temp", async () => {
    const r = await submit(op);
    expect(r.status).toBe("received");
    expect(r.public_ref).toMatch(/^FIC-\d{6}-[0-9A-F]{8}$/);
    const req = await one<{ submitted_by: string; owner_operator_id: string }>(
      "select * from public.proposal_requests where id = $1", [r.request_id]);
    expect(req.submitted_by).toBe(op);
    expect(req.owner_operator_id).toBe(op);
    expect(JSON.stringify(req)).not.toContain(FAKE_CPF[0]);
    const pii = await one<{ payload: { documento: string } }>("select payload from public.clients_temp");
    expect(pii.payload.documento).toBe(FAKE_CPF[0]);
  });

  it("mesma chave de idempotência não duplica (replay/retry)", async () => {
    const key = crypto.randomUUID();
    const a = await submit(op, key);
    const b = await submit(op, key);
    expect(b.duplicate).toBe(true);
    expect(b.request_id).toBe(a.request_id);
    expect((await one<{ n: number }>("select count(*)::int n from public.proposal_requests")).n).toBe(1);
  });

  it("mesmo cliente com outra chave enquanto em andamento é recusado", async () => {
    await submit(op);
    expect(await errorCode(submit(op))).toBe("DUPLICATE_REQUEST");
  });

  it("valida o payload no backend contra o formulário ativo", async () => {
    const err = await submit(op, undefined, JSON.stringify({ documento: "12345678900", campo_extra: 1 }))
      .catch((e: Error & { detail?: string }) => e);
    expect((err as Error).message).toBe("PAYLOAD_INVALID");
    const detail = JSON.parse((err as { detail: string }).detail) as { field: string; code: string }[];
    expect(detail).toEqual(expect.arrayContaining([
      { field: "documento", code: "INVALID_CPF" },
      { field: "nome_teste", code: "REQUIRED" },
      { field: "campo_extra", code: "UNKNOWN_FIELD" },
    ]));
  });

  it("valida tipos: data, opção e limites", async () => {
    const bad = payload(FAKE_CPF[0], { data_teste: "2026-02-30", opcao_teste: "z", valor_teste: 0 });
    const err = await submit(op, undefined, bad).catch((e: { detail: string }) => JSON.parse(e.detail));
    expect(err).toEqual(expect.arrayContaining([
      { field: "data_teste", code: "INVALID_DATE" },
      { field: "opcao_teste", code: "INVALID_OPTION" },
      { field: "valor_teste", code: "BELOW_MIN" },
    ]));
  });

  it("recusa envio sem formulário ativo", async () => {
    await db.query("update public.form_definitions set active = false");
    expect(await errorCode(submit(op))).toBe("FORM_NOT_CONFIGURED");
  });

  it("proprietário diferente do remetente ainda não é permitido", async () => {
    expect(await errorCode(submit(op, undefined, payload(), op2))).toBe("OWNER_NOT_ALLOWED");
  });

  it("aplica rate limit por operador", async () => {
    await db.query("update public.app_settings set value = '2' where key = 'rate_limit_per_minute'");
    await submit(op, undefined, payload(FAKE_CPF[0]));
    await submit(op, undefined, payload(FAKE_CPF[1]));
    expect(await errorCode(submit(op, undefined, payload(FAKE_CPF[0], { nome_teste: "Outro" })))).toBe("RATE_LIMITED");
  });

  it("operador inativo e anônimo não enviam", async () => {
    const inactive = await createMember(db, "operator", false);
    expect(await errorCode(submit(inactive))).toBe("FORBIDDEN");
    expect(await errorCode(as(db, { role: "anon" }, (tx) =>
      rpc(tx, "public.submit_proposal_request($1, 1, '{}'::jsonb)", [crypto.randomUUID()]))))
      .toMatch(/permission denied/);
  });

  it("operador cancela antes do processamento e os dados pessoais são apagados", async () => {
    const r = await submit(op);
    await as(db, { sub: op }, (tx) => rpc(tx, "public.cancel_proposal_request($1, 'teste')", [r.request_id]));
    expect((await one<{ status: string }>("select status from public.proposal_requests")).status).toBe("cancelled");
    expect((await one<{ n: number }>("select count(*)::int n from public.clients_temp")).n).toBe(0);
  });
});

describe("isolamento e privilégios", () => {
  it("operador não vê solicitações de outro operador nem dados pessoais", async () => {
    await submit(op);
    const seen = await as(db, { sub: op2 }, (tx) => tx.query("select * from public.proposal_requests"));
    expect(seen.rows).toHaveLength(0);
    const own = await as(db, { sub: op }, (tx) => tx.query("select * from public.proposal_requests"));
    expect(own.rows).toHaveLength(1);
    expect(await errorCode(as(db, { sub: op }, (tx) => tx.query("select * from public.clients_temp"))))
      .toMatch(/permission denied/);
  });

  it("não há escrita direta nas tabelas pela API", async () => {
    expect(await errorCode(as(db, { sub: op }, (tx) =>
      tx.query("update public.proposal_requests set status = 'completed'")))).toMatch(/permission denied/);
    expect(await errorCode(as(db, { sub: admin, aal: "aal2" }, (tx) =>
      tx.query("insert into public.audit_logs (action) values ('x.y.z')")))).toMatch(/permission denied/);
  });

  it("operador não executa funções do backoffice nem de serviço", async () => {
    expect(await errorCode(as(db, { sub: op }, (tx) => rpc(tx, "public.claim_next_job('x')")))).toBe("FORBIDDEN");
    expect(await errorCode(as(db, { sub: op }, (tx) =>
      rpc(tx, "public.svc_register_member(gen_random_uuid(), 'admin', 'x')"))))
      .toMatch(/permission denied/);
  });

  it("backoffice e admin exigem MFA (aal2)", async () => {
    expect(await errorCode(as(db, { sub: bo, aal: "aal1" }, (tx) => rpc(tx, "public.claim_next_job('x')"))))
      .toBe("MFA_REQUIRED");
    expect(await errorCode(as(db, { sub: admin, aal: "aal1" }, (tx) =>
      rpc(tx, "public.admin_set_member_active($1, false)", [op])))).toBe("MFA_REQUIRED");
  });

  it("backoffice não é admin", async () => {
    expect(await errorCode(asBo((tx) => rpc(tx, "public.admin_set_member_active($1, false)", [op]))))
      .toBe("FORBIDDEN");
  });

  it("admin desativa membro: sessões revogadas e acesso barrado", async () => {
    await db.query("insert into auth.sessions (user_id) values ($1)", [op]);
    await as(db, { sub: admin, aal: "aal2" }, (tx) => rpc(tx, "public.admin_set_member_active($1, false)", [op]));
    expect((await one<{ n: number }>("select count(*)::int n from auth.sessions")).n).toBe(0);
    expect(await errorCode(submit(op))).toBe("FORBIDDEN");
  });

  it("nenhuma função é executável por anon e toda security definer fixa search_path", async () => {
    const anonExec = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute')`);
    expect(anonExec.rows.map((r) => r.proname)).toEqual([]);
    const unsafe = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.prosecdef
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    expect(unsafe.rows).toEqual([]);
  });

  it("chave de servidor (service_role) escreve direto passando pelas validações; anon segue sem acesso a private", async () => {
    const fields = JSON.stringify([{ key: "campo_teste", label: "Campo", type: "text" }]);
    await as(db, { role: "service_role" }, (tx) =>
      tx.query("insert into public.form_definitions (version, title, fields) values (8, 'Homologação fictícia', $1)", [fields]));
    expect(await errorCode(as(db, { role: "service_role" }, (tx) =>
      tx.query("insert into public.form_definitions (version, title, fields) values (7, 'x', $1)",
        [JSON.stringify([{ key: "A", label: "", type: "foo" }])])))).toBe("FORM_DEFINITION_INVALID");
    const usage = await one<{ anon: boolean; svc: boolean }>(
      "select has_schema_privilege('anon', 'private', 'usage') anon, has_schema_privilege('service_role', 'private', 'usage') svc");
    expect(usage).toEqual({ anon: false, svc: true });
  });

  it("definição de formulário inválida é recusada", async () => {
    expect(await errorCode(db.query(
      "insert into public.form_definitions (version, title, fields) values (9, 'x', $1)",
      [JSON.stringify([{ key: "A", label: "", type: "foo" }])]))).toBe("FORM_DEFINITION_INVALID");
  });
});

describe("cadastro sem e-mail (0007)", () => {
  it("svc_register_member tem 3 argumentos, só service_role executa e o operador não tem e-mail próprio", async () => {
    const sig = await db.query<{ args: string }>(`
      select pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'svc_register_member'`);
    expect(sig.rows.map((r) => r.args)).toEqual(["p_user_id uuid, p_role app_role, p_display_name text"]);
    const priv = await one<{ svc: boolean; auth: boolean }>(`select
      has_function_privilege('service_role', 'public.svc_register_member(uuid, public.app_role, text)', 'execute') svc,
      has_function_privilege('authenticated', 'public.svc_register_member(uuid, public.app_role, text)', 'execute') auth`);
    expect(priv).toEqual({ svc: true, auth: false });
    const col = await one<{ c: number }>(`select count(*)::int c from information_schema.columns
      where table_schema = 'public' and table_name = 'operators' and column_name = 'notification_email'`);
    expect(col.c).toBe(0);
    expect((await one<{ f: string | null }>("select to_regprocedure('public.assert_admin()')::text f")).f).toBeNull();
    // Recadastro é idempotente e mantém o código do operador.
    const code = (await one<{ c: string }>("select operator_code c from public.operators where id = $1", [op])).c;
    const again = await one<{ r: { operator_code: string } }>(
      "select public.svc_register_member($1, 'operator', 'Outro Nome') r", [op]);
    expect(again.r.operator_code).toBe(code);
    expect((await one<{ action: string; details: { role: string } }>(
      "select action, details from public.audit_logs where action = 'member.registered' order by id desc limit 1")).details.role)
      .toBe("operator");
  });

  it("perfil já existente antes da 0007 fica com must_change_password = false; cadastro novo nasce true", async () => {
    const old = await freshDb({ before: "20261114000007" });
    const id = crypto.randomUUID();
    await old.query("insert into auth.users (id, email) values ($1, 'antigo@exemplo.test')", [id]);
    await old.query("select public.svc_register_member($1, 'admin', 'Admin Antigo', 'antigo@exemplo.test', null)", [id]);
    await applyMigrations(old, { from: "20261114000007" });
    expect((await old.query<{ m: boolean }>("select must_change_password m from public.profiles where id = $1", [id])).rows[0].m)
      .toBe(false);
    const fresh = crypto.randomUUID();
    await old.query("insert into auth.users (id, email) values ($1, 'novo@exemplo.test')", [fresh]);
    await old.query("select public.svc_register_member($1, 'operator', 'Operador Novo')", [fresh]);
    expect((await old.query<{ m: boolean }>("select must_change_password m from public.profiles where id = $1", [fresh])).rows[0].m)
      .toBe(true);
    await old.close();
  });

  it("mark_password_changed baixa só a flag do próprio usuário e audita", async () => {
    const flag = async (id: string) =>
      (await one<{ m: boolean }>("select must_change_password m from public.profiles where id = $1", [id])).m;
    expect(await flag(op)).toBe(true);
    expect(await flag(op2)).toBe(true);
    await as(db, { sub: op }, (tx) => rpc(tx, "public.mark_password_changed()"));
    expect(await flag(op)).toBe(false);
    expect(await flag(op2)).toBe(true);
    // Repetir não gera novo registro de auditoria.
    await as(db, { sub: op }, (tx) => rpc(tx, "public.mark_password_changed()"));
    expect((await one<{ n: number }>(
      "select count(*)::int n from public.audit_logs where action = 'member.password_changed' and actor_id = $1", [op])).n).toBe(1);
    // O próprio usuário lê a flag (RLS do próprio perfil).
    const own = await as(db, { sub: op2 }, (tx) => tx.query<{ must_change_password: boolean }>(
      "select must_change_password from public.profiles where id = $1", [op2]));
    expect(own.rows[0].must_change_password).toBe(true);
  });

  it("mark_password_changed exige usuário autenticado", async () => {
    expect(await errorCode(as(db, {}, (tx) => rpc(tx, "public.mark_password_changed()")))).toBe("UNAUTHENTICATED");
    expect(await errorCode(as(db, { role: "anon" }, (tx) => rpc(tx, "public.mark_password_changed()"))))
      .toMatch(/permission denied/);
  });
});

describe("fila e execução centralizada", () => {
  it("fluxo completo: resultado gravado e dados pessoais apagados atomicamente", async () => {
    const r = await submit(op);
    const job = await claimRunning();
    expect(job.request_id).toBe(r.request_id);
    expect(job.payload.documento).toBe(FAKE_CPF[0]);

    await asBo((tx) => rpc(tx, "public.complete_job($1, 'ADE-TESTE-001', 'OP-EXT-1', 'GERADA')", [job.job_id]));

    const req = await one<{ status: string; pii_purged_at: string; completed_at: string; payload_fingerprint: string }>(
      "select * from public.proposal_requests");
    expect(req.status).toBe("completed");
    expect(req.pii_purged_at).not.toBeNull();
    expect(req.completed_at).not.toBeNull();
    expect(req.payload_fingerprint).toBeNull();
    expect((await one<{ n: number }>("select count(*)::int n from public.clients_temp")).n).toBe(0);
    expect((await one<{ adhesion_number: string }>("select * from public.proposal_results")).adhesion_number)
      .toBe("ADE-TESTE-001");
    // O operador vê o resultado pelo portal (RLS); não há mais fila de e-mail.
    const seen = await as(db, { sub: op }, (tx) => tx.query<{ adhesion_number: string }>("select * from public.proposal_results"));
    expect(seen.rows.map((x) => x.adhesion_number)).toEqual(["ADE-TESTE-001"]);

    const again = await asBo((tx) => rpc<{ duplicate: boolean }>(tx, "public.complete_job($1, 'ADE-TESTE-001')", [job.job_id]));
    expect(again.duplicate).toBe(true);
    expect((await one<{ n: number }>("select count(*)::int n from public.proposal_results")).n).toBe(1);
  });

  it("número de adesão vazio não conclui nem apaga dados", async () => {
    await submit(op);
    const job = await claimRunning();
    expect(await errorCode(asBo((tx) => rpc(tx, "public.complete_job($1, '  ')", [job.job_id]))))
      .toBe("ADHESION_NUMBER_REQUIRED");
    expect((await one<{ n: number }>("select count(*)::int n from public.clients_temp")).n).toBe(1);
  });

  it("apenas uma proposta ocupa a sessão do Consig por vez (FIFO)", async () => {
    const first = await submit(op, undefined, payload(FAKE_CPF[0]));
    await submit(op2, undefined, payload(FAKE_CPF[1]));
    const job = await claimRunning();
    expect(job.request_id).toBe(first.request_id);
    expect(await asBo((tx) => rpc(tx, "public.claim_next_job('pc-backoffice')"))).toBeNull();
  });

  it("solicitação não reconhecida pelo backoffice não é reservada", async () => {
    await submit(op);
    expect(await asBo((tx) => rpc(tx, "public.claim_next_job('pc')"))).toBeNull();
  });

  it("falha recuperável volta para a fila até o limite de tentativas", async () => {
    await submit(op);
    for (let i = 1; i <= 3; i++) {
      const job = await claimRunning();
      const res = await asBo((tx) => rpc<{ status: string }>(
        tx, "public.fail_job($1, 'TIMEOUT', 'tempo excedido', true)", [job.job_id]));
      expect(res.status).toBe(i < 3 ? "queued" : "failed");
    }
    // PII continua disponível para reprocessamento manual até expirar.
    expect((await one<{ n: number }>("select count(*)::int n from public.clients_temp")).n).toBe(1);
  });

  it("falha após etapa com efeito no Consig exige confirmação humana (nunca repete sozinho)", async () => {
    await submit(op);
    const job = await claimRunning();
    await asBo((tx) => rpc(tx, "public.mark_side_effect_started($1, 'enviar_proposta')", [job.job_id]));
    const res = await asBo((tx) => rpc<{ status: string }>(
      tx, "public.fail_job($1, 'UNEXPECTED_SCREEN', null, true)", [job.job_id]));
    expect(res.status).toBe("awaiting_confirmation");
    expect(await asBo((tx) => rpc(tx, "public.claim_next_job('pc')"))).toBeNull();

    await asBo((tx) => rpc(tx,
      "public.resolve_awaiting_request($1, 'completed', 'ADE-MANUAL-9', 'GERADA', 'conferido no Consig')",
      [job.request_id]));
    const result = await one<{ source: string; confirmed_by: string }>("select * from public.proposal_results");
    expect(result.source).toBe("manual");
    expect(result.confirmed_by).toBe(bo);
    expect((await one<{ n: number }>("select count(*)::int n from public.clients_temp")).n).toBe(0);
  });

  it("release_job é recusado após efeito iniciado", async () => {
    await submit(op);
    const job = await claimRunning();
    await asBo((tx) => rpc(tx, "public.mark_side_effect_started($1, 'enviar')", [job.job_id]));
    expect(await errorCode(asBo((tx) => rpc(tx, "public.release_job($1, 'SESSION_EXPIRED')", [job.job_id]))))
      .toBe("SIDE_EFFECT_STARTED");
  });

  it("reserva expirada: sem efeito volta à fila; com efeito vai para confirmação", async () => {
    await submit(op, undefined, payload(FAKE_CPF[0]));
    const job = await claimRunning();
    await db.query("update public.automation_jobs set lease_expires_at = now() - interval '1 second'");
    await db.query("select private.recover_stale_jobs()");
    expect((await one<{ status: string }>("select status from public.proposal_requests")).status).toBe("queued");

    const job2 = await asBo((tx) => rpc<{ job_id: string }>(tx, "public.claim_next_job('pc')"));
    await asBo((tx) => rpc(tx, "public.mark_job_running($1)", [job2.job_id]));
    await asBo((tx) => rpc(tx, "public.mark_side_effect_started($1, 'enviar')", [job2.job_id]));
    await db.query("update public.automation_jobs set lease_expires_at = now() - interval '1 second' where id = $1", [job2.job_id]);
    await db.query("select private.recover_stale_jobs()");
    expect((await one<{ status: string }>("select status from public.proposal_requests")).status)
      .toBe("awaiting_confirmation");
    expect(job.job_id).not.toBe(job2.job_id);
  });

  it("transição de estado inválida é bloqueada no banco", async () => {
    await submit(op);
    expect(await errorCode(db.query("update public.proposal_requests set status = 'completed'")))
      .toBe("INVALID_TRANSITION");
  });
});

describe("retenção", () => {
  it("apaga dados pessoais vencidos e marca a solicitação como falha", async () => {
    await submit(op);
    await db.query("update public.proposal_requests set pii_expires_at = now() - interval '1 minute'");
    const out = await one<{ v: { pii_purged: number } }>("select private.run_retention() v");
    expect(out.v.pii_purged).toBe(1);
    const req = await one<{ status: string; status_reason: string }>("select * from public.proposal_requests");
    expect(req.status).toBe("failed");
    expect(req.status_reason).toBe("PII_EXPIRED");
    expect((await one<{ n: number }>("select count(*)::int n from public.clients_temp")).n).toBe(0);
    // Idempotente.
    expect((await one<{ v: { pii_purged: number } }>("select private.run_retention() v")).v.pii_purged).toBe(0);
  });

  it("não apaga dados de proposta em execução", async () => {
    await submit(op);
    await claimRunning();
    await db.query("update public.proposal_requests set pii_expires_at = now() - interval '1 minute'");
    await db.query("select private.run_retention()");
    expect((await one<{ n: number }>("select count(*)::int n from public.clients_temp")).n).toBe(1);
  });

  it("remove histórico e auditoria além do prazo", async () => {
    const r = await submit(op);
    await as(db, { sub: op }, (tx) => rpc(tx, "public.cancel_proposal_request($1)", [r.request_id]));
    await db.query("alter table public.proposal_requests disable trigger proposal_requests_touch");
    await db.query("update public.proposal_requests set updated_at = now() - interval '91 days'");
    await db.query("update public.audit_logs set occurred_at = now() - interval '91 days'");
    const out = await one<{ v: { requests_deleted: number; audit_deleted: number } }>("select private.run_retention() v");
    expect(out.v.requests_deleted).toBe(1);
    expect(out.v.audit_deleted).toBeGreaterThan(0);
  });
});

describe("sem e-mail de resultado (0006)", () => {
  it("fila, funções e configuração do envio não existem mais", async () => {
    const left = await one<{ q: string | null; t: string | null; fns: number; s: number }>(`
      select to_regclass('public.notification_queue')::text q, to_regtype('public.notification_status')::text t,
             (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname in ('public', 'private')
                 and p.proname in ('svc_claim_notifications', 'svc_finish_notification', 'invoke_notification_dispatch')) fns,
             (select count(*)::int from public.app_settings where key = 'notification_max_attempts') s`);
    expect(left).toEqual({ q: null, t: null, fns: 0, s: 0 });
  });

  it("recuperação de reservas segue funcionando sem a fila", async () => {
    await submit(op);
    const job = await claimRunning();
    await db.query("update public.automation_jobs set lease_expires_at = now() - interval '1 second' where id = $1", [job.job_id]);
    expect((await one<{ n: number }>("select private.recover_stale_jobs() n")).n).toBe(1);
    expect((await one<{ status: string }>("select status from public.proposal_requests")).status).toBe("queued");
  });
});

describe("diagnóstico", () => {
  it("storage_usage e presença do backoffice", async () => {
    await asBo((tx) => rpc(tx, "public.report_backoffice_heartbeat('0.1.0', 'production')"));
    const usage = await asBo((tx) => rpc<{ database_bytes: number; limit_bytes: number }>(tx, "public.storage_usage()"));
    expect(usage.database_bytes).toBeGreaterThan(0);
    expect(usage.limit_bytes).toBe(524288000);
    expect(await as(db, { sub: op }, (tx) => rpc(tx, "public.backoffice_presence()"))).not.toBeNull();
    expect(await errorCode(as(db, { sub: op }, (tx) => rpc(tx, "public.storage_usage()")))).toBe("FORBIDDEN");
  });
});
