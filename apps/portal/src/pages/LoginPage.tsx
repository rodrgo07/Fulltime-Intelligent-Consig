import { useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthProvider";

export function LoginPage() {
  const { sb } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "danger" | "success"; text: string } | null>(null);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setMsg(null);
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    // Mensagem genérica: não revela se o e-mail existe.
    if (error) setMsg({ tone: "danger", text: "E-mail ou senha inválidos, ou acesso desativado." });
  }

  async function forgot() {
    if (!email.trim()) {
      setMsg({ tone: "danger", text: "Informe seu e-mail para recuperar a senha." });
      return;
    }
    setBusy(true);
    await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/definir-senha` });
    setBusy(false);
    setMsg({ tone: "success", text: "Se o e-mail estiver cadastrado, você receberá um link de redefinição." });
  }

  return (
    <main className="auth-screen">
      <section className="auth-panel" aria-labelledby="login-title">
        <img src="/fulltime.png" alt="Fulltime" className="auth-logo" />
        <p className="eyebrow">Intelligent Consig · Portal do operador</p>
        <h1 id="login-title">Entrar</h1>
        <form onSubmit={submit} className="stack">
          <div className="field">
            <label htmlFor="email">E-mail</label>
            <input id="email" className="input" type="email" autoComplete="username" required
              value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor="password">Senha</label>
            <input id="password" className="input" type="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          </div>
          {msg && <div className="notice" data-tone={msg.tone} role="status">{msg.text}</div>}
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
          <button className="btn-link" type="button" onClick={forgot} disabled={busy}>Esqueci minha senha</button>
        </form>
        <p className="auth-foot">Acesso somente por convite. Dados tratados conforme a LGPD.</p>
      </section>
    </main>
  );
}
