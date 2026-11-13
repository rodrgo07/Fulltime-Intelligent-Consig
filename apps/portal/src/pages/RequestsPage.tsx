import { useCallback, useEffect, useState } from "react";
import { FINAL_STATUSES, type ApiError } from "@fic/contracts";
import { RefreshCw } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import type { RequestWithResult } from "../lib/api";
import { fmtDateTime, Status } from "../components/Status";

export function RequestsPage() {
  const { api, session } = useAuth();
  const [rows, setRows] = useState<RequestWithResult[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [presence, setPresence] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [r, p] = await Promise.all([api.myRequests(), api.backofficePresence()]);
    if (r.ok) {
      setRows(r.data);
      setError(null);
    } else setError(r.error);
    if (p.ok) setPresence(p.data);
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

  async function cancel(id: string) {
    if (!window.confirm("Cancelar esta solicitação? Os dados enviados serão excluídos.")) return;
    const r = await api.cancel(id);
    if (!r.ok) setError(r.error);
    void load();
  }

  const online = presence && Date.now() - new Date(presence).getTime() < 3 * 60_000;

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Acompanhamento</p>
          <h1>Minhas solicitações</h1>
        </div>
        <div className="head-actions">
          <span className="status" data-tone={online ? "success" : "muted"}>
            Backoffice {online ? "conectado" : "sem conexão recente"}
          </span>
          <button className="btn" onClick={() => void load()} aria-label="Atualizar"><RefreshCw size={14} /> Atualizar</button>
        </div>
      </header>

      {error && <div className="notice" data-tone="danger" role="alert">{error.message}</div>}
      {rows === null ? (
        <p className="muted">Carregando…</p>
      ) : rows.length === 0 ? (
        <p className="muted">Nenhuma solicitação enviada.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Operação</th>
                <th>Recebida</th>
                <th>Status</th>
                <th>Adesão</th>
                <th>Concluída</th>
                <th><span className="visually-hidden">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono" data-label="Operação">
                    {r.public_ref}
                    {r.owner_operator_id !== session?.user.id && <span className="tag">Remetente</span>}
                  </td>
                  <td data-label="Recebida">{fmtDateTime(r.received_at)}</td>
                  <td data-label="Status"><Status status={r.status} /></td>
                  <td className="mono" data-label="Adesão">{r.proposal_results?.adhesion_number ?? "—"}</td>
                  <td data-label="Concluída">{fmtDateTime(r.completed_at)}</td>
                  <td className="cell-actions">
                    {(r.status === "received" || r.status === "queued") && r.submitted_by === session?.user.id && (
                      <button className="btn btn-danger btn-sm" onClick={() => void cancel(r.id)}>Cancelar</button>
                    )}
                    {r.pii_purged_at && !FINAL_STATUSES.includes(r.status) && (
                      <span className="muted">Dados expirados</span>
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
