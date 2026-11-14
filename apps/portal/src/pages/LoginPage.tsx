import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthProvider";
import { authErrorMessage } from "../lib/authErrors";

export function LoginPage() {
  const { sb } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "danger" | "success"; text: string } | null>(null);

  useEffect(() => { document.title = "Entrar · Fulltime Intelligent Consig — Portal"; }, []);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
      // Mensagem genérica: não revela se o e-mail existe.
      if (error) setMsg({ tone: "danger", text: authErrorMessage(error, "E-mail ou senha inválidos, ou acesso desativado.") });
    } catch {
      setMsg({ tone: "danger", text: authErrorMessage({ status: 0 }, "") });
    } finally {
      setBusy(false);
    }
  }


  return (
    <main className="auth-screen" id="conteudo">
      <section className="auth-panel" aria-labelledby="login-title">
        <img src="/fulltime.png" alt="Fulltime" className="auth-logo" />
        <p className="eyebrow">Intelligent Consig · Portal do operador</p>
        <h1 id="login-title">Entrar</h1>
        <form onSubmit={submit} className="stack" aria-busy={busy}>
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
          {msg && <div className="notice" data-tone={msg.tone} role={msg.tone === "danger" ? "alert" : "status"}>{msg.text}</div>}
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
          <p className="muted small">Esqueceu a senha? Fale com o administrador.</p>
        </form>
        <p className="auth-foot">Acesso somente por convite. Dados tratados conforme a LGPD.</p>
      </section>
    </main>
  );
}
