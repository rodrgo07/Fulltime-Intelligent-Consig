import { useEffect, useState } from "react";
import { FINAL_STATUSES, statusReasonLabel } from "@fic/contracts";
import { RefreshCw } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { navigate } from "../lib/router";
import { useMyRequests, type MyRequests } from "../lib/useMyRequests";
import { fmtDateTime, fmtTime, Status } from "../components/Status";
import { EmptyState, ErrorState, Loading } from "../components/States";

/** Heartbeat mais antigo que isto = backoffice sem conexão recente. */
const PRESENCE_WINDOW_MS = 3 * 60_000;

/** Lista do operador. Os dados vêm de `useMyRequests` (no App), que também controla o selo "Nova". */
export function RequestsPage({ data: shared }: { data?: MyRequests }) {
  const { api, session } = useAuth();
  // Sem dados do App (uso isolado/testes), a página carrega sozinha; com eles, o hook local fica inativo.
  const own = useMyRequests(api, shared ? null : session?.user.id ?? null);
  const data = shared ?? own;
  const { rows, refreshing, updatedAt, newIds, newCount, markSeen, markAllSeen } = data;
  const reload = data.reload;
  const [actionError, setActionError] = useState<string | null>(null);
  const [presence, setPresence] = useState<{ at: string | null } | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const error = actionError ?? data.error?.message ?? null;

  // Presença do backoffice acompanha cada atualização da lista.
  useEffect(() => {
    let alive = true;
    api.backofficePresence().then((p) => alive && setPresence(p.ok ? { at: p.data } : null));
    return () => { alive = false; };
  }, [api, updatedAt]);

  async function cancel(id: string, ref: string) {
    if (!window.confirm(`Cancelar a solicitação ${ref}? Os dados enviados serão excluídos.`)) return;
    setCancelling(id);
    setActionError(null);
    const r = await api.cancel(id);
    setCancelling(null);
    if (!r.ok) setActionError(r.error.message);
    void reload();
  }

  const presenceTone = presence === null ? "muted" : presence.at && Date.now() - new Date(presence.at).getTime() < PRESENCE_WINDOW_MS ? "success" : "attention";
  const presenceText = presence === null
    ? "Backoffice: estado indisponível"
    : presenceTone === "success" ? "Backoffice conectado" : "Backoffice sem conexão recente";

  return (
    <section className="page" aria-labelledby="requests-title">
      <header className="page-head">
        <div>
          <p className="eyebrow">Acompanhamento</p>
          <h1 id="requests-title">Minhas solicitações</h1>
        </div>
        <div className="head-actions">
          <span className="status" data-tone={presenceTone}>{presenceText}</span>
          {newCount > 0 && (
            <button className="btn" onClick={markAllSeen}>Marcar todas como vistas</button>
          )}
          <button className="btn" onClick={() => void reload()} disabled={refreshing} aria-busy={refreshing || undefined}>
            <RefreshCw size={14} aria-hidden="true" className={refreshing ? "spin" : undefined} />
            {refreshing ? "Atualizando…" : "Atualizar"}
          </button>
        </div>
      </header>

      {rows === null && error ? (
        <ErrorState message={error} onRetry={() => void reload()} retrying={refreshing} />
      ) : rows === null ? (
        <Loading label="Carregando solicitações…" />
      ) : (
        <>
          {error && (
            <div className="notice" data-tone="danger" role="alert">
              {error} {updatedAt && <>Exibindo os dados de {fmtTime(updatedAt)}.</>}
            </div>
          )}
          {rows.length === 0 ? (
            <EmptyState title="Nenhuma solicitação enviada"
              action={<button className="btn btn-primary" onClick={() => navigate("/")}>Nova solicitação</button>}>
              As solicitações que você enviar aparecem aqui, com o estado atualizado automaticamente.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">
                  Solicitações enviadas por você ou das quais você é proprietário, da mais recente para a mais antiga
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Operação</th>
                    <th scope="col">Recebida</th>
                    <th scope="col">Status</th>
                    <th scope="col">Adesão</th>
                    <th scope="col">Concluída</th>
                    <th scope="col"><span className="visually-hidden">Ações</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const reason = statusReasonLabel(r.status_reason);
                    const isNew = newIds.has(r.id);
                    return (
                      <tr key={r.id} data-new={isNew || undefined}>
                        <td className="mono" data-label="Operação">
                          {r.public_ref}
                          {isNew && (
                            // Texto "Nova" (não só cor); clicar/Enter marca como vista.
                            <button className="badge-new" onClick={() => markSeen(r.id)}
                              aria-label={`Nova: proposta gerada para ${r.public_ref}. Marcar como vista`}>
                              Nova
                            </button>
                          )}
                          {r.owner_operator_id !== session?.user.id && <span className="tag">Remetente</span>}
                        </td>
                        <td data-label="Recebida">{fmtDateTime(r.received_at)}</td>
                        <td data-label="Status">
                          <span className="status-cell">
                            <Status status={r.status} />
                            {reason && <span className="reason">{reason}</span>}
                          </span>
                        </td>
                        <td className="mono" data-label="Adesão">{r.proposal_results?.adhesion_number ?? "—"}</td>
                        <td data-label="Concluída">{fmtDateTime(r.completed_at)}</td>
                        <td className="cell-actions">
                          {(r.status === "received" || r.status === "queued") && r.submitted_by === session?.user.id && (
                            <button className="btn btn-danger btn-sm" disabled={cancelling === r.id}
                              aria-label={`Cancelar a solicitação ${r.public_ref}`} onClick={() => void cancel(r.id, r.public_ref)}>
                              {cancelling === r.id ? "Cancelando…" : "Cancelar"}
                            </button>
                          )}
                          {r.pii_purged_at && !FINAL_STATUSES.includes(r.status) && (
                            <span className="muted">Dados expirados</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {updatedAt && <p className="muted small" aria-live="off">Atualizado às {fmtTime(updatedAt)}. Atualização automática a cada 30 s.</p>}
        </>
      )}
    </section>
  );
}
