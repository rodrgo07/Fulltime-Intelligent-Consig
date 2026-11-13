// Convite de membros (operador, backoffice, admin). Só um admin com MFA pode convidar.

export type InviteInput = { email: string; display_name: string; role: "operator" | "backoffice" | "admin" };

export function parseInvite(body: unknown): { ok: true; value: InviteInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const b = (body ?? {}) as Record<string, unknown>;
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  const name = typeof b.display_name === "string" ? b.display_name.trim() : "";
  const role = b.role;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) errors.push("email");
  if (name.length < 1 || name.length > 120) errors.push("display_name");
  if (role !== "operator" && role !== "backoffice" && role !== "admin") errors.push("role");
  const extra = Object.keys(b).filter((k) => !["email", "display_name", "role"].includes(k));
  if (extra.length) errors.push("unknown_fields");
  return errors.length ? { ok: false, errors } : { ok: true, value: { email, display_name: name, role: role as InviteInput["role"] } };
}

type Err = { message: string } | null;
export type InviteDeps = {
  assertAdmin: () => Promise<{ error: Err }>;
  callerId: () => Promise<string | null>;
  inviteUser: (email: string, redirectTo: string) => Promise<{ userId: string | null; error: Err }>;
  registerMember: (args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: Err }>;
  redirectTo: string;
};

export async function handleInvite(deps: InviteDeps, body: unknown): Promise<{ status: number; body: unknown }> {
  const auth = await deps.assertAdmin();
  if (auth.error) return { status: 403, body: { code: auth.error.message || "FORBIDDEN" } };
  const parsed = parseInvite(body);
  if (!parsed.ok) return { status: 422, body: { code: "INVALID_INPUT", fields: parsed.errors } };
  const caller = await deps.callerId();
  const inv = await deps.inviteUser(parsed.value.email, deps.redirectTo);
  if (inv.error || !inv.userId) {
    const exists = /already|registered|exists/i.test(inv.error?.message ?? "");
    return { status: exists ? 409 : 502, body: { code: exists ? "ALREADY_REGISTERED" : "INVITE_FAILED" } };
  }
  const reg = await deps.registerMember({
    p_user_id: inv.userId,
    p_role: parsed.value.role,
    p_display_name: parsed.value.display_name,
    p_email: parsed.value.email,
    p_invited_by: caller,
  });
  if (reg.error) return { status: 500, body: { code: "REGISTER_FAILED" } };
  return { status: 201, body: reg.data };
}
