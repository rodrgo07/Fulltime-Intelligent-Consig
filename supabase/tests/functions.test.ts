import { describe, expect, it, vi } from "vitest";
import { buildCompletionEmail } from "../functions/_shared/email.ts";
import { sendWithResend } from "../functions/_shared/resend.ts";
import { dispatchNotifications } from "../functions/_shared/dispatch.ts";
import { handleInvite, parseInvite } from "../functions/_shared/invite.ts";
import { corsHeaders, safeEqual } from "../functions/_shared/http.ts";

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
      resendApiKey: "k",
      from: "nao-responda@exemplo.test",
      log: (msg, meta) => logs.push({ msg, ...meta }),
    });
    expect(out).toEqual({ processed: 1, sent: 0, failed: 1 });
    expect(calls[1]).toEqual(["svc_finish_notification", expect.objectContaining({ p_ok: false, p_retryable: true })]);
    expect(JSON.stringify(logs)).not.toContain("dono@exemplo.test");
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
