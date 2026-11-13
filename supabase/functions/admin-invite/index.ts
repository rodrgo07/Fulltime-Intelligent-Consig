// Convite de membros pelo portal (admin com MFA). Secrets: PORTAL_URL.
// A service_role é usada apenas aqui dentro, para a API administrativa do Auth.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { corsHeaders, json } from "../_shared/http.ts";
import { handleInvite } from "../_shared/invite.ts";

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

Deno.serve(async (req) => {
  const portal = env("PORTAL_URL").replace(/\/$/, "");
  const cors = corsHeaders(req.headers.get("Origin"), portal);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json(405, { code: "METHOD_NOT_ALLOWED" }, cors);

  const authHeader = req.headers.get("Authorization") ?? "";
  const asCaller = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const body = await req.json().catch(() => null);
  const out = await handleInvite({
    assertAdmin: async () => ({ error: (await asCaller.rpc("assert_admin")).error }),
    callerId: async () => (await asCaller.auth.getUser()).data.user?.id ?? null,
    inviteUser: async (email, redirectTo) => {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
      return { userId: data?.user?.id ?? null, error };
    },
    registerMember: (args) => admin.rpc("svc_register_member", args),
    redirectTo: `${portal}/definir-senha`,
  }, body);
  return json(out.status, out.body, cors);
});
