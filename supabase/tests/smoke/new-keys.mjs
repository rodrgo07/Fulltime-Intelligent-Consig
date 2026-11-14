// Smoke test das chaves novas (sb_publishable_ / sb_secret_) num Supabase LOCAL completo.
// Cobre o que o PGlite não alcança: gateway, PostgREST, Auth (MFA), Realtime e Edge Functions reais.
//
//   supabase start && supabase functions serve --env-file <arquivo com PORTAL_URL, CRON_SECRET, RESEND_API_KEY, MAIL_FROM>
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SECRET_KEY=... CRON_SECRET=... \
//     PORTAL_URL=http://127.0.0.1:5174 pnpm --filter @fic/supabase smoke:local
//
// Só roda contra localhost: cria usuários e um formulário fictícios. Nenhum dado real.
// Não envia e-mail: o dispatch é chamado com a fila vazia.
import { createClient } from "@supabase/supabase-js";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`defina ${k}`);
  return v;
};
const URL_ = env("SUPABASE_URL").replace(/\/$/, "");
const PUB = env("SUPABASE_PUBLISHABLE_KEY");
const SEC = env("SUPABASE_SECRET_KEY");
const CRON = env("CRON_SECRET");
const PORTAL = env("PORTAL_URL");
if (!["127.0.0.1", "localhost"].includes(new URL(URL_).hostname)) throw new Error("somente Supabase local");
if (!PUB.startsWith("sb_publishable_") || !SEC.startsWith("sb_secret_")) throw new Error("use as chaves novas");

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(URL_, SEC, opts);

// ------------------------------------------------------------ helpers
function totp(base32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of base32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function member(role) {
  const email = `smoke-${role}-${randomUUID().slice(0, 8)}@exemplo.test`;
  const password = randomBytes(18).toString("base64url") + "aA1";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser: ${error.message}`);
  const reg = await admin.rpc("svc_register_member", {
    p_user_id: data.user.id, p_role: role, p_display_name: `Smoke ${role}`, p_email: email, p_invited_by: null,
  });
  check(`sb_secret_ executa svc_register_member (${role})`, !reg.error, reg.error?.message);
  const client = createClient(URL_, PUB, opts);
  const s = await client.auth.signInWithPassword({ email, password });
  if (s.error) throw new Error(`signIn: ${s.error.message}`);
  return { id: data.user.id, client, token: s.data.session.access_token };
}

async function withMfa(m) {
  const en = await m.client.auth.mfa.enroll({ factorType: "totp" });
  if (en.error) throw new Error(`enroll: ${en.error.message}`);
  const v = await m.client.auth.mfa.challengeAndVerify({ factorId: en.data.id, code: totp(en.data.totp.secret) });
  if (v.error) throw new Error(`mfa verify: ${v.error.message}`);
  m.token = (await m.client.auth.getSession()).data.session.access_token;
  return m;
}

function socket(token, onEvent) {
  // Igual ao desktop (apps/desktop/src-tauri/src/realtime.rs): apikey na URL, JWT no phx_join.
  const ws = new WebSocket(`${URL_.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(PUB)}&vsn=1.0.0`);
  // O phx_reply confirma o canal; a inscrição no Postgres é confirmada depois, por um evento "system".
  let subscribedResolve;
  const subscribed = new Promise((r) => { subscribedResolve = r; setTimeout(() => r("timeout"), 20000); });
  const joined = new Promise((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({
      topic: "realtime:fic-smoke", event: "phx_join", ref: "1",
      payload: { config: { postgres_changes: [{ event: "*", schema: "public", table: "proposal_requests" }] }, access_token: token },
    }));
    ws.onmessage = (m) => {
      const v = JSON.parse(String(m.data));
      if (v.event === "phx_reply" && v.ref === "1") resolve(v.payload?.status);
      if (v.event === "system" && v.payload?.extension === "postgres_changes") subscribedResolve(v.payload?.status);
      if (v.event === "postgres_changes") onEvent(v);
    };
    ws.onerror = () => resolve("socket_error");
    setTimeout(() => resolve("timeout"), 10000);
  });
  return { ws, joined, subscribed };
}

const fn = (name, { token, headers = {}, body = {}, method = "POST" } = {}) =>
  fetch(`${URL_}/functions/v1/${name}`, {
    method,
    headers: { apikey: PUB, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });

// ------------------------------------------------------------ RPC com publishable + JWT
const anon = createClient(URL_, PUB, opts);
const a = await anon.rpc("submit_proposal_request", { p_idempotency_key: randomUUID(), p_form_version: 1, p_payload: {} });
check("anônimo (só publishable) é recusado no RPC", !!a.error && a.error.code === "42501", a.error?.code);

const op = await member("operator");
const r0 = await op.client.rpc("submit_proposal_request", { p_idempotency_key: randomUUID(), p_form_version: 1, p_payload: {} });
check("operador (publishable + JWT) chega à regra de negócio", r0.error?.message === "FORM_NOT_CONFIGURED", r0.error?.message);

const bo = await withMfa(await member("backoffice"));
const presence = await bo.client.rpc("report_backoffice_heartbeat", { p_app_version: "0.0.0-smoke", p_channel: "development" });
check("backoffice aal2 executa RPC", !presence.error, presence.error?.message);

// ------------------------------------------------------------ Realtime (apikey publishable na URL)
await admin.from("form_definitions").delete().eq("title", "Smoke (fictício)");
const ver = 900 + Math.floor(Math.random() * 99);
await admin.from("form_definitions").update({ active: false }).eq("active", true);
const fd = await admin.from("form_definitions").insert({
  version: ver, title: "Smoke (fictício)", active: true,
  fields: [{ key: "nome_teste", label: "Nome", type: "text", required: true }],
});
check("sb_secret_ escreve como service_role", !fd.error, fd.error?.message);

let opEvents = 0;
let boEvents = 0;
const s1 = socket(op.token, () => opEvents++);
const s2 = socket(bo.token, () => boEvents++);
check("Realtime aceita sb_publishable_ + JWT do operador", (await s1.joined) === "ok");
check("Realtime aceita sb_publishable_ + JWT do backoffice (aal2)", (await s2.joined) === "ok");
check("inscrição postgres_changes confirmada (operador)", (await s1.subscribed) === "ok");
check("inscrição postgres_changes confirmada (backoffice)", (await s2.subscribed) === "ok");
const sub = await op.client.rpc("submit_proposal_request", {
  p_idempotency_key: randomUUID(), p_form_version: ver, p_payload: { nome_teste: "Pessoa Fictícia" },
});
check("envio do operador", !sub.error, sub.error?.message);
for (let i = 0; i < 60 && (opEvents === 0 || boEvents === 0); i++) await new Promise((r) => setTimeout(r, 250));
check("evento postgres_changes chega ao operador (RLS)", opEvents > 0);
check("evento postgres_changes chega ao backoffice (RLS staff)", boEvents > 0);
s1.ws.close();
s2.ws.close();

// ------------------------------------------------------------ admin-invite (verify_jwt = false, JWT validado no código)
const pre = await fn("admin-invite", { method: "OPTIONS", headers: { Origin: PORTAL, "Access-Control-Request-Headers": "authorization, x-client-info, apikey, content-type" } });
const allow = pre.headers.get("access-control-allow-headers") ?? "";
check("preflight libera x-client-info do supabase-js", pre.status === 204 && allow.includes("x-client-info"), allow);
const inviteBody = { email: `smoke-convite-${randomUUID().slice(0, 8)}@exemplo.test`, display_name: "Convite Fictício", role: "operator" };
const code = async (res) => `${res.status} ${(await res.json().catch(() => ({}))).code ?? ""}`.trim();
check("convite sem JWT → 401", (await code(await fn("admin-invite", { body: inviteBody }))) === "401 UNAUTHENTICATED");
check("convite com chave no Bearer → 401", (await code(await fn("admin-invite", { token: PUB, body: inviteBody }))) === "401 UNAUTHENTICATED");
check("convite com JWT adulterado → 401", (await code(await fn("admin-invite", { token: op.token.slice(0, -4) + "AAAA", body: inviteBody }))) === "401 UNAUTHENTICATED");
check("convite por operador → 403 FORBIDDEN", (await code(await fn("admin-invite", { token: op.token, body: inviteBody }))) === "403 FORBIDDEN");
const adm = await member("admin");
check("convite por admin aal1 → 403 MFA_REQUIRED", (await code(await fn("admin-invite", { token: adm.token, body: inviteBody }))) === "403 MFA_REQUIRED");
await withMfa(adm);
const inv = await fn("admin-invite", { token: adm.token, body: inviteBody });
const invBody = await inv.json().catch(() => ({}));
check("convite por admin aal2 → 201 (Auth admin + svc_* com a chave de servidor)", inv.status === 201 && !!invBody.profile_id, `${inv.status} ${invBody.code ?? ""}`);

// ------------------------------------------------------------ dispatch-notifications (x-cron-secret)
check("dispatch sem segredo → 401", (await fn("dispatch-notifications")).status === 401);
const pending = await admin.from("notification_queue").select("id", { count: "exact", head: true }).eq("status", "pending");
if ((pending.count ?? 0) === 0) {
  const d = await fn("dispatch-notifications", { headers: { "x-cron-secret": CRON } });
  const db = await d.json().catch(() => ({}));
  check("dispatch com segredo → 200 (svc_claim_notifications com a chave de servidor)", d.status === 200 && db.processed === 0, JSON.stringify(db));
} else {
  console.log("skip dispatch: há notificações pendentes (não enviar e-mail no smoke)");
}

await admin.from("form_definitions").update({ active: false }).eq("version", ver);
console.log(failures ? `\n${failures} falha(s)` : "\nSMOKE OK");
process.exit(failures ? 1 : 0);
