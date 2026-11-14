import { describe, expect, it, vi } from "vitest";
import { buildCompletionEmail } from "../functions/_shared/email.ts";
import { sendWithResend } from "../functions/_shared/resend.ts";
import { dispatchNotifications } from "../functions/_shared/dispatch.ts";
import { handleInvite, parseInvite } from "../functions/_shared/invite.ts";
import { corsHeaders, safeEqual } from "../functions/_shared/http.ts";
import { bearerJwt, publicKey, serverKey } from "../functions/_shared/keys.ts";

const notice = {
  notification_id: "11111111-1111-4111-8111-111111111111",
  attempt: 1,
  recipient_email: "dono@exemplo.test",
  operation_ref: "FIC-261112-ABCDEF12",
  adhesion_number: "ADE<script>",
  result_status: "GERADA",
  completed_at: "2026-11-12T18:30:00Z",
};

describe("e-mail de conclusão", () => {
  it("contém só dados operacionais, com HTML escapado e horário de Brasília", () => {
    const m = buildCompletionEmail(notice);
    expect(m.subject).toContain("FIC-261112-ABCDEF12");
    expect(m.html).toContain("ADE&lt;script&gt;");
    expect(m.html).not.toContain("<script>");
    expect(m.text).toContain("12/11/2026");
    expect(m.text).toContain("15:30");
  });
});

describe("Resend", () => {
  it("envia com a chave de idempotência da notificação", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    const r = await sendWithResend(f, "k", { from: "a@x.test", to: "b@x.test", subject: "s", html: "h", text: "t" }, "idem-1");
    expect(r).toEqual({ ok: true, id: "re_1" });
    const init = f.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem-1");
  });

  it.each([[429, true], [500, true], [422, false], [401, false]])("HTTP %i → retryable %s", async (status, retryable) => {
    const f = vi.fn(async () => new Response("{}", { status }));
    const r = await sendWithResend(f, "k", { from: "", to: "", subject: "", html: "", text: "" }, "i");
    expect(r).toEqual({ ok: false, error: `HTTP ${status}`, retryable });
  });

  it("falha de rede é recuperável", async () => {
    const f = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const r = await sendWithResend(f, "k", { from: "", to: "", subject: "", html: "", text: "" }, "i");
    expect(r).toMatchObject({ ok: false, retryable: true });
  });
});

describe("dispatch", () => {
  it("finaliza cada notificação e não registra e-mail nos logs", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const logs: unknown[] = [];
    const out = await dispatchNotifications({
      rpc: async (fn, args) => {
        calls.push([fn, args]);
        return { data: fn === "svc_claim_notifications" ? [notice] : null, error: null };
      },
      fetch: async () => new Response("{}", { status: 503 }),
      mailConfig: () => ({ resendApiKey: "k", from: "nao-responda@exemplo.test" }),
      log: (msg, meta) => logs.push({ msg, ...meta }),
    });
    expect(out).toEqual({ processed: 1, sent: 0, failed: 1 });
    expect(calls[1]).toEqual(["svc_finish_notification", expect.objectContaining({ p_ok: false, p_retryable: true })]);
    expect(JSON.stringify(logs)).not.toContain("dono@exemplo.test");
  });
});

describe("dispatch com a fila vazia", () => {
  it("responde sem ler a configuração de e-mail (health check sem Resend)", async () => {
    const mailConfig = vi.fn(() => { throw new Error("missing env MAIL_FROM"); });
    const fetchFn = vi.fn();
    const out = await dispatchNotifications({
      rpc: async () => ({ data: [], error: null }), fetch: fetchFn, mailConfig, log: () => {},
    });
    expect(out).toEqual({ processed: 0, sent: 0, failed: 0 });
    expect(mailConfig).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("com notificação e sem configuração: falha antes de enviar ou finalizar (a reserva expira e volta)", async () => {
    const calls: string[] = [];
    await expect(dispatchNotifications({
      rpc: async (fn) => { calls.push(fn); return { data: fn === "svc_claim_notifications" ? [notice] : null, error: null }; },
      fetch: vi.fn(), mailConfig: () => { throw new Error("missing env MAIL_FROM"); }, log: () => {},
    })).rejects.toThrow("MAIL_FROM");
    expect(calls).toEqual(["svc_claim_notifications"]);
  });
});

describe("convite", () => {
  it("valida entrada estritamente", () => {
    expect(parseInvite({ email: "x", display_name: "", role: "root", extra: 1 })).toEqual({
      ok: false, errors: ["email", "display_name", "role", "unknown_fields"],
    });
    expect(parseInvite({ email: " A@B.TEST ", display_name: "Ana", role: "operator" }))
      .toEqual({ ok: true, value: { email: "a@b.test", display_name: "Ana", role: "operator" } });
  });

  const deps = (over = {}) => ({
    callerToken: "a.b.c",
    assertAdmin: async () => ({ error: null }),
    callerId: async () => "admin-id",
    inviteUser: async () => ({ userId: "new-id", error: null }),
    registerMember: vi.fn(async () => ({ data: { profile_id: "new-id" }, error: null })),
    redirectTo: "https://portal.exemplo.test/definir-senha",
    ...over,
  });

  it("não-admin recebe 403 e nada é convidado", async () => {
    const inviteUser = vi.fn();
    const out = await handleInvite(deps({ assertAdmin: async () => ({ error: { message: "MFA_REQUIRED" } }), inviteUser }),
      { email: "a@b.test", display_name: "A", role: "operator" });
    expect(out).toEqual({ status: 403, body: { code: "MFA_REQUIRED" } });
    expect(inviteUser).not.toHaveBeenCalled();
  });

  it("sem JWT do usuário → 401 e nada é consultado (verify_jwt desligado)", async () => {
    const assertAdmin = vi.fn();
    const inviteUser = vi.fn();
    const out = await handleInvite(deps({ callerToken: null, assertAdmin, inviteUser }),
      { email: "a@b.test", display_name: "A", role: "operator" });
    expect(out).toEqual({ status: 401, body: { code: "UNAUTHENTICATED" } });
    expect(assertAdmin).not.toHaveBeenCalled();
    expect(inviteUser).not.toHaveBeenCalled();
  });

  it.each(["JWT expired", "permission denied for function assert_admin", "UNAUTHENTICATED", ""])(
    "erro não estável do assert_admin (%s) → 401 sem repassar a mensagem", async (message) => {
      const inviteUser = vi.fn();
      const out = await handleInvite(deps({ assertAdmin: async () => ({ error: { message } }), inviteUser }),
        { email: "a@b.test", display_name: "A", role: "operator" });
      expect(out).toEqual({ status: 401, body: { code: "UNAUTHENTICATED" } });
      expect(inviteUser).not.toHaveBeenCalled();
    });

  it("usuário não confirmado pelo Auth → 401 e nada é convidado", async () => {
    const inviteUser = vi.fn();
    const out = await handleInvite(deps({ callerId: async () => null, inviteUser }),
      { email: "a@b.test", display_name: "A", role: "operator" });
    expect(out.status).toBe(401);
    expect(inviteUser).not.toHaveBeenCalled();
  });

  it("e-mail já cadastrado → 409", async () => {
    const out = await handleInvite(deps({ inviteUser: async () => ({ userId: null, error: { message: "User already registered" } }) }),
      { email: "a@b.test", display_name: "A", role: "operator" });
    expect(out.status).toBe(409);
  });

  it("sucesso registra o membro com quem convidou", async () => {
    const d = deps();
    const out = await handleInvite(d, { email: "a@b.test", display_name: "A", role: "backoffice" });
    expect(out.status).toBe(201);
    expect(d.registerMember).toHaveBeenCalledWith(expect.objectContaining({ p_role: "backoffice", p_invited_by: "admin-id" }));
  });
});

describe("http", () => {
  it("CORS só libera a origem do portal; segredo comparado com segurança", () => {
    expect(corsHeaders("https://evil.test", "https://portal.test")["Access-Control-Allow-Origin"]).toBe("null");
    expect(corsHeaders("https://portal.test", "https://portal.test")["Access-Control-Allow-Origin"]).toBe("https://portal.test");
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("", "")).toBe(false);
  });
});

describe("chaves de API (sb_publishable_/sb_secret_ e legadas)", () => {
  // Valores fictícios: só o formato importa.
  const envOf = (vars: Record<string, string>) => (k: string) => vars[k];

  it("prefere a chave nova nomeada default e cai na legada", () => {
    const both = envOf({
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_FAKE_default", outra: "sb_secret_FAKE_outra" }),
      SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role",
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_FAKE_default" }),
      SUPABASE_ANON_KEY: "legacy-anon",
    });
    expect(serverKey(both)).toBe("sb_secret_FAKE_default");
    expect(serverKey(both, "outra")).toBe("sb_secret_FAKE_outra");
    expect(publicKey(both)).toBe("sb_publishable_FAKE_default");
    const legacy = envOf({ SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role", SUPABASE_ANON_KEY: "legacy-anon" });
    expect(serverKey(legacy)).toBe("legacy-service-role");
    expect(publicKey(legacy)).toBe("legacy-anon");
  });

  it("JSON malformado ou sem default usa a legada; sem nenhuma, erro claro", () => {
    expect(serverKey(envOf({ SUPABASE_SECRET_KEYS: "{oops", SUPABASE_SERVICE_ROLE_KEY: "legacy" }))).toBe("legacy");
    expect(publicKey(envOf({ SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ x: "y" }), SUPABASE_ANON_KEY: "legacy" }))).toBe("legacy");
    expect(() => serverKey(envOf({}))).toThrow(/SUPABASE_SECRET_KEYS/);
    expect(() => publicKey(envOf({}))).toThrow(/SUPABASE_PUBLISHABLE_KEYS/);
  });

  it("só aceita JWT de usuário no Bearer; chaves de API não identificam ninguém", () => {
    expect(bearerJwt("Bearer aaa.bbb.ccc")).toBe("aaa.bbb.ccc");
    expect(bearerJwt("bearer aaa.bbb.ccc")).toBe("aaa.bbb.ccc");
    for (const h of [null, "", "Bearer", "Basic aaa.bbb.ccc", "Bearer sb_publishable_FAKE", "Bearer sb_secret_FAKE",
      "Bearer aaa.bbb", "Bearer aaa.bbb.", "Bearer aaa.bbb.ccc extra"]) {
      expect(bearerJwt(h)).toBeNull();
    }
  });

  it("CORS libera os cabeçalhos que o supabase-js envia (x-client-info)", () => {
    const allow = corsHeaders("https://portal.test", "https://portal.test")["Access-Control-Allow-Headers"];
    for (const h of ["authorization", "x-client-info", "apikey", "content-type"]) expect(allow).toContain(h);
  });
});
