// Chamada pelo pg_cron (via pg_net) somente quando há notificações vencidas.
// Secrets necessários: CRON_SECRET, RESEND_API_KEY, MAIL_FROM. SUPABASE_URL e
// SUPABASE_SERVICE_ROLE_KEY são injetados pelo próprio Supabase e nunca saem do servidor.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { dispatchNotifications } from "../_shared/dispatch.ts";
import { json, safeEqual } from "../_shared/http.ts";

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { code: "METHOD_NOT_ALLOWED" });
  if (!safeEqual(req.headers.get("x-cron-secret") ?? "", env("CRON_SECRET"))) {
    return json(401, { code: "UNAUTHORIZED" });
  }
  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const out = await dispatchNotifications({
      rpc: (fn, args) => sb.rpc(fn, args),
      fetch,
      resendApiKey: env("RESEND_API_KEY"),
      from: env("MAIL_FROM"),
      log: (msg, meta) => console.log(JSON.stringify({ level: "WARNING", msg, ...meta })),
    });
    return json(200, out);
  } catch (e) {
    console.error(JSON.stringify({ level: "ERROR", msg: "dispatch_failed", error: (e as Error).message }));
    return json(500, { code: "DISPATCH_FAILED" });
  }
});
