import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ApiError, AppRole } from "@fic/contracts";
import { useAuth } from "../auth/AuthProvider";
import type { Api } from "../lib/api";
import { fmtDateTime } from "../components/Status";

type Members = Extract<Awaited<ReturnType<Api["members"]>>, { ok: true }>["data"];

const ROLE_LABEL: Record<AppRole, string> = { operator: "Operador", backoffice: "Backoffice", admin: "Administrador" };

export function AdminPage() {
  const { api, session } = useAuth();
  const [members, setMembers] = useState<Members | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<AppRole>("operator");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api.members();
    if (r.ok) setMembers(r.data);
    else setError(r.error);
  }, [api]);

  useEffect(() => void load(), [load]);

  async function invite(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    const r = await api.invite(email.trim(), name.trim(), role);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setOk(`Convite enviado para ${email.trim()}.`);
    setEmail("");
    setName("");
    void load();
  }

  async function toggle(id: string, active: boolean) {
    if (!active && !window.confirm("Desativar este acesso? As sessões abertas serão revogadas.")) return;
    const r = await api.setMemberActive(id, active);
    if (!r.ok) setError(r.error);
    void load();
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Administração</p>
          <h1>Acessos</h1>
        </div>
      </header>

      <form className="invite-row" onSubmit={invite} aria-label="Convidar membro">
        <div className="field">
          <label htmlFor="inv-name">Nome</label>
          <input id="inv-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="inv-email">E-mail</label>
          <input id="inv-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="inv-role">Papel</label>
          <select id="inv-role" className="input" value={role} onChange={(e) => setRole(e.target.value as AppRole)} disabled={busy}>
            {(Object.keys(ROLE_LABEL) as AppRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </div>
        <button className="btn btn-primary" disabled={busy}>{busy ? "Enviando…" : "Convidar"}</button>
      </form>

      {ok && <div className="notice" data-tone="success" role="status">{ok}</div>}
      {error && <div className="notice" data-tone="danger" role="alert">{error.message}</div>}

      {members && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Nome</th><th>Papel</th><th>Código</th><th>E-mail de notificação</th><th>Desde</th><th>Situação</th><th /></tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td data-label="Nome">{m.display_name}</td>
                  <td data-label="Papel">{ROLE_LABEL[m.role]}</td>
                  <td className="mono" data-label="Código">{m.operators?.operator_code ?? "—"}</td>
                  <td data-label="E-mail">{m.operators?.notification_email ?? "—"}</td>
                  <td data-label="Desde">{fmtDateTime(m.created_at)}</td>
                  <td data-label="Situação">
                    <span className="status" data-tone={m.active ? "success" : "muted"}>{m.active ? "Ativo" : "Desativado"}</span>
                  </td>
                  <td className="cell-actions">
                    {m.id !== session?.user.id && (
                      <button className={`btn btn-sm ${m.active ? "btn-danger" : ""}`} onClick={() => void toggle(m.id, !m.active)}>
                        {m.active ? "Desativar" : "Reativar"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
