// D3 — Troca de senha obrigatória (senha provisória): a trava tem de valer pela API direta, não só no portal.
// Visão de atacante: quem conhece a senha provisória (o admin, ou quem a interceptou) tenta usá-la.
// Complementa os testes do PR-B1 em database.test.ts. Dados 100% fictícios.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { activateTestForm, as, createMember, errorCode, FAKE_CPF, freshDb, rpc, type Claims } from "./harness/db";

let db: PGlite;
let op: string; // já trocou a senha
let bo: string; // já trocou a senha

const LOCKED = "PASSWORD_CHANGE_REQUIRED";
const ZERO = "00000000-0000-4000-8000-000000000000";
const payload = (cpf = FAKE_CPF[0]) => JSON.stringify({ documento: cpf, nome_teste: "Cliente Fictício", valor_teste: 1000 });
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const flag = async (id: string) =>
  (await one<{ m: boolean }>("select must_change_password m from public.profiles where id = $1", [id])).m;
const call = (claims: Claims, sql: string, params: unknown[] = []) => errorCode(as(db, claims, (tx) => rpc(tx, sql, params)));

// Todas as RPCs protegidas por papel (contrato v1). Argumentos fictícios: a trava vem antes de qualquer validação.
const RPCS: Record<"operator" | "backoffice" | "admin", string[]> = {
  operator: [
    `public.submit_proposal_request(gen_random_uuid(), 1, '${payload()}'::jsonb)`,
    `public.cancel_proposal_request('${ZERO}')`,
  ],
  backoffice: [
    "public.report_backoffice_heartbeat('0.1.0', 'production')",
    "public.acknowledge_received_requests()",
    "public.claim_next_job('pc-teste')",
    `public.mark_job_running('${ZERO}')`,
    `public.heartbeat_job('${ZERO}')`,
    `public.mark_side_effect_started('${ZERO}', 'x')`,
    `public.complete_job('${ZERO}', 'ADE-1')`,
    `public.fail_job('${ZERO}', 'X')`,
    `public.escalate_job('${ZERO}', 'X')`,
    `public.release_job('${ZERO}', 'X')`,
    `public.resolve_awaiting_request('${ZERO}', 'failed')`,
    `public.requeue_failed_request('${ZERO}')`,
    `public.cancel_request_backoffice('${ZERO}', 'x')`,
  ],
  admin: [`public.admin_set_member_active('${ZERO}', false)`],
};

beforeEach(async () => {
  db = await freshDb();
  await activateTestForm(db);
  op = await createMember(db, "operator");
  bo = await createMember(db, "backoffice");
}, 30_000);

describe("D3 — senha provisória pela API direta", () => {
  it.each(["operator", "backoffice", "admin"] as const)("%s com senha provisória: TODAS as RPCs do papel são recusadas", async (role) => {
    const id = await createMember(db, role, true, { mustChangePassword: true });
    const claims: Claims = { sub: id, aal: role === "operator" ? "aal1" : "aal2" };
    for (const sql of RPCS[role]) expect(await call(claims, sql), sql).toBe(LOCKED);
  });

  it("cadastro novo pelo SQL Editor (svc_register_member) já nasce travado", async () => {
    const id = crypto.randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, 'novo-qa@exemplo.test')", [id]);
    await db.query("select public.svc_register_member($1, 'operator', 'Operador Novo QA')", [id]);
    expect(await call({ sub: id }, RPCS.operator[0])).toBe(LOCKED);
  });

  it("a trava não é burlada por UPDATE direto no perfil, nem por claims forjadas no JWT", async () => {
    const id = await createMember(db, "operator", true, { mustChangePassword: true });
    expect(await errorCode(as(db, { sub: id }, (tx) =>
      tx.query("update public.profiles set must_change_password = false where id = $1", [id])))).toMatch(/permission denied/);
    const forged = { sub: id, must_change_password: false, user_metadata: { must_change_password: false } } as Claims;
    expect(await call(forged, RPCS.operator[0])).toBe(LOCKED);
    expect(await flag(id)).toBe(true);
  });

  it("usuário travado não destrava outro usuário", async () => {
    const a = await createMember(db, "operator", true, { mustChangePassword: true });
    const b = await createMember(db, "operator", true, { mustChangePassword: true });
    await as(db, { sub: a }, (tx) => rpc(tx, "public.mark_password_changed()"));
    expect(await flag(b)).toBe(true);
    expect(await call({ sub: b }, RPCS.operator[0])).toBe(LOCKED);
  });

  it("senha esquecida (runbook): o admin religa a flag e o MESMO JWT é travado na hora", async () => {
    expect(await call({ sub: op }, RPCS.operator[0])).toBe("NO_ERROR");
    await db.query("update public.profiles set must_change_password = true where id = $1", [op]);
    expect(await call({ sub: op }, `public.submit_proposal_request(gen_random_uuid(), 1, '${payload(FAKE_CPF[1])}'::jsonb)`))
      .toBe(LOCKED);
    expect(await call({ sub: bo, aal: "aal2" }, "public.claim_next_job('pc-teste')")).not.toBe(LOCKED); // não afeta outros
  });

  it("nada é gravado enquanto travado (envio recusado não deixa dados pessoais)", async () => {
    const id = await createMember(db, "operator", true, { mustChangePassword: true });
    await call({ sub: id }, RPCS.operator[0]);
    expect((await one<{ n: number }>("select count(*)::int n from public.clients_temp")).n).toBe(0);
    expect((await one<{ n: number }>("select count(*)::int n from public.proposal_requests")).n).toBe(0);
  });

  // BUG-QA-004 (alta): mark_password_changed() só baixa a flag; não confere se a senha mudou. Quem conhece a senha
  // provisória (o admin ou quem a interceptou) faz login, chama a RPC pela API e a trava some — a senha provisória
  // continua valendo e o dono legítimo nunca é obrigado a trocá-la. Sugestão: baixar a flag por trigger em
  // auth.users quando encrypted_password mudar (e apagar mark_password_changed). Este teste independe da correção:
  // passa quando a chamada sozinha não destrava. Quando corrigido, trocar it.fails por it.
  it.fails("BUG-QA-004: chamar mark_password_changed sem trocar a senha não destrava a API", async () => {
    const id = await createMember(db, "operator", true, { mustChangePassword: true });
    await call({ sub: id }, "public.mark_password_changed()"); // nenhuma mudança em auth.users
    expect(await call({ sub: id }, RPCS.operator[0])).toBe(LOCKED);
  });

  // BUG-QA-005 (média): a trava está só em require_role. Leituras pelo RLS (is_staff/has_role) e storage_usage
  // continuam liberadas: um backoffice/admin com senha provisória (com MFA cadastrado por quem tem a senha) lê
  // solicitações de todos os operadores, números de adesão, jobs e auditoria. Sugestão: current_app_role() ignorar
  // perfis com must_change_password (o próprio perfil continua legível por id = auth.uid()). Quando corrigido,
  // trocar it.fails por it.
  it.fails("BUG-QA-005: staff com senha provisória não lê dados de staff (RLS e storage_usage)", async () => {
    await as(db, { sub: op }, (tx) => rpc(tx, "public.submit_proposal_request(gen_random_uuid(), 1, $1::jsonb)", [payload()]));
    const id = await createMember(db, "backoffice", true, { mustChangePassword: true });
    const claims: Claims = { sub: id, aal: "aal2" };
    for (const t of ["proposal_requests", "automation_jobs", "proposal_results", "audit_logs", "profiles"]) {
      const rows = (await as(db, claims, (tx) => tx.query<{ id: string }>(`select * from public.${t}`))).rows;
      expect(rows.filter((r) => r.id !== id), t).toHaveLength(0);
    }
    expect(await call(claims, "public.storage_usage()")).not.toBe("NO_ERROR");
  });

  it("o próprio perfil continua legível com a trava (o portal precisa ler a flag)", async () => {
    const id = await createMember(db, "admin", true, { mustChangePassword: true });
    const own = await as(db, { sub: id, aal: "aal2" }, (tx) => tx.query<{ id: string; must_change_password: boolean }>(
      "select id, must_change_password from public.profiles where id = $1", [id]));
    expect(own.rows).toEqual([{ id, must_change_password: true }]);
  });
});
