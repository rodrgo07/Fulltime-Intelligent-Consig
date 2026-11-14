// B8 — chaves novas contra um projeto Supabase REMOTO, antes do go-live, com dados 100% fictícios.
// Cobre: RPC com sb_publishable_ + JWT, recusa do anônimo, Realtime como o desktop, admin-invite com JWT real,
// dispatch-notifications com x-cron-secret. Tudo o que é criado leva a marca RUN e é apagado no finally.
//
//   FIC_B8_ALLOW_REMOTE=1 SUPABASE_URL=https://<ref>.supabase.co SUPABASE_PUBLISHABLE_KEY=... \
//   SUPABASE_SECRET_KEY=... CRON_SECRET=... PORTAL_URL=... node tests/smoke/b8-remote.mjs
//
// Regras: nunca rodar com formulário ativo ou fila de e-mail pendente (aborta); e-mails só @exemplo.test;
// nenhum dado real; não envia e-mail de conclusão (fila vazia). Imprime só resultados, nunca chaves ou tokens.
import { createClient } from "@supabase/supabase-js";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`defina ${k}`);
  return v;
};
if (process.env.FIC_B8_ALLOW_REMOTE !== "1") throw new Error("defina FIC_B8_ALLOW_REMOTE=1 (cria e apaga dados fictícios)");
const URL_ = env("SUPABASE_URL").replace(/\/$/, "");
const PUB = env("SUPABASE_PUBLISHABLE_KEY");
const SEC = env("SUPABASE_SECRET_KEY");
// Opcional: sem ele, o caminho 200 do dispatch é verificado pelo pg_net com os segredos do Vault (como o cron faz).
const CRON = process.env.CRON_SECRET ?? "";
const PORTAL = env("PORTAL_URL");
if (!PUB.startsWith("sb_publishable_") || !SEC.startsWith("sb_secret_")) throw new Error("use as chaves novas");

const RUN = `b8${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const MAIL = (role) => `fic-${RUN}-${role}@exemplo.test`;
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(URL_, SEC, opts);
const created = { users: [], formVersion: null, sockets: [] };

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
  const email = MAIL(role);
  const password = randomBytes(18).toString("base64url") + "aA1";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${role}): ${error.message}`);
  created.users.push(data.user.id);
  const reg = await admin.rpc("svc_register_member", {
    p_user_id: data.user.id, p_role: role, p_display_name: `Teste B8 ${role}`, p_email: email, p_invited_by: null,
  });
  check(`sb_secret_ executa svc_register_member (${role})`, !reg.error, reg.error?.message);
  const client = createClient(URL_, PUB, opts);
  const s = await client.auth.signInWithPassword({ email, password });
  if (s.error) throw new Error(`signIn(${role}): ${s.error.message}`);
  return { id: data.user.id, client, token: s.data.session.access_token };
}

async function withMfa(m) {
  const en = await m.client.auth.mfa.enroll({ factorType: "totp", friendlyName: `b8-${RUN}` });
  if (en.error) throw new Error(`enroll: ${en.error.message}`);
  const v = await m.client.auth.mfa.challengeAndVerify({ factorId: en.data.id, code: totp(en.data.totp.secret) });
  if (v.error) throw new Error(`mfa verify: ${v.error.message}`);
  m.token = (await m.client.auth.getSession()).data.session.access_token;
  return m;
}

function socket(token, onEvent) {
  // Igual ao desktop (realtime.rs): apikey publishable na URL, JWT do usuário no phx_join.
  const ws = new WebSocket(`${URL_.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(PUB)}&vsn=1.0.0`);
  created.sockets.push(ws);
  let subscribedResolve;
  const subscribed = new Promise((r) => { subscribedResolve = r; setTimeout(() => r("timeout"), 30000); });
  const joined = new Promise((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({
      topic: `realtime:fic-${RUN}`, event: "phx_join", ref: "1",
      payload: { config: { postgres_changes: [{ event: "*", schema: "public", table: "proposal_requests" }] }, access_token: token },
    }));
    ws.onmessage = (m) => {
      const v = JSON.parse(String(m.data));
      if (v.event === "phx_reply" && v.ref === "1") resolve(v.payload?.status);
      if (v.event === "system" && v.payload?.extension === "postgres_changes") subscribedResolve(v.payload?.status);
      if (v.event === "postgres_changes") onEvent(v);
    };
    ws.onerror = () => resolve("socket_error");
    setTimeout(() => resolve("timeout"), 15000);
  });
  return { ws, joined, subscribed };
}

const fn = (name, { token, headers = {}, body = {}, method = "POST" } = {}) =>
  fetch(`${URL_}/functions/v1/${name}`, {
    method,
    headers: { apikey: PUB, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
const code = async (res) => `${res.status} ${(await res.json().catch(() => ({}))).code ?? ""}`.trim();

async function cleanup() {
  for (const ws of created.sockets) try { ws.close(); } catch { /* já fechado */ }
  const ids = created.users;
  // Usuário eventualmente criado pelo convite (mesma marca RUN).
  for (let page = 1; page <= 20; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const users = data?.users ?? [];
    for (const u of users) if (u.email?.includes(`-${RUN}-`) && !ids.includes(u.id)) ids.push(u.id);
    if (users.length < 200) break;
  }
  const errs = [];
  const step = async (label, p) => { const { error } = await p; if (error) errs.push(`${label}: ${error.message}`); };
  if (ids.length) {
    const reqs = (await admin.from("proposal_requests").select("id").in("submitted_by", ids)).data ?? [];
    const reqIds = reqs.map((r) => r.id);
    if (reqIds.length) await step("audit(req)", admin.from("audit_logs").delete().in("request_id", reqIds));
    await step("requests", admin.from("proposal_requests").delete().in("submitted_by", ids));
    await step("audit(actor)", admin.from("audit_logs").delete().in("actor_id", ids));
    for (const id of ids) await step("audit(profile)", admin.from("audit_logs").delete().eq("details->>profile_id", id));
    await step("app_versions", admin.from("app_versions").delete().in("last_reported_by", ids));
  }
  if (created.formVersion) {
    await step("audit(form)", admin.from("audit_logs").delete().is("request_id", null).in("actor_id", ids));
    await step("form", admin.from("form_definitions").delete().eq("version", created.formVersion));
  }
  for (const id of ids) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) errs.push(`deleteUser: ${error.message}`);
  }
  console.log(errs.length ? `LIMPEZA COM ERROS: ${errs.join("; ")}` : `limpeza ok: ${ids.length} usuário(s) de teste removidos`);
  return { ids, errs };
}

let summary;
try {
  // Pré-condições de segurança: não interferir em nada existente.
  const active = await admin.from("form_definitions").select("version", { count: "exact", head: true }).eq("active", true);
  if ((active.count ?? 0) > 0) throw new Error("há formulário ativo: abortado para não interferir");
  const pend = await admin.from("notification_queue").select("id", { count: "exact", head: true }).in("status", ["pending", "sending"]);
  if ((pend.count ?? 0) > 0) throw new Error("há e-mails pendentes: abortado para não disparar envio");
  console.log(`run ${RUN}`);

  const anon = createClient(URL_, PUB, opts);
  const a = await anon.rpc("submit_proposal_request", { p_idempotency_key: randomUUID(), p_form_version: 1, p_payload: {} });
  check("anônimo (só publishable) recusado no RPC", a.error?.code === "42501", a.error?.code);

  const op = await member("operator");
  const r0 = await op.client.rpc("submit_proposal_request", { p_idempotency_key: randomUUID(), p_form_version: 1, p_payload: {} });
  check("operador (publishable + JWT) chega à regra de negócio", r0.error?.message === "FORM_NOT_CONFIGURED", r0.error?.message);
  const bo = await withMfa(await member("backoffice"));
  const hb = await bo.client.rpc("report_backoffice_heartbeat", { p_app_version: "0.0.0-b8", p_channel: "development" });
  check("backoffice aal2 executa RPC", !hb.error, hb.error?.message);
  const boAal1 = createClient(URL_, PUB, opts);
  check("RLS: operador não lê auditoria", ((await op.client.from("audit_logs").select("id")).data ?? []).length === 0);

  const ver = 900 + Math.floor(Math.random() * 99);
  const fd = await admin.from("form_definitions").insert({
    version: ver, title: `Teste B8 ${RUN} (fictício)`, active: true,
    fields: [{ key: "nome_teste", label: "Nome", type: "text", required: true }],
  });
  if (!fd.error) created.formVersion = ver;
  check("sb_secret_ escreve como service_role (formulário fictício)", !fd.error, fd.error?.message);

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
  check("envio fictício do operador", !sub.error, sub.error?.message);
  // Desativa logo o formulário de teste: nenhum outro envio possível.
  await admin.from("form_definitions").update({ active: false }).eq("version", ver);
  for (let i = 0; i < 80 && (opEvents === 0 || boEvents === 0); i++) await new Promise((r) => setTimeout(r, 250));
  check("evento postgres_changes chega ao operador (RLS)", opEvents > 0);
  check("evento postgres_changes chega ao backoffice (RLS staff)", boEvents > 0);

  const pre = await fn("admin-invite", { method: "OPTIONS", headers: { Origin: PORTAL, "Access-Control-Request-Headers": "authorization, x-client-info, apikey, content-type" } });
  const allow = pre.headers.get("access-control-allow-headers") ?? "";
  check("preflight libera x-client-info", pre.status === 204 && allow.includes("x-client-info"));
  const inviteBody = { email: MAIL("convite"), display_name: "Convite Fictício B8", role: "operator" };
  check("convite sem JWT → 401", (await code(await fn("admin-invite", { body: inviteBody }))) === "401 UNAUTHENTICATED");
  check("convite com chave no Bearer → 401", (await code(await fn("admin-invite", { token: PUB, body: inviteBody }))) === "401 UNAUTHENTICATED");
  check("convite com JWT adulterado → 401", (await code(await fn("admin-invite", { token: op.token.slice(0, -4) + "AAAA", body: inviteBody }))) === "401 UNAUTHENTICATED");
  check("convite por operador → 403 FORBIDDEN", (await code(await fn("admin-invite", { token: op.token, body: inviteBody }))) === "403 FORBIDDEN");
  const adm = await member("admin");
  check("convite por admin aal1 → 403 MFA_REQUIRED", (await code(await fn("admin-invite", { token: adm.token, body: inviteBody }))) === "403 MFA_REQUIRED");
  await withMfa(adm);
  const inv = await code(await fn("admin-invite", { token: adm.token, body: inviteBody }));
  // 201 = convite criado. 502 INVITE_FAILED = o JWT passou e a chave de servidor chegou ao Auth admin, mas o
  // envio do e-mail foi recusado (sem SMTP próprio, o SMTP padrão só envia para a equipe do projeto).
  check("convite por admin aal2 passa da autenticação (201, ou 502 sem SMTP)", inv === "201" || inv === "502 INVITE_FAILED", inv);
  void boAal1;

  check("dispatch sem segredo → 401", (await fn("dispatch-notifications")).status === 401);
  check("dispatch com segredo errado → 401", (await fn("dispatch-notifications", { headers: { "x-cron-secret": "errado-" + RUN } })).status === 401);
  if (CRON) {
    const d = await fn("dispatch-notifications", { headers: { "x-cron-secret": CRON } });
    const db = await d.json().catch(() => ({}));
    check("dispatch com segredo → 200 (svc_claim_notifications com a chave de servidor)", d.status === 200 && db.processed === 0, `${d.status} ${JSON.stringify(db)}`);
  } else {
    console.log("skip dispatch 200: sem CRON_SECRET (verificar via pg_net + Vault)");
  }
} catch (e) {
  failures++;
  console.log(`FAIL execução interrompida — ${e.message}`);
} finally {
  summary = await cleanup();
}
console.log(failures || summary.errs.length ? `\nB8: ${failures} falha(s)` : `\nB8 OK (run ${RUN})`);
process.exit(failures || summary.errs.length ? 1 : 0);
