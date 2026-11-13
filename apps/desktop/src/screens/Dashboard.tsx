import { useEffect, useState } from "react";
import { REQUEST_STATUSES, STATUS_LABEL, STATUS_TONE } from "@fic/contracts";
import { Pause, Play, ExternalLink } from "lucide-react";
import { BLOCKED_LABEL, call, errorMessage, fmt, fmtBytes, type AppInfo, type AuthStatus, type Dashboard as D } from "../lib/ipc";
import { usePolling } from "../lib/usePolling";

const ENGINE_LABEL: Record<string, string> = { ready: "Disponível", starting: "Iniciando", crashed: "Falhou — reiniciando", missing: "Não encontrado" };
const SESSION_LABEL: Record<string, string> = {
  closed: "Fechada", open_unverified: "Aberta (verificação não mapeada)", authenticated: "Autenticada",
  expired: "Expirada", browser_missing: "Chrome ausente", unknown: "—",
};
const AI_LABEL: Record<string, string> = {
  disabled: "Desativada", runtime_missing: "Runtime não instalado", model_not_selected: "Sem modelo", ready: "Pronta (sob demanda)", busy: "Em uso", unknown: "—",
};

export function Dashboard({ auth, info, paused, onTogglePause }: { auth: AuthStatus; info: AppInfo | null; paused: boolean; onTogglePause: () => void }) {
  const { data, error } = usePolling<D>(() => call<D>("dashboard"), 5000);
  const [update, setUpdate] = useState<string | null>(null);

  useEffect(() => {
    call<{ available: string | null }>("update_check").then((u) => setUpdate(u.available)).catch(() => setUpdate(null));
  }, []);

  const w = data?.worker;
  const health: [string, string, "success" | "danger" | "attention" | "muted"][] = w ? [
    ["Supabase", w.supabase_reachable ? "Conectado" : "Sem resposta", w.supabase_reachable ? "success" : "danger"],
    ["Realtime", data!.realtime_connected ? "Inscrito" : "Reconectando (consulta periódica ativa)", data!.realtime_connected ? "success" : "attention"],
    ["Motor RPA", ENGINE_LABEL[w.engine_state] ?? w.engine_state, w.engine_state === "ready" ? "success" : "danger"],
    ["Fluxo do Consig", w.workflow_ready ? "Implementado" : "Não implementado", w.workflow_ready ? "success" : "attention"],
    ["Sessão do Consig", SESSION_LABEL[w.consig_session] ?? w.consig_session, w.consig_session === "authenticated" ? "success" : "muted"],
    ["IA local", AI_LABEL[w.ai_state] ?? w.ai_state, w.ai_state === "ready" ? "success" : "muted"],
  ] : [];

  const storagePct = data?.storage ? Math.min(100, (data.storage.database_bytes / data.storage.limit_bytes) * 100) : 0;

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <p className="eyebrow">Painel</p>
          <h1>Estado da operação</h1>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => void call("consig_session_open").catch((e) => alert(errorMessage(e)))}>
            <ExternalLink size={14} /> Abrir Consig
          </button>
          <button className={`btn ${paused ? "btn-primary" : ""}`} onClick={onTogglePause}>
            {paused ? <><Play size={14} /> Retomar fila</> : <><Pause size={14} /> Pausar fila</>}
          </button>
        </div>
      </header>

      {error ? <div className="notice" data-tone="danger">{errorMessage(error)}</div> : null}

      {w && (
        <div className={`banner ${w.current ? "banner-active" : ""}`}>
          {w.current ? (
            <>
              <span className="status" data-tone="active">Em execução</span>
              <span className="mono">{w.current.public_ref}</span>
              <span className="muted">etapa {w.current.step ?? "—"}</span>
              {w.current.side_effect && <span className="tag tag-warn">ponto sem retorno registrado</span>}
            </>
          ) : (
            <>
              <span className="status" data-tone={w.blocked_reason === "QUEUE_EMPTY" ? "success" : "attention"}>
                {w.blocked_reason === "QUEUE_EMPTY" ? "Pronto" : "Fila parada"}
              </span>
              <span>{BLOCKED_LABEL[w.blocked_reason ?? ""] ?? w.blocked_reason ?? "Aguardando primeiro ciclo."}</span>
            </>
          )}
        </div>
      )}

      <div className="grid-dash">
        <section className="panel">
          <h2 className="panel-title">Solicitações</h2>
          <dl className="counters">
            {REQUEST_STATUSES.map((s) => (
              <div key={s} className="counter">
                <dt><span className="status" data-tone={STATUS_TONE[s]}>{STATUS_LABEL[s]}</span></dt>
                <dd className="mono">{data ? data.counts[s] ?? 0 : "—"}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="panel">
          <h2 className="panel-title">Sistema</h2>
          <dl className="kv">
            {health.map(([k, v, tone]) => (
              <div key={k}><dt>{k}</dt><dd><span className="status" data-tone={tone}>{v}</span></dd></div>
            ))}
            <div><dt>Operador autenticado</dt><dd>{auth.state === "signed_in" ? auth.email : "—"}</dd></div>
          </dl>
        </section>

        <section className="panel">
          <h2 className="panel-title">Instalação</h2>
          <dl className="kv">
            <div><dt>Versão instalada</dt><dd className="mono">{info?.version ?? "—"} <span className="muted">({info?.channel})</span></dd></div>
            <div><dt>Atualização</dt><dd>{update ? <span className="status" data-tone="attention">v{update} disponível</span> : <span className="muted">Nenhuma disponível</span>}</dd></div>
            <div><dt>Último ciclo da fila</dt><dd className="mono">{w?.last_cycle_at ? fmt(new Date(w.last_cycle_at * 1000).toISOString()) : "—"}</dd></div>
            <div><dt>Resultados pendentes de envio</dt><dd className="mono">{w?.pending_results ?? 0}</dd></div>
            <div><dt>Último erro técnico</dt><dd className="mono">{w?.last_error ?? "—"}</dd></div>
          </dl>
        </section>

        <section className="panel">
          <h2 className="panel-title">Armazenamento do Supabase</h2>
          {data?.storage ? (
            <>
              <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(storagePct)}
                aria-label="Uso do armazenamento">
                <span style={{ width: `${storagePct}%` }} data-high={storagePct > 80 || undefined} />
              </div>
              <p className="mono small">{fmtBytes(data.storage.database_bytes)} de {fmtBytes(data.storage.limit_bytes)} ({storagePct.toFixed(1)}%)</p>
              <p className="muted small">Registros com dados pessoais temporários: <span className="mono">{data.storage.pii_rows}</span></p>
            </>
          ) : <p className="muted">—</p>}
        </section>

        <section className="panel panel-wide">
          <h2 className="panel-title">Histórico operacional</h2>
          <table className="table">
            <thead><tr><th>Quando</th><th>Evento</th><th>Origem</th><th>Solicitação</th></tr></thead>
            <tbody>
              {(data?.recent_activity ?? []).map((a, i) => (
                <tr key={i}>
                  <td className="mono">{fmt(a.occurred_at)}</td>
                  <td className="mono">{a.action}</td>
                  <td>{a.actor_role ?? "—"}</td>
                  <td className="mono muted">{a.request_id?.slice(0, 8) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </section>
  );
}
