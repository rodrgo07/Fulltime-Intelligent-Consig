import { useState } from "react";
import {
  CONSIG_SESSION_LABEL, REQUEST_STATUSES, STATUS_LABEL, statusReasonLabel, type ApiError, type RequestStatus,
  type RobotCommand,
} from "@fic/contracts";
import { useAuth } from "../../auth/AuthProvider";
import { EmptyState, ErrorState, Loading } from "../../components/States";
import { fmtDateTime, Status } from "../../components/Status";
import type { BackofficeRow, Result } from "../../lib/api";
import { usePoll } from "../../lib/usePoll";
import { setSoundEnabled, soundEnabled, type BackofficeAlerts } from "./useBackofficeAlerts";

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function run(fn: () => Promise<Result<unknown>>, after?: () => unknown) {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setError(r.error);
    else await after?.();
    return r.ok;
  }
  return { busy, error, run };
}

function ActionError({ error }: { error: ApiError | null }) {
  return error ? <p className="field-error" role="alert">{error.message}</p> : null;
}

// ---------------------------------------------------------------- Painel
export function DashboardPage({ alerts }: { alerts: BackofficeAlerts }) {
  const { counts, robot, offline } = alerts;
  if (counts.error && !counts.data) return <ErrorState message={counts.error.message} onRetry={() => void counts.reload()} />;
  if (!counts.data) return <Loading label="Carregando o painel…" />;
  const r = robot.data;
  return (
    <section aria-labelledby="painel-title">
      <h1 id="painel-title">Painel</h1>
      {offline && (
        <div className="notice" data-tone="danger" role="alert">
          Robô sem sinal há mais de 2 minutos. Verifique o PC do backoffice.
        </div>
      )}
      <dl className="counters">
        {REQUEST_STATUSES.map((s) => (
          <div key={s}><dt>{STATUS_LABEL[s]}</dt><dd className="mono">{counts.data?.[s] ?? 0}</dd></div>
        ))}
      </dl>
      <h2>Robô</h2>
      {r ? (
        <dl className="kv">
          <div><dt>Situação</dt><dd>{offline ? "Sem sinal" : r.paused ? "Pausado" : "Ativo"}</dd></div>
          <div><dt>Sessão do Consig</dt><dd>{CONSIG_SESSION_LABEL[r.consig_session]}</dd></div>
          <div><dt>Fluxo do Consig</dt><dd>{r.flow_ready ? "Pronto" : "Não configurado"}</dd></div>
          <div><dt>Etapa atual</dt><dd className="mono">{r.current_step ?? "—"}</dd></div>
          <div><dt>Versão</dt><dd className="mono">{r.version ?? "—"}</dd></div>
          <div><dt>Último sinal</dt><dd>{fmtDateTime(r.last_seen_at)}</dd></div>
        </dl>
      ) : <Loading label="Lendo o estado do robô…" />}
    </section>
  );
}

// ---------------------------------------------------------------- Central de automação
const FILTERS: (RequestStatus | "all")[] = ["awaiting_confirmation", "failed", "queued", "running", "received", "all"];

export function AutomationPage() {
  const { api } = useAuth();
  const [filter, setFilter] = useState<RequestStatus | "all">("awaiting_confirmation");
  const list = usePoll(() => api.requestsByStatus(filter), 5000, [filter]);
  return (
    <section aria-labelledby="auto-title">
      <h1 id="auto-title">Central de automação</h1>
      <div className="tabs" role="tablist" aria-label="Filtrar por estado">
        {FILTERS.map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className="btn btn-sm" onClick={() => setFilter(f)}>
            {f === "all" ? "Todas" : STATUS_LABEL[f]}
          </button>
        ))}
      </div>
      {list.error && !list.data && <ErrorState message={list.error.message} onRetry={() => void list.reload()} />}
      {!list.data && !list.error && <Loading />}
      {list.data && list.data.length === 0 && <EmptyState title="Nada aqui">Nenhuma solicitação neste estado.</EmptyState>}
      {list.data && list.data.length > 0 && (
        <ul className="cards">
          {list.data.map((row) => <RequestCard key={row.id} row={row} onChange={() => void list.reload()} />)}
        </ul>
      )}
    </section>
  );
}

function RequestCard({ row, onChange }: { row: BackofficeRow; onChange: () => void }) {
  const { api } = useAuth();
  const { busy, error, run } = useAction();
  const job = [...(row.automation_jobs ?? [])].sort((a, b) => b.attempt - a.attempt)[0];
  const captured = job?.captured_adhesion_number ?? null;
  const [adhesion, setAdhesion] = useState("");
  const reason = statusReasonLabel(row.status_reason) ?? row.status_reason;

  return (
    <li className="card">
      <div className="card-head">
        <span className="mono">{row.public_ref}</span>
        <Status status={row.status} />
      </div>
      <dl className="kv">
        <div><dt>Recebida</dt><dd>{fmtDateTime(row.received_at)}</dd></div>
        {job && <div><dt>Tentativa</dt><dd className="mono">{job.attempt}{job.current_step ? ` · ${job.current_step}` : ""}</dd></div>}
        {job?.side_effect_started_at && <div><dt>Ponto sem retorno</dt><dd>{fmtDateTime(job.side_effect_started_at)}</dd></div>}
        {reason && <div><dt>Motivo</dt><dd>{reason}</dd></div>}
        {job?.error_message && <div><dt>Erro</dt><dd className="mono small">{job.error_message}</dd></div>}
        {row.proposal_results && <div><dt>Adesão</dt><dd className="mono">{row.proposal_results.adhesion_number}</dd></div>}
        {captured && !row.proposal_results && (
          <div><dt>Número capturado pelo robô</dt><dd className="mono"><strong>{captured}</strong></dd></div>
        )}
      </dl>

      {row.status === "awaiting_confirmation" && (
        <form className="action-box" onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.resolveAwaiting(row.id, "completed", adhesion || captured || ""), onChange);
        }}>
          <p className="muted small">Confira no Consig antes de decidir.{captured ? " O robô já capturou o número: a proposta existe." : ""}</p>
          <label>
            Número de adesão
            <input value={adhesion} onChange={(e) => setAdhesion(e.target.value)} placeholder={captured ?? ""}
              required={!captured} maxLength={64} />
          </label>
          <div className="actions">
            <button className="btn" type="submit" disabled={busy}>Concluir</button>
            {!captured && (
              <>
                <button className="btn" type="button" disabled={busy || !!row.pii_purged_at}
                  onClick={() => void run(() => api.resolveAwaiting(row.id, "requeue"), onChange)}>Reprocessar</button>
                <button className="btn" type="button" disabled={busy}
                  onClick={() => void run(() => api.resolveAwaiting(row.id, "failed"), onChange)}>Marcar falha</button>
              </>
            )}
          </div>
        </form>
      )}
      {row.status === "failed" && !row.pii_purged_at && (
        <div className="actions">
          <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => api.requeueFailed(row.id), onChange)}>
            Reprocessar
          </button>
        </div>
      )}
      {["received", "queued", "awaiting_confirmation", "failed"].includes(row.status) && !captured && (
        <div className="actions">
          <button className="btn btn-sm" disabled={busy} onClick={() => {
            if (window.confirm(`Cancelar ${row.public_ref}? Os dados do cliente serão apagados.`)) {
              void run(() => api.cancelBackoffice(row.id, "Cancelada pelo backoffice"), onChange);
            }
          }}>Cancelar</button>
        </div>
      )}
      <ActionError error={error} />
    </li>
  );
}

// ---------------------------------------------------------------- Robô
const COMMANDS: { kind: RobotCommand; label: string; confirm?: string }[] = [
  { kind: "pause", label: "Pausar" },
  { kind: "resume", label: "Retomar" },
  { kind: "open_consig", label: "Abrir Consig" },
  { kind: "restart", label: "Reiniciar robô", confirm: "Reiniciar o robô agora?" },
];

export function RobotPage({ alerts }: { alerts: BackofficeAlerts }) {
  const { api } = useAuth();
  const { busy, error, run } = useAction();
  const [sent, setSent] = useState<string | null>(null);
  const [sound, setSound] = useState(soundEnabled());
  const r = alerts.robot.data;
  const [model, setModel] = useState("");

  return (
    <section aria-labelledby="robo-title">
      <h1 id="robo-title">Robô</h1>
      <p className="muted">Os comandos vão pelo banco; o robô os recebe em poucos segundos.</p>
      <div className="actions">
        {COMMANDS.map((c) => (
          <button key={c.kind} className="btn" disabled={busy} onClick={() => {
            if (c.confirm && !window.confirm(c.confirm)) return;
            void run(() => api.robotCommand(c.kind), () => setSent(c.label));
          }}>{c.label}</button>
        ))}
      </div>
      <div role="status" aria-live="polite" className="muted small">{sent ? `Comando enviado: ${sent}.` : ""}</div>
      <ActionError error={error} />

      <h2>IA local</h2>
      <p className="muted small">Desligada por padrão. Só é usada em tela inesperada, antes do ponto sem retorno.</p>
      {r && (
        <form className="actions" onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.robotSetAi(!r.ai_enabled, model || r.ai_model), () => alerts.robot.reload());
        }}>
          <label>Modelo <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={r.ai_model ?? ""} maxLength={80} /></label>
          <button className="btn" type="submit" disabled={busy}>{r.ai_enabled ? "Desligar IA" : "Ligar IA"}</button>
        </form>
      )}

      <h2>Avisos</h2>
      <label className="check">
        <input type="checkbox" checked={sound} onChange={(e) => { setSound(e.target.checked); setSoundEnabled(e.target.checked); }} />
        Sinal sonoro quando algo aguardar confirmação ou o robô ficar sem sinal
      </label>
    </section>
  );
}

// ---------------------------------------------------------------- Auditoria
export function AuditPage() {
  const { api } = useAuth();
  const logs = usePoll(() => api.auditLogs(), 15000);
  if (logs.error && !logs.data) return <ErrorState message={logs.error.message} onRetry={() => void logs.reload()} />;
  if (!logs.data) return <Loading />;
  return (
    <section aria-labelledby="audit-title">
      <h1 id="audit-title">Logs de auditoria</h1>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Quando</th><th>Papel</th><th>Ação</th><th>Detalhes</th></tr></thead>
          <tbody>
            {logs.data.map((l) => (
              <tr key={l.id}>
                <td data-label="Quando">{fmtDateTime(l.occurred_at)}</td>
                <td data-label="Papel">{l.actor_role ?? "—"}</td>
                <td data-label="Ação" className="mono">{l.action}</td>
                <td data-label="Detalhes" className="mono small">{JSON.stringify(l.details)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
