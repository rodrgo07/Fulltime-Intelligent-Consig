import { useEffect, useState, type FormEvent } from "react";
import { call, errorMessage, type AppConfig, type AuthStatus } from "../lib/ipc";

type Props = { status: AuthStatus; onChange: (s: AuthStatus) => void };

/** Login do backoffice: conexão (1ª vez) → e-mail/senha → MFA TOTP (cadastro na 1ª vez). */
export function Login({ status, onChange }: Props) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enroll, setEnroll] = useState<{ factor_id: string; qr_code: string } | null>(null);
  const [url, setUrl] = useState("");
  const [anon, setAnon] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    call<AppConfig>("config_get").then(setCfg).catch((e) => setErr(errorMessage(e)));
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const configured = cfg && cfg.supabase_url && cfg.supabase_anon_key;

  if (cfg && !configured) {
    return (
      <Frame title="Conectar ao Supabase" eyebrow="Configuração inicial">
        <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(async () => {
          setCfg(await call<AppConfig>("config_update", { patch: { supabase_url: url.trim(), supabase_anon_key: anon.trim() } }));
        }); }}>
          <p className="muted small">Use a URL do projeto e a chave <strong>publicável</strong> (<span className="mono">sb_publishable_…</span> ou a anon legada). Chaves secretas (<span className="mono">sb_secret_…</span> ou service_role) são recusadas.</p>
          <div className="field"><label htmlFor="u">URL do projeto</label>
            <input id="u" className="input mono" placeholder="https://<projeto>.supabase.co" value={url} onChange={(e) => setUrl(e.target.value)} required /></div>
          <div className="field"><label htmlFor="k">Chave publicável (sb_publishable_… ou anon legada)</label>
            <input id="k" className="input mono" type="password" autoComplete="off" value={anon} onChange={(e) => setAnon(e.target.value)} required /></div>
          {err && <div className="notice" data-tone="danger" role="alert" id="login-err">{err}</div>}
          <button className="btn btn-primary" disabled={busy}>Salvar conexão</button>
        </form>
      </Frame>
    );
  }

  if (status.state === "mfa_required") {
    const startEnroll = () => run(async () => setEnroll(await call("auth_mfa_enroll")));
    return (
      <Frame title="Verificação em duas etapas" eyebrow="Backoffice">
        {!status.has_factor && !enroll && (
          <div className="stack">
            <p className="muted small">O acesso do backoffice exige um aplicativo autenticador (TOTP).</p>
            <button className="btn btn-primary" onClick={startEnroll} disabled={busy}>Cadastrar autenticador</button>
          </div>
        )}
        {enroll && <img className="qr" src={enroll.qr_code} alt="QR code para cadastrar o Intelligent Consig no aplicativo autenticador" width={176} height={176} />}
        {(status.has_factor || enroll) && (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => {
            onChange(await call<AuthStatus>("auth_mfa_verify", { code, factorId: enroll?.factor_id ?? null }));
          }); }}>
            <div className="field"><label htmlFor="c">Código de 6 dígitos</label>
              <input id="c" className="input mono code" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                pattern="[0-9]{6}" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus required
                aria-invalid={err ? true : undefined} aria-describedby={err ? "login-err" : undefined} /></div>
            {err && <div className="notice" data-tone="danger" role="alert" id="login-err">{err}</div>}
            <button className="btn btn-primary" disabled={busy || code.length !== 6}>Verificar</button>
          </form>
        )}
        <button className="btn-link" onClick={() => void call("auth_logout").then(() => onChange({ state: "signed_out" }))}>Usar outra conta</button>
      </Frame>
    );
  }

  return (
    <Frame title="Entrar" eyebrow="Backoffice">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => {
        const st = await call<AuthStatus>("auth_login", { email, password });
        setPassword("");
        onChange(st);
      }); }}>
        <div className="field"><label htmlFor="e">E-mail</label>
          <input id="e" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></div>
        <div className="field"><label htmlFor="p">Senha</label>
          <input id="p" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
        {err && <div className="notice" data-tone="danger" role="alert" id="login-err">{err}</div>}
        <button className="btn btn-primary" disabled={busy}>{busy ? "Entrando…" : "Continuar"}</button>
      </form>
    </Frame>
  );
}

function Frame({ title, eyebrow, children }: { title: string; eyebrow: string; children: React.ReactNode }) {
  useEffect(() => { document.title = `${title} · Fulltime Intelligent Consig`; }, [title]);
  return (
    <main className="auth" id="conteudo">
      <section className="auth-card">
        <div className="auth-brand">
          <span className="brand-chip"><img src="/fulltime.png" alt="Fulltime" /></span>
          <span className="eyebrow">Intelligent Consig</span>
        </div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {children}
      </section>
      <footer className="auth-foot mono">Acesso restrito ao computador do backoffice · sessão protegida pelo Windows Credential Manager</footer>
    </main>
  );
}
