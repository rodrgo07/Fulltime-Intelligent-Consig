import { useCallback, useEffect, useState } from "react";
import { FINAL_STATUSES, statusReasonLabel, type ApiError } from "@fic/contracts";
import { RefreshCw } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import type { RequestWithResult } from "../lib/api";
import { navigate } from "../lib/router";
import { fmtDateTime, fmtTime, Status } from "../components/Status";
import { EmptyState, ErrorState, Loading } from "../components/States";

/** Heartbeat mais antigo que isto = backoffice sem conexão recente. */
const PRESENCE_WINDOW_MS = 3 * 60_000;

export function RequestsPage() {
  const { api, session } = useAuth();
  const [rows, setRows] = useState<RequestWithResult[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [presence, setPresence] = useState<{ at: string | null } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    const [r, p] = await Promise.all([api.myRequests(), api.backofficePresence()]);
    if (r.ok) {
      setRows(r.data);
      setError(null);
      setUpdatedAt(new Date());
    } else setError(r.error);
    setPresence(p.ok ? { at: p.data } : null);
    setRefreshing(false);
  }, [api]);

  useEffect(() => {
    void load();
    const unsub = api.subscribeMyRequests(() => void load());
    // Reconsulta periódica: não depende só do Realtime.
    const t = window.setInterval(() => void load(), 30_000);
    return () => {
      unsub();
      window.clearInterval(t);
    };
  }, [api, load]);

  async function cancel(id: string, ref: string) {
    if (!window.confirm(`Cancelar a solicitação ${ref}? Os dados enviados serão excluídos.`)) return;
    setCancelling(id);
    const r = await api.cancel(id);
    setCancelling(null);
    if (!r.ok) setError(r.error);
    void load();
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
          <button className="btn" onClick={() => void load()} disabled={refreshing} aria-busy={refreshing || undefined}>
            <RefreshCw size={14} aria-hidden="true" className={refreshing ? "spin" : undefined} />
            {refreshing ? "Atualizando…" : "Atualizar"}
          </button>
        </div>
      </header>

      {rows === null && error ? (
        <ErrorState message={error.message} onRetry={() => void load()} retrying={refreshing} />
      ) : rows === null ? (
        <Loading label="Carregando solicitações…" />
      ) : (
        <>
          {error && (
            <div className="notice" data-tone="danger" role="alert">
              {error.message} {updatedAt && <>Exibindo os dados de {fmtTime(updatedAt)}.</>}
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
                    return (
                      <tr key={r.id}>
                        <td className="mono" data-label="Operação">
                          {r.public_ref}
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
