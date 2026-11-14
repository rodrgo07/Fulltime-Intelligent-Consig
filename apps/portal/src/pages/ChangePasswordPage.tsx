import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthProvider";
import { authErrorMessage } from "../lib/authErrors";
import { navigate } from "../lib/router";

const MIN = 12;

/**
 * Troca de senha. `forced`: senha provisória criada pelo admin (`profiles.must_change_password`) — nenhuma outra
 * tela abre antes da troca. Sem `forced`: "Alterar senha" do menu do usuário.
 * Não há recuperação por e-mail: senha esquecida é redefinida pelo administrador.
 */
export function ChangePasswordPage({ forced }: { forced: boolean }) {
  const { sb, api, refresh, signOut } = useAuth();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (forced) document.title = "Troca de senha obrigatória · Fulltime Intelligent Consig — Portal";
  }, [forced]);

  const strong = pw.length >= MIN && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setDone(false);
    if (!strong) return setErr(`Use ao menos ${MIN} caracteres, com maiúsculas, minúsculas e números.`);
    if (pw !== pw2) return setErr("As senhas não conferem.");
    setBusy(true);
    setErr(null);
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) {
      setBusy(false);
      return setErr(authErrorMessage(error, "Não foi possível alterar a senha. Tente novamente."));
    }
    const r = await api.markPasswordChanged();
    setBusy(false);
    if (!r.ok) return setErr(`A senha foi alterada, mas não foi possível concluir o registro: ${r.error.message}`);
    setPw("");
    setPw2("");
    setDone(true);
    await refresh();
    if (forced) navigate("/");
  }

  const form = (
    <form onSubmit={submit} className="stack" aria-busy={busy}>
      <div className="field">
        <label htmlFor="pw">Nova senha</label>
        <input id="pw" className="input" type="password" autoComplete="new-password" value={pw}
          onChange={(e) => setPw(e.target.value)} disabled={busy} required minLength={MIN}
          aria-describedby={err ? "pw-hint pw-err" : "pw-hint"} aria-invalid={err ? true : undefined} />
        <span className="hint" id="pw-hint">Mínimo de {MIN} caracteres, com maiúsculas, minúsculas e números.</span>
      </div>
      <div className="field">
        <label htmlFor="pw2">Confirmar a nova senha</label>
        <input id="pw2" className="input" type="password" autoComplete="new-password" value={pw2}
          onChange={(e) => setPw2(e.target.value)} disabled={busy} required />
      </div>
      {err && <div className="notice" data-tone="danger" role="alert" id="pw-err">{err}</div>}
      {done && !forced && <div className="notice" data-tone="success" role="status">Senha alterada.</div>}
      <button className="btn btn-primary" disabled={busy}>{busy ? "Salvando…" : "Salvar nova senha"}</button>
    </form>
  );

  if (forced) {
    return (
      <main className="auth-screen" id="conteudo">
        <section className="auth-panel" aria-labelledby="pw-title">
          <p className="eyebrow">Intelligent Consig · Primeiro acesso</p>
          <h1 id="pw-title">Troca de senha obrigatória</h1>
          <p className="muted">Sua senha foi definida pelo administrador. Crie uma senha só sua para continuar.</p>
          {form}
          <button className="btn-link" type="button" onClick={() => void signOut()}>Sair</button>
        </section>
      </main>
    );
  }

  return (
    <section className="page page-narrow" aria-labelledby="pw-title">
      <header className="page-head">
        <div>
          <p className="eyebrow">Conta</p>
          <h1 id="pw-title">Alterar senha</h1>
        </div>
      </header>
      {form}
    </section>
  );
}
