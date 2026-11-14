import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ApiError, AppRole } from "@fic/contracts";
import { useAuth } from "../auth/AuthProvider";
import type { Api } from "../lib/api";
import { fmtDateTime } from "../components/Status";
import { EmptyState, ErrorState, Loading } from "../components/States";

type Members = Extract<Awaited<ReturnType<Api["members"]>>, { ok: true }>["data"];

const ROLE_LABEL: Record<AppRole, string> = { operator: "Operador", backoffice: "Backoffice", admin: "Administrador" };

export function AdminPage() {
  const { api, session } = useAuth();
  const [members, setMembers] = useState<Members | null>(null);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<AppRole>("operator");
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadingList(true);
    const r = await api.members();
    setLoadingList(false);
    if (r.ok) {
      setMembers(r.data);
      setListError(null);
    } else setListError(r.error);
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

  async function toggle(id: string, displayName: string, active: boolean) {
    if (!active && !window.confirm(`Desativar o acesso de ${displayName}? As sessões abertas serão revogadas.`)) return;
    setToggling(id);
    setError(null);
    setOk(null);
    const r = await api.setMemberActive(id, active);
    setToggling(null);
    if (!r.ok) setError(r.error);
    else setOk(`Acesso de ${displayName} ${active ? "reativado" : "desativado"}.`);
    void load();
  }

  return (
    <section className="page" aria-labelledby="admin-title">
      <header className="page-head">
        <div>
          <p className="eyebrow">Administração</p>
          <h1 id="admin-title">Acessos</h1>
        </div>
      </header>

      <form className="invite-row" onSubmit={invite} aria-labelledby="invite-title" aria-busy={busy}>
        <h2 id="invite-title" className="visually-hidden">Convidar membro</h2>
        <div className="field">
          <label htmlFor="inv-name">Nome</label>
          <input id="inv-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120}
            autoComplete="off" disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="inv-email">E-mail</label>
          <input id="inv-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
            autoComplete="off" disabled={busy} />
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

      <h2 className="section-title">Membros</h2>
      {members === null && listError ? (
        <ErrorState title="Não foi possível carregar os membros" message={listError.message} onRetry={() => void load()} retrying={loadingList} />
      ) : members === null ? (
        <Loading label="Carregando membros…" />
      ) : members.length === 0 ? (
        <EmptyState title="Nenhum membro cadastrado">Use o formulário acima para convidar o primeiro membro.</EmptyState>
      ) : (
        <div className="table-wrap">
          {listError && <div className="notice" data-tone="danger" role="alert">{listError.message} A lista pode estar desatualizada.</div>}
          <table className="table">
            <caption className="visually-hidden">Membros com acesso ao Intelligent Consig</caption>
            <thead>
              <tr>
                <th scope="col">Nome</th><th scope="col">Papel</th><th scope="col">Código</th><th scope="col">E-mail de notificação</th>
                <th scope="col">Desde</th><th scope="col">Situação</th><th scope="col"><span className="visually-hidden">Ações</span></th>
              </tr>
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
                    {m.id !== session?.user.id ? (
                      <button className={`btn btn-sm ${m.active ? "btn-danger" : ""}`} disabled={toggling === m.id}
                        aria-label={`${m.active ? "Desativar" : "Reativar"} o acesso de ${m.display_name}`}
                        onClick={() => void toggle(m.id, m.display_name, !m.active)}>
                        {toggling === m.id ? "Salvando…" : m.active ? "Desativar" : "Reativar"}
                      </button>
                    ) : <span className="muted small">Você</span>}
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
