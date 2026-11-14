import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthProvider";
import { authErrorMessage } from "../lib/authErrors";
import { navigate } from "../lib/router";

/** Usado pelo link de convite e de recuperação de senha. */
export function SetPasswordPage() {
  const { sb, clearNeedsPassword } = useAuth();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { document.title = "Definir senha · Fulltime Intelligent Consig — Portal"; }, []);

  const strong =pw.length >= 12 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!strong) return setErr("Use ao menos 12 caracteres, com maiúsculas, minúsculas e números.");
    if (pw !== pw2) return setErr("As senhas não conferem.");
    setBusy(true);
    const { error } = await sb.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setErr(authErrorMessage(error, "Não foi possível definir a senha. O link pode ter expirado."));
    clearNeedsPassword();
    navigate("/");
  }

  return (
    <main className="auth-screen" id="conteudo">
      <section className="auth-panel" aria-labelledby="pw-title">
        <p className="eyebrow">Intelligent Consig</p>
        <h1 id="pw-title">Definir senha</h1>
        <form onSubmit={submit} className="stack" aria-busy={busy}>
          <div className="field">
            <label htmlFor="pw">Nova senha</label>
            <input id="pw" className="input" type="password" autoComplete="new-password" value={pw}
              onChange={(e) => setPw(e.target.value)} disabled={busy} required minLength={12}
              aria-describedby={err ? "pw-hint pw-err" : "pw-hint"} aria-invalid={err ? true : undefined} />
            <span className="hint" id="pw-hint">Mínimo de 12 caracteres, com maiúsculas, minúsculas e números.</span>
          </div>
          <div className="field">
            <label htmlFor="pw2">Confirmar senha</label>
            <input id="pw2" className="input" type="password" autoComplete="new-password" value={pw2}
              onChange={(e) => setPw2(e.target.value)} disabled={busy} required />
          </div>
          {err && <div className="notice" data-tone="danger" role="alert" id="pw-err">{err}</div>}
          <button className="btn btn-primary" disabled={busy}>{busy ? "Salvando…" : "Salvar senha"}</button>
        </form>
      </section>
    </main>
  );
}
