import { useState } from "react";
import { REQUEST_STATUSES, STATUS_LABEL, STATUS_TONE, type RequestStatus } from "@fic/contracts";
import { X } from "lucide-react";
import { call, errorMessage, fmt, type RequestRow } from "../lib/ipc";
import { usePolling } from "../lib/usePolling";

type Detail = {
  request: RequestRow | null;
  audit: { occurred_at: string; action: string; actor_role: string | null; details: Record<string, unknown> }[];
  notifications: { status: string; attempts: number; last_error: string | null; sent_at: string | null }[];
};

export function Automation() {
  const [filter, setFilter] = useState<RequestStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error, reload } = usePolling<RequestRow[]>(
    () => call<RequestRow[]>("requests_list", { status: filter, limit: 300 }), 5000, [filter]);

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <p className="eyebrow">Central de automação</p>
          <h1>Solicitações</h1>
        </div>
      </header>

      <nav className="filters" aria-label="Filtrar por estado">
        <button aria-pressed={filter === null} onClick={() => setFilter(null)}>Todas</button>
        {REQUEST_STATUSES.map((s) => (
          <button key={s} aria-pressed={filter === s} onClick={() => setFilter(s)}>{STATUS_LABEL[s]}</button>
        ))}
      </nav>

      {error ? <div className="notice" data-tone="danger">{errorMessage(error)}</div> : null}

      <div className="split">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr><th>Operação</th><th>Recebida</th><th>Remetente</th><th>Proprietário</th><th>Estado</th><th>Tentativa</th><th>Adesão</th></tr>
            </thead>
            <tbody>
              {(data ?? []).map((r) => {
                const lastJob = [...(r.automation_jobs ?? [])].sort((a, b) => b.attempt - a.attempt)[0];
                return (
                  <tr key={r.id} aria-selected={selected === r.id} onClick={() => setSelected(r.id)} className="clickable">
                    <td className="mono">{r.public_ref}</td>
                    <td className="mono">{fmt(r.received_at)}</td>
                    <td className="mono">{r.submitter?.operator_code ?? "—"}</td>
                    <td className="mono">{r.owner?.operator_code ?? "—"}</td>
                    <td><span className="status" data-tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</span>
                      {r.status_reason && <span className="reason mono">{r.status_reason}</span>}</td>
                    <td className="mono">{lastJob?.attempt ?? "—"}</td>
                    <td className="mono">{r.proposal_results?.adhesion_number ?? "—"}</td>
                  </tr>
                );
              })}
              {data && data.length === 0 && <tr><td colSpan={7} className="muted empty">Nenhuma solicitação neste filtro.</td></tr>}
            </tbody>
          </table>
        </div>
        {selected && <DetailPanel id={selected} onClose={() => setSelected(null)} onChanged={reload} />}
      </div>
    </section>
  );
}

function DetailPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data, reload } = usePolling<Detail>(() => call<Detail>("request_detail", { id }), 5000, [id]);
  const [adhesion, setAdhesion] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  const r = data?.request;

  async function act(cmd: string, args: Record<string, unknown>, confirmText: string) {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setMsg(null);
    try {
      await call(cmd, { id, ...args });
      setMsg({ tone: "success", text: "Registrado." });
      void reload();
      onChanged();
    } catch (e) {
      setMsg({ tone: "danger", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="detail" aria-label="Detalhes da solicitação">
      <header className="detail-head">
        <div>
          <p className="eyebrow">Operação</p>
          <h2 className="mono">{r?.public_ref ?? "…"}</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar"><X size={16} /></button>
      </header>
      {r && (
        <>
          <dl className="kv">
            <div><dt>Estado</dt><dd><span className="status" data-tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</span></dd></div>
            <div><dt>Recebida</dt><dd className="mono">{fmt(r.received_at)}</dd></div>
            <div><dt>Remetente / proprietário</dt><dd className="mono">{r.submitter?.operator_code} / {r.owner?.operator_code}</dd></div>
            <div><dt>Formulário</dt><dd className="mono">v{r.form_version}</dd></div>
            <div><dt>Dados pessoais</dt><dd>{r.pii_purged_at ? <>Excluídos em <span className="mono">{fmt(r.pii_purged_at)}</span></> : <>Expiram em <span className="mono">{fmt(r.pii_expires_at)}</span></>}</dd></div>
            {r.proposal_results && <div><dt>Adesão</dt><dd className="mono">{r.proposal_results.adhesion_number} · {r.proposal_results.result_status} ({r.proposal_results.source === "manual" ? "confirmação manual" : "RPA"})</dd></div>}
            {data.notifications[0] && <div><dt>E-mail ao proprietário</dt><dd>{data.notifications[0].status} · {data.notifications[0].attempts} tentativa(s){data.notifications[0].last_error ? ` · ${data.notifications[0].last_error}` : ""}</dd></div>}
          </dl>

          {r.status === "awaiting_confirmation" && (
            <section className="action-box">
              <h3>Confirmação humana</h3>
              <p className="muted small">Confira no Consig se a proposta foi gerada antes de decidir. Reenfileirar só é seguro se nada foi criado.</p>
              <div className="field"><label htmlFor="ade">Número de adesão (se gerada)</label>
                <input id="ade" className="input mono" maxLength={64} value={adhesion} onChange={(e) => setAdhesion(e.target.value)} /></div>
              <div className="field"><label htmlFor="note">Observação técnica (sem dados pessoais)</label>
                <input id="note" className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></div>
              <div className="btn-row">
                <button className="btn btn-primary" disabled={busy || !adhesion.trim()}
                  onClick={() => act("request_resolve", { resolution: "completed", adhesionNumber: adhesion, resultStatus: "GERADA", note }, "Confirmar que a proposta FOI gerada com este número de adesão?")}>
                  Proposta gerada</button>
                <button className="btn" disabled={busy}
                  onClick={() => act("request_resolve", { resolution: "requeue", note }, "Confirmar que NADA foi criado no Consig e reenfileirar?")}>Nada criado — reenfileirar</button>
                <button className="btn btn-danger" disabled={busy}
                  onClick={() => act("request_resolve", { resolution: "failed", note }, "Marcar como falha?")}>Marcar falha</button>
              </div>
            </section>
          )}
          {r.status === "failed" && !r.pii_purged_at && (
            <div className="btn-row">
              <button className="btn" disabled={busy} onClick={() => act("request_requeue", {}, "Reenfileirar esta solicitação?")}>Reenfileirar</button>
            </div>
          )}
          {["received", "queued", "awaiting_confirmation", "failed"].includes(r.status) && (
            <div className="btn-row">
              <button className="btn btn-danger" disabled={busy}
                onClick={() => act("request_cancel", { reason: "Cancelada pelo backoffice" }, "Cancelar e excluir os dados pessoais desta solicitação?")}>Cancelar e excluir dados</button>
            </div>
          )}
          {msg && <div className="notice" data-tone={msg.tone} role="status">{msg.text}</div>}

          <h3 className="section-title">Tentativas</h3>
          <ol className="timeline">
            {[...r.automation_jobs].sort((a, b) => a.attempt - b.attempt).map((j) => (
              <li key={j.id}>
                <span className="mono">#{j.attempt}</span> {j.status}
                {j.current_step && <> · etapa <span className="mono">{j.current_step}</span></>}
                {j.side_effect_started_at && <span className="tag tag-warn">efeito no Consig</span>}
                {j.error_code && <div className="mono small danger">{j.error_code}{j.error_message ? ` — ${j.error_message}` : ""}</div>}
              </li>
            ))}
            {r.automation_jobs.length === 0 && <li className="muted">Nenhuma execução.</li>}
          </ol>

          <h3 className="section-title">Auditoria</h3>
          <ol className="timeline">
            {data.audit.map((a, i) => (
              <li key={i}><span className="mono muted">{fmt(a.occurred_at)}</span> <span className="mono">{a.action}</span> <span className="muted">{a.actor_role}</span></li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}
