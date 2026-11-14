// B8 — chaves novas contra um projeto Supabase REMOTO, antes do go-live, com dados 100% fictícios.
// Cobre: RPC com sb_publishable_ + JWT, recusa do anônimo, Realtime como o desktop e a troca de senha obrigatória. Tudo o que é criado leva a marca RUN e é apagado no fim.
//
// CADA execução contra produção exige aprovação explícita do usuário. Só antes do go-live: a limpeza apaga
// linhas de audit_logs dos dados fictícios, o que nunca deve ser feito com dados reais.
//
// Chaves fora da linha de comando (não ficam no histórico do shell): um arquivo .env FORA do repositório,
//   ~/fic-b8.env  →  SUPABASE_URL=https://<ref>.supabase.co, SUPABASE_PUBLISHABLE_KEY=…, SUPABASE_SECRET_KEY=…,
//   FIC_B8_ALLOW_REMOTE=<ref> node --env-file="$HOME/fic-b8.env" tests/smoke/b8-remote.mjs
// ou `read -rs SUPABASE_SECRET_KEY && export SUPABASE_SECRET_KEY` antes de rodar.
//
// Salvaguardas: aborta se houver formulário ativo, solicitação em andamento ou backoffice visto nos
// últimos 30 min (o PC real poderia reservar o envio fictício); a solicitação fictícia é cancelada logo após o teste
// de Realtime; e-mails só @exemplo.test (o sistema não envia e-mail). Ctrl+C também limpa. Imprime só resultados, nunca chaves ou tokens.
import { createClient } from "@supabase/supabase-js";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`defina ${k}`);
  return v;
};
const URL_ = env("SUPABASE_URL").replace(/\/$/, "");
const REF = new URL(URL_).hostname.split(".")[0];
if (process.env.FIC_B8_ALLOW_REMOTE !== REF) {
  throw new Error(`defina FIC_B8_ALLOW_REMOTE=${REF} (confirma o projeto; cria e apaga dados fictícios)`);
}
const PUB = env("SUPABASE_PUBLISHABLE_KEY");
const SEC = env("SUPABASE_SECRET_KEY");
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
const created = { users: [], formVersion: null, sockets: [], requests: [] };

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
    p_user_id: data.user.id, p_role: role, p_display_name: `Teste B8 ${role}`,
  });
  check(`sb_secret_ executa svc_register_member (${role})`, !reg.error, reg.error?.message);
  const client = createClient(URL_, PUB, opts);
  const s = await client.auth.signInWithPassword({ email, password });
  if (s.error) throw new Error(`signIn(${role}): ${s.error.message}`);
  // Cadastro novo nasce com senha provisória: a API recusa tudo até a troca (trava no banco, 0007).
  const flag = async () => (await client.from("profiles").select("must_change_password").eq("id", data.user.id).single()).data?.must_change_password;
  check(`cadastro novo nasce com must_change_password = true (${role})`, (await flag()) === true);
  if (role === "operator") {
    const r = await client.rpc("submit_proposal_request", { p_idempotency_key: randomUUID(), p_form_version: 1, p_payload: {} });
    check("senha provisória: RPC recusada com PASSWORD_CHANGE_REQUIRED (API direta)", r.error?.message === "PASSWORD_CHANGE_REQUIRED", r.error?.message);
  }
  const upd = await client.auth.updateUser({ password: randomBytes(18).toString("base64url") + "aA1" });
  check(`troca de senha logada sem código por e-mail (${role})`, !upd.error, upd.error?.message);
  const mk = await client.rpc("mark_password_changed");
  check(`mark_password_changed libera o membro (${role})`, !mk.error && (await flag()) === false, mk.error?.message);
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


async function cleanup() {
  for (const ws of created.sockets) try { ws.close(); } catch { /* já fechado */ }
  const errs = [];
  const step = async (label, p) => { const { error } = await p; if (error) errs.push(`${label}: ${error.message}`); };
  // Solicitação fictícia ainda aberta (ex.: Ctrl+C antes do cancelamento): tira da fila primeiro.
  for (const r of created.requests) {
    await step("cancel", admin.from("proposal_requests").update({ status: "cancelled", status_reason: `teste B8 ${RUN}` })
      .eq("id", r.id).in("status", ["received", "queued"]));
  }
  const ids = created.users;
  // Usuário eventualmente criado pelo convite (mesma marca RUN).
  for (let page = 1; page <= 20; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const users = data?.users ?? [];
    for (const u of users) if (u.email?.includes(`-${RUN}-`) && !ids.includes(u.id)) ids.push(u.id);
    if (users.length < 200) break;
  }
  if (ids.length) {
    const reqs = (await admin.from("proposal_requests").select("id").in("submitted_by", ids)).data ?? [];
    const reqIds = reqs.map((r) => r.id);
    // audit_logs só é apagado porque tudo aqui é fictício e o projeto ainda não está em produção.
    if (reqIds.length) await step("audit(req)", admin.from("audit_logs").delete().in("request_id", reqIds));
    await step("requests", admin.from("proposal_requests").delete().in("submitted_by", ids));
    await step("audit(actor)", admin.from("audit_logs").delete().in("actor_id", ids));
    for (const id of ids) await step("audit(profile)", admin.from("audit_logs").delete().eq("details->>profile_id", id));
    await step("app_versions", admin.from("app_versions").delete().in("last_reported_by", ids));
  }
  if (created.formVersion) {
    await step("form", admin.from("form_definitions").delete().eq("version", created.formVersion).like("title", `%${RUN}%`));
  }
  for (const id of ids) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) errs.push(`deleteUser: ${error.message}`);
  }
  console.log(errs.length ? `LIMPEZA COM ERROS: ${errs.join("; ")}` : `limpeza ok: ${ids.length} usuário(s) de teste removidos`);
  return { ids, errs };
}

let summary = { errs: [] };
let cleaning = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (cleaning) return;
    cleaning = true;
    console.log(`\n${sig}: limpando os dados fictícios antes de sair…`);
    await cleanup().catch((e) => console.log(`LIMPEZA FALHOU: ${e.message}`));
    process.exit(130);
  });
}

try {
  // Pré-condições de segurança: não interferir em nada existente.
  const busy = await admin.from("proposal_requests").select("id", { count: "exact", head: true })
    .not("status", "in", "(completed,failed,cancelled)");
  if ((busy.count ?? 0) > 0) throw new Error("há solicitação em andamento: abortado para não interferir na fila");
  const seen = await admin.from("app_versions").select("last_seen_at").order("last_seen_at", { ascending: false }).limit(1);
  const last = seen.data?.[0]?.last_seen_at;
  if (last && Date.now() - new Date(last).getTime() < 30 * 60_000) {
    throw new Error("backoffice visto nos últimos 30 min: abortado (o PC real poderia reservar o envio fictício)");
  }
  const active = await admin.from("form_definitions").select("version", { count: "exact", head: true }).eq("active", true);
  if ((active.count ?? 0) > 0) throw new Error("há formulário ativo: abortado para não interferir");
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
  if (created.formVersion) {
    const sub = await op.client.rpc("submit_proposal_request", {
      p_idempotency_key: randomUUID(), p_form_version: created.formVersion, p_payload: { nome_teste: "Pessoa Fictícia" },
    });
    check("envio fictício do operador", !sub.error, sub.error?.message);
    if (sub.data?.request_id) created.requests.push({ id: sub.data.request_id, client: op.client });
    // Desativa logo o formulário de teste (só o nosso): nenhum outro envio possível.
    await admin.from("form_definitions").update({ active: false }).eq("version", created.formVersion);
    for (let i = 0; i < 80 && (opEvents === 0 || boEvents === 0); i++) await new Promise((r) => setTimeout(r, 250));
    check("evento postgres_changes chega ao operador (RLS)", opEvents > 0);
    check("evento postgres_changes chega ao backoffice (RLS staff)", boEvents > 0);
    // Cancela já: a solicitação fictícia não fica disponível para o backoffice reservar.
    for (const r of created.requests) {
      const c = await r.client.rpc("cancel_proposal_request", { p_request_id: r.id, p_reason: `teste B8 ${RUN}` });
      check("solicitação fictícia cancelada logo após o Realtime", !c.error && c.data?.status === "cancelled", c.error?.message);
    }
  }

} catch (e) {
  failures++;
  console.log(`FAIL execução interrompida — ${e.message}`);
} finally {
  if (!cleaning) {
    cleaning = true;
    summary = await cleanup();
  }
}
console.log(failures || summary.errs.length ? `\nB8: ${failures} falha(s)` : `\nB8 OK (run ${RUN})`);
process.exit(failures || summary.errs.length ? 1 : 0);
