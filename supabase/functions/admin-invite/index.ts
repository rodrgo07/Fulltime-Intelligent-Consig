// Convite de membros pelo portal (admin com MFA). Secrets: PORTAL_URL.
// A chave de servidor (sb_secret_ ou service_role legada) é usada apenas aqui dentro, para a API
// administrativa do Auth. verify_jwt = false (config.toml): o JWT do chamador é validado no código —
// PostgREST confere a assinatura em assert_admin e o Auth confirma o usuário em getUser.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { corsHeaders, json } from "../_shared/http.ts";
import { handleInvite } from "../_shared/invite.ts";
import { bearerJwt, publicKey, serverKey } from "../_shared/keys.ts";

const get = (k: string) => Deno.env.get(k);
const env = (k: string) => {
  const v = get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

Deno.serve(async (req) => {
  const portal = env("PORTAL_URL").replace(/\/$/, "");
  const cors = corsHeaders(req.headers.get("Origin"), portal);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json(405, { code: "METHOD_NOT_ALLOWED" }, cors);

  const token = bearerJwt(req.headers.get("Authorization"));
  const asCaller = createClient(env("SUPABASE_URL"), publicKey(get), {
    global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(env("SUPABASE_URL"), serverKey(get), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const body = await req.json().catch(() => null);
  const out = await handleInvite({
    callerToken: token,
    assertAdmin: async () => ({ error: (await asCaller.rpc("assert_admin")).error }),
    callerId: async () => (token ? (await asCaller.auth.getUser(token)).data.user?.id ?? null : null),
    inviteUser: async (email, redirectTo) => {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
      return { userId: data?.user?.id ?? null, error };
    },
    registerMember: (args) => admin.rpc("svc_register_member", args),
    redirectTo: `${portal}/definir-senha`,
  }, body);
  return json(out.status, out.body, cors);
});
