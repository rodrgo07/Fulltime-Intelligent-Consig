import { useCallback, useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { call, errorMessage, SESSION_LABEL, type AppConfig, type WorkerStatus } from "../lib/ipc";
import { usePolling } from "../lib/usePolling";
import type { Screen } from "../App";
import type { SettingsTab } from "./Settings";

const SESSION_TONE: Record<string, "success" | "attention" | "danger" | "muted"> = {
  authenticated: "success", open_unverified: "attention", expired: "danger", browser_missing: "danger", closed: "muted",
};

/**
 * Abre o Google Chrome controlado pelo motor para o LOGIN HUMANO no Consig.
 * Instruções genéricas de propósito: as telas e etapas do Consig ainda não foram mapeadas (Bloco E).
 */
export function ConsigSession({ onNavigate }: { onNavigate: (s: Screen, tab?: SettingsTab) => void }) {
  const { data: worker, error: workerError } = usePolling<WorkerStatus>(() => call<WorkerStatus>("worker_status"), 3000);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [chrome, setChrome] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "danger" | "success"; text: string } | null>(null);

  useEffect(() => {
    call<AppConfig>("config_get").then(setCfg).catch(() => setCfg(null));
    call<{ chrome_installed?: boolean }>("diagnostics").then((d) => setChrome(d.chrome_installed ?? null)).catch(() => setChrome(null));
  }, []);

  const open = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await call<{ state?: string }>("consig_session_open");
      const state = r?.state ? SESSION_LABEL[r.state] ?? r.state : null;
      setMsg({ tone: "success", text: `Navegador aberto${state ? ` · sessão: ${state}` : ""}. Faça o login na janela do Chrome.` });
    } catch (e) {
      setMsg({ tone: "danger", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }, []);

  const session = worker?.consig_session ?? "unknown";
  const urlConfigured = !!cfg?.consig_start_url;

  return (
    <section className="screen" aria-labelledby="consig-title">
      <header className="screen-head">
        <div>
          <p className="eyebrow">Sessão do Consig</p>
          <h1 id="consig-title">Abrir Consig</h1>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" onClick={() => void open()} disabled={busy || chrome === false} aria-busy={busy || undefined}>
            <ExternalLink size={14} aria-hidden="true" /> {busy ? "Abrindo…" : "Abrir Consig"}
          </button>
        </div>
      </header>

      {msg && <div className="notice" data-tone={msg.tone} role={msg.tone === "danger" ? "alert" : "status"}>{msg.text}</div>}
      {chrome === false && (
        <div className="notice" data-tone="danger" role="alert">
          Google Chrome não encontrado neste computador. Instale o Chrome e volte a esta tela.
        </div>
      )}
      {cfg && !urlConfigured && (
        <div className="notice" data-tone="attention">
          O endereço inicial do Consig ainda não foi configurado (ele será definido no mapeamento do sistema). O Chrome abrirá
          sem página inicial; informe o endereço em{" "}
          <button className="btn-link" onClick={() => onNavigate("settings", "Motor RPA")}>Configurações → Motor RPA</button>.
        </div>
      )}

      <div className="consig-grid">
        <section className="panel" aria-labelledby="consig-steps-title">
          <h2 className="panel-title" id="consig-steps-title">Como entrar</h2>
          <ol className="steps">
            <li>
              Clique em <strong>Abrir Consig</strong>. O app abre o Google Chrome em uma janela própria, com um perfil dedicado ao
              Intelligent Consig (separado do seu Chrome pessoal).
            </li>
            <li>
              Nessa janela, entre no Consig como você faria manualmente, incluindo qualquer verificação adicional que o sistema pedir.
            </li>
            <li>
              Você digita as credenciais direto no site. O Intelligent Consig <strong>não lê, não grava e não envia</strong> sua senha.
            </li>
            <li>
              Depois de entrar, <strong>mantenha essa janela do Chrome aberta</strong>: ela é a sessão usada pela automação. Se ela for
              fechada ou a sessão expirar, a fila para até um novo login.
            </li>
            <li>Volte a esta tela e confira o estado da sessão ao lado.</li>
          </ol>
        </section>

        <section className="panel" aria-labelledby="consig-state-title">
          <h2 className="panel-title" id="consig-state-title">Estado</h2>
          <dl className="kv">
            <div>
              <dt>Sessão do Consig</dt>
              <dd aria-live="polite">
                {worker ? <span className="status" data-tone={SESSION_TONE[session] ?? "muted"}>{SESSION_LABEL[session] ?? session}</span>
                  : workerError ? <span className="danger">{errorMessage(workerError)}</span> : <span className="muted">Consultando…</span>}
              </dd>
            </div>
            <div>
              <dt>Google Chrome</dt>
              <dd>{chrome === null ? <span className="muted">—</span> : chrome ? "Instalado" : <span className="danger">Não encontrado</span>}</dd>
            </div>
            <div>
              <dt>Endereço inicial</dt>
              <dd className="mono">{cfg ? (urlConfigured ? cfg.consig_start_url : <span className="muted">não configurado</span>) : "—"}</dd>
            </div>
            <div>
              <dt>Fluxo de propostas</dt>
              <dd>{worker ? (worker.workflow_ready ? "Implementado" : "Não implementado") : "—"}</dd>
            </div>
          </dl>
          {worker && !worker.workflow_ready && (
            <p className="muted small">
              Enquanto o fluxo do Consig não for mapeado, o app não consegue confirmar o login sozinho: a sessão aparece como
              “Aberta (verificação não mapeada)” e nenhuma solicitação é processada.
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
