// D3 contra um projeto Supabase REAL (homologação). Pulado quando FIC_LIVE_URL não está definido.
//
//   FIC_LIVE_URL=https://<ref>.supabase.co  FIC_LIVE_ANON_KEY=<chave publishable/anon>   (só leitura/recusas)
//   FIC_LIVE_OP_A_EMAIL / FIC_LIVE_OP_A_PASSWORD, FIC_LIVE_OP_B_EMAIL / FIC_LIVE_OP_B_PASSWORD  (operadores de TESTE)
//   FIC_LIVE_EXPECT_NO_FORM=1   confirma FORM_NOT_CONFIGURED enquanto não há formulário (não grava nada)
//   FIC_LIVE_ALLOW_WRITES=1 FIC_LIVE_FORM_VERSION=<n> FIC_LIVE_PAYLOAD_JSON='{...}'   envia e cancela (só homologação,
//       com formulário de teste e payload FICTÍCIO). FIC_LIVE_RATE_LIMIT=1 FIC_LIVE_VARY_FIELD=<campo texto> testa o limite.
//
//   pnpm --filter @fic/supabase test:live
//
// Nunca use a service_role aqui, nem dados reais de cliente. Rode só contra homologação.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const env = process.env;
const URL_ = env.FIC_LIVE_URL?.replace(/\/$/, "");
const KEY = env.FIC_LIVE_ANON_KEY ?? "";
const HAS_OPS = !!(env.FIC_LIVE_OP_A_EMAIL && env.FIC_LIVE_OP_A_PASSWORD && env.FIC_LIVE_OP_B_EMAIL && env.FIC_LIVE_OP_B_PASSWORD);
const WRITES = env.FIC_LIVE_ALLOW_WRITES === "1" && !!env.FIC_LIVE_FORM_VERSION && !!env.FIC_LIVE_PAYLOAD_JSON;

if (URL_ && /^sb_secret_/.test(KEY)) throw new Error("FIC_LIVE_ANON_KEY não pode ser a chave secreta/service_role");

type Res = { status: number; ok: boolean; body: unknown };
async function call(path: string, init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const res = await fetch(`${URL_}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      apikey: KEY,
      "Content-Type": "application/json",
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* texto */ }
  return { status: res.status, ok: res.ok, body };
}
const rpc = (name: string, args: Record<string, unknown> = {}, token?: string) =>
  call(`/rest/v1/rpc/${name}`, { body: args, token });
const code = (r: Res) => (r.body as { message?: string; code?: string } | null)?.message ?? "";

async function login(email: string, password: string) {
  const r = await call("/auth/v1/token?grant_type=password", { body: { email, password } });
  if (!r.ok) throw new Error(`login de teste falhou (${r.status})`);
  return { token: (r.body as { access_token: string }).access_token, id: (r.body as { user: { id: string } }).user.id };
}

const ZERO = "00000000-0000-4000-8000-000000000000";
const TABLES = ["profiles", "operators", "form_definitions", "proposal_requests", "clients_temp", "automation_jobs",
  "proposal_results", "notification_queue", "audit_logs", "app_versions", "app_settings"];
const RPCS: [string, Record<string, unknown>][] = [
  ["submit_proposal_request", { p_idempotency_key: ZERO, p_form_version: 1, p_payload: {} }],
  ["cancel_proposal_request", { p_request_id: ZERO }],
  ["backoffice_presence", {}],
  ["acknowledge_received_requests", {}],
  ["claim_next_job", { p_worker_id: "qa-live" }],
  ["heartbeat_job", { p_job_id: ZERO }],
  ["mark_side_effect_started", { p_job_id: ZERO, p_step: "x" }],
  ["complete_job", { p_job_id: ZERO, p_adhesion_number: "x" }],
  ["fail_job", { p_job_id: ZERO, p_error_code: "x" }],
  ["resolve_awaiting_request", { p_request_id: ZERO, p_resolution: "failed" }],
  ["storage_usage", {}],
  ["admin_set_member_active", { p_profile_id: ZERO, p_active: false }],
  ["assert_admin", {}],
  ["svc_claim_notifications", { p_limit: 1 }],
  ["svc_finish_notification", { p_notification_id: ZERO, p_ok: true }],
  ["svc_register_member", { p_user_id: ZERO, p_role: "admin", p_display_name: "x", p_email: "x@exemplo.test", p_invited_by: null }],
];

describe.skipIf(!URL_)("D3 live — chamadas anônimas recusadas", () => {
  it.each(RPCS)("anon não executa %s", async (name, args) => {
    const r = await rpc(name, args);
    expect(r.ok, `${name} respondeu ${r.status}`).toBe(false);
    expect([401, 403]).toContain(r.status);
  });

  it.each(TABLES)("anon não lê %s", async (t) => {
    const r = await call(`/rest/v1/${t}?select=*&limit=1`);
    expect(r.ok ? (r.body as unknown[]).length : 0, `${t}: ${r.status}`).toBe(0);
  });

  it("schema private não é exposto pela API", async () => {
    const r = await call("/rest/v1/rpc/run_retention", { body: {}, headers: { "Content-Profile": "private" } });
    expect(r.ok).toBe(false);
  });

  it("Edge Functions recusam chamada sem JWT de admin / sem segredo do cron", async () => {
    const invite = await call("/functions/v1/admin-invite", { body: { email: "x@exemplo.test", display_name: "x", role: "operator" } });
    expect(invite.ok).toBe(false);
    const dispatch = await call("/functions/v1/dispatch-notifications", { body: {} });
    expect(dispatch.ok).toBe(false);
  });
});

describe.skipIf(!URL_ || !HAS_OPS)("D3 live — isolamento entre operadores (RLS real)", () => {
  let a: { token: string; id: string };
  let b: { token: string; id: string };
  const created: { token: string; id: string }[] = [];

  beforeAll(async () => {
    a = await login(env.FIC_LIVE_OP_A_EMAIL!, env.FIC_LIVE_OP_A_PASSWORD!);
    b = await login(env.FIC_LIVE_OP_B_EMAIL!, env.FIC_LIVE_OP_B_PASSWORD!);
  });

  afterAll(async () => {
    for (const c of created) await rpc("cancel_proposal_request", { p_request_id: c.id, p_reason: "qa-live" }, c.token);
  });

  it("operador vê só o próprio perfil e cadastro", async () => {
    for (const t of ["profiles", "operators"]) {
      const r = await call(`/rest/v1/${t}?select=id`, { token: b.token });
      expect((r.body as { id: string }[]).map((x) => x.id), t).toEqual([b.id]);
    }
  });

  it("operador não lê dados pessoais, jobs, fila de e-mail, auditoria nem configurações", async () => {
    for (const t of ["clients_temp", "automation_jobs", "notification_queue", "audit_logs", "app_settings", "app_versions"]) {
      const r = await call(`/rest/v1/${t}?select=*&limit=1`, { token: b.token });
      expect(r.ok ? (r.body as unknown[]).length : 0, `${t}: ${r.status}`).toBe(0);
    }
  });

  it("solicitações visíveis para B nunca são de A", async () => {
    const r = await call("/rest/v1/proposal_requests?select=id,submitted_by,owner_operator_id", { token: b.token });
    for (const row of r.body as { submitted_by: string; owner_operator_id: string }[]) {
      expect([row.submitted_by, row.owner_operator_id]).toContain(b.id);
    }
  });

  it("operador não executa funções de backoffice, admin nem de serviço", async () => {
    expect(code(await rpc("claim_next_job", { p_worker_id: "qa-live" }, b.token))).toBe("FORBIDDEN");
    expect(code(await rpc("storage_usage", {}, b.token))).toBe("FORBIDDEN");
    expect(code(await rpc("assert_admin", {}, b.token))).toBe("FORBIDDEN");
    expect((await rpc("svc_claim_notifications", { p_limit: 1 }, b.token)).ok).toBe(false);
  });

  it("cancelar solicitação inexistente/alheia responde NOT_FOUND", async () => {
    expect(code(await rpc("cancel_proposal_request", { p_request_id: ZERO }, b.token))).toBe("NOT_FOUND");
  });

  it.runIf(env.FIC_LIVE_EXPECT_NO_FORM === "1")("sem formulário publicado o envio é recusado sem gravar", async () => {
    const r = await rpc("submit_proposal_request",
      { p_idempotency_key: crypto.randomUUID(), p_form_version: 1, p_payload: { qa: "teste" } }, a.token);
    expect(code(r)).toBe("FORM_NOT_CONFIGURED");
  });

  describe.runIf(WRITES)("com escrita (homologação + formulário de teste)", () => {
    const version = Number(env.FIC_LIVE_FORM_VERSION);
    const payload = () => JSON.parse(env.FIC_LIVE_PAYLOAD_JSON!) as Record<string, unknown>;

    it("replay da chave devolve o mesmo registro; a chave de A usada por B não devolve o de A; B não cancela o de A", async () => {
      const key = crypto.randomUUID();
      const first = await rpc("submit_proposal_request", { p_idempotency_key: key, p_form_version: version, p_payload: payload() }, a.token);
      expect(first.ok, JSON.stringify(first.body)).toBe(true);
      const ra = first.body as { request_id: string; duplicate: boolean };
      created.push({ token: a.token, id: ra.request_id });
      const again = (await rpc("submit_proposal_request", { p_idempotency_key: key, p_form_version: version, p_payload: payload() }, a.token)).body;
      expect(again).toMatchObject({ request_id: ra.request_id, duplicate: true });

      expect(code(await rpc("cancel_proposal_request", { p_request_id: ra.request_id }, b.token))).toBe("NOT_FOUND");
      const seenByB = await call(`/rest/v1/proposal_requests?select=id&id=eq.${ra.request_id}`, { token: b.token });
      expect(seenByB.body).toEqual([]);

      const other = await rpc("submit_proposal_request", { p_idempotency_key: key, p_form_version: version, p_payload: payload() }, b.token);
      if (other.ok) {
        const rb = other.body as { request_id: string };
        created.push({ token: b.token, id: rb.request_id });
        expect(rb.request_id).not.toBe(ra.request_id);
      }
    });

    it.runIf(env.FIC_LIVE_RATE_LIMIT === "1" && !!env.FIC_LIVE_VARY_FIELD)("rate limit por minuto barra o excesso", async () => {
      let limited = false;
      for (let i = 0; i < 15 && !limited; i++) {
        const p = { ...payload(), [env.FIC_LIVE_VARY_FIELD!]: `qa-live-${Date.now()}-${i}` };
        const r = await rpc("submit_proposal_request", { p_idempotency_key: crypto.randomUUID(), p_form_version: version, p_payload: p }, a.token);
        if (r.ok) created.push({ token: a.token, id: (r.body as { request_id: string }).request_id });
        else limited = code(r) === "RATE_LIMITED";
      }
      expect(limited).toBe(true);
    });
  });
});
