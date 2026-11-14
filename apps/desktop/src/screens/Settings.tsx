import { useCallback, useEffect, useState } from "react";
import { ErrorState, Loading } from "../components/States";
import { call, errorMessage, fmt, type AppConfig, type AppInfo, type UpdateCheck } from "../lib/ipc";

type AiStatus = {
  state: string; enabled: boolean; model: string | null; runtime_version: string; runtime_installed: boolean; loaded: boolean;
  installing?: boolean; recommended_model: string | null; last_error: string | null;
  hardware: { total_ram_mb: number; available_ram_mb: number; cpu_count: number; cpu_percent: number };
  candidates: { name: string; approx_ram_mb: number; note: string }[];
};
type LogLine = { timestamp?: string; level?: string; target?: string; fields?: { message?: string } };

const TABS = ["Conexão", "Motor RPA", "IA local", "Inicialização", "Atualizações", "Logs", "Instalação"] as const;
export type SettingsTab = (typeof TABS)[number];

export function Settings({ info, tab, onTabChange }: { info: AppInfo | null; tab: SettingsTab; onTabChange: (t: SettingsTab) => void }) {
  const setTab = onTabChange;
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);

  const loadCfg = useCallback(() => {
    setCfgError(null);
    call<AppConfig>("config_get").then(setCfg).catch((e) => setCfgError(errorMessage(e)));
  }, []);
  useEffect(loadCfg, [loadCfg]);

  async function save(patch: Partial<AppConfig> | Record<string, unknown>) {
    setMsg(null);
    try {
      setCfg(await call<AppConfig>("config_update", { patch }));
      setMsg({ tone: "success", text: "Configuração salva." });
    } catch (e) {
      setMsg({ tone: "danger", text: errorMessage(e) });
    }
  }

  return (
    <section className="screen">
      <header className="screen-head"><div><p className="eyebrow">Configurações</p><h1>{tab}</h1></div></header>
      <nav className="filters" aria-label="Seções das configurações">
        {TABS.map((t) => <button key={t} aria-current={tab === t ? "true" : undefined} onClick={() => { setTab(t); setMsg(null); }}>{t}</button>)}
      </nav>
      {msg && <div className="notice" data-tone={msg.tone} role={msg.tone === "danger" ? "alert" : "status"}>{msg.text}</div>}
      {cfgError && !cfg && <ErrorState title="Não foi possível ler as configurações" message={cfgError} onRetry={loadCfg} />}
      {!cfg && !cfgError && <Loading label="Carregando configurações…" />}
      {cfg && (
        <div className="settings-body">
          {tab === "Conexão" && <Connection cfg={cfg} save={save} />}
          {tab === "Motor RPA" && <Engine cfg={cfg} save={save} />}
          {tab === "IA local" && <Ai cfg={cfg} save={save} />}
          {tab === "Inicialização" && <Startup cfg={cfg} save={save} />}
          {tab === "Atualizações" && <Updates info={info} />}
          {tab === "Logs" && <Logs cfg={cfg} save={save} />}
          {tab === "Instalação" && <Install />}
        </div>
      )}
    </section>
  );
}

type SP = { cfg: AppConfig; save: (p: Record<string, unknown>) => Promise<void> };

function Connection({ cfg, save }: SP) {
  const [url, setUrl] = useState(cfg.supabase_url);
  const [anon, setAnon] = useState("");
  return (
    <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save({ supabase_url: url.trim(), ...(anon ? { supabase_anon_key: anon.trim() } : {}) }); setAnon(""); }}>
      <div className="field"><label htmlFor="su">URL do projeto Supabase</label>
        <input id="su" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
      <div className="field"><label htmlFor="sk">Chave publicável (sb_publishable_… ou anon legada)</label>
        <input id="sk" className="input mono" type="password" placeholder={cfg.supabase_anon_key || "não definida"} value={anon} onChange={(e) => setAnon(e.target.value)} autoComplete="off" />
        <span className="hint">Exibida mascarada. Deixe em branco para manter. Chaves secretas (sb_secret_… ou service_role) são recusadas.</span></div>
      <p className="muted small">Alterar a conexão encerra a sessão atual do backoffice.</p>
      <div><button className="btn btn-primary">Salvar</button></div>
    </form>
  );
}

function Engine({ cfg, save }: SP) {
  const [url, setUrl] = useState(cfg.consig_start_url);
  const [poll, setPoll] = useState(cfg.poll_interval_s);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="stack">
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save({ consig_start_url: url.trim(), poll_interval_s: poll }); }}>
        <div className="field"><label htmlFor="cu">Endereço inicial do Consig</label>
          <input id="cu" className="input mono" placeholder="https://… (fornecido no mapeamento)" value={url} onChange={(e) => setUrl(e.target.value)} />
          <span className="hint">Aberto no Google Chrome controlado para o login humano. Pendente de mapeamento.</span></div>
        <div className="field"><label htmlFor="pi">Intervalo de consulta da fila (s)</label>
          <input id="pi" className="input mono" type="number" min={10} max={600} value={poll} onChange={(e) => setPoll(Number(e.target.value))} />
          <span className="hint">Intervalo da consulta à fila (único meio de receber solicitações novas).</span></div>
        <div><button className="btn btn-primary">Salvar</button></div>
      </form>
      <div className="btn-row">
        <button className="btn" onClick={() => void call("consig_session_open").catch((e) => setErr(errorMessage(e)))}>Abrir Consig no navegador controlado</button>
        <button className="btn" onClick={() => void call("engine_restart").catch((e) => setErr(errorMessage(e)))}>Reiniciar motor</button>
      </div>
      {err && <div className="notice" data-tone="danger" role="alert">{err}</div>}
      <div className="notice" data-tone="attention">
        O fluxo de geração de propostas no Consig ainda não foi mapeado. O motor está pronto (execução, sessão única, timeouts,
        recuperação e ponto sem retorno), mas não reserva solicitações até que o fluxo real seja implementado.
      </div>
    </div>
  );
}

function Ai({ cfg, save }: SP) {
  const [st, setSt] = useState<AiStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => call<AiStatus>("ai_status").then(setSt).catch((e) => setErr(errorMessage(e)));
  useEffect(() => {
    void load();
    const t = window.setInterval(load, 4000);
    return () => window.clearInterval(t);
  }, []);
  const ai = cfg.ai;
  return (
    <div className="stack">
      <div className="notice">Componente opcional e local: só é carregado quando o RPA encontra uma situação não prevista, sugere uma ação de uma
        lista fechada e é descarregado em seguida. Nunca envia dados para APIs externas. Desativado por padrão.</div>
      {!st && !err && <Loading label="Consultando a IA local…" />}
      {st && (
        <dl className="kv">
          <div><dt>Estado</dt><dd>{st.state}{st.installing ? " · instalando…" : ""}</dd></div>
          <div><dt>Runtime (Ollama portátil)</dt><dd className="mono">v{st.runtime_version} · {st.runtime_installed ? "instalado" : "não instalado"}</dd></div>
          <div><dt>Hardware</dt><dd className="mono">{st.hardware.total_ram_mb} MB RAM · {st.hardware.available_ram_mb} MB livres · {st.hardware.cpu_count} CPUs</dd></div>
          <div><dt>Modelo recomendado</dt><dd className="mono">{st.recommended_model ?? "nenhum cabe com folga"}</dd></div>
          <div><dt>Carregado agora</dt><dd>{st.loaded ? "sim" : "não"}</dd></div>
          {st.last_error && <div><dt>Último erro</dt><dd className="mono">{st.last_error}</dd></div>}
        </dl>
      )}
      <div className="form-grid">
        <label className="check"><input type="checkbox" checked={ai.enabled} onChange={(e) => void save({ ai: { enabled: e.target.checked } })} /> Habilitar IA local</label>
        <div className="field"><label htmlFor="m">Modelo</label>
          <select id="m" className="input" value={ai.model ?? ""} onChange={(e) => void save({ ai: { model: e.target.value || null } })}>
            <option value="">Nenhum</option>
            {st?.candidates.map((c) => <option key={c.name} value={c.name}>{c.name} · ~{c.approx_ram_mb} MB · {c.note}</option>)}
          </select></div>
        <div className="field"><label htmlFor="to">Timeout de inferência (s)</label>
          <input id="to" className="input mono" type="number" min={5} max={600} defaultValue={ai.timeout_s} onBlur={(e) => void save({ ai: { timeout_s: Number(e.target.value) } })} /></div>
        <div className="field"><label htmlFor="ram">RAM livre mínima (MB)</label>
          <input id="ram" className="input mono" type="number" min={256} defaultValue={ai.min_free_ram_mb} onBlur={(e) => void save({ ai: { min_free_ram_mb: Number(e.target.value) } })} /></div>
        <div className="field"><label htmlFor="cpu">CPU máxima para iniciar (%)</label>
          <input id="cpu" className="input mono" type="number" min={1} max={100} defaultValue={ai.max_cpu_percent} onBlur={(e) => void save({ ai: { max_cpu_percent: Number(e.target.value) } })} /></div>
        <div className="field"><label htmlFor="conf">Confiança mínima</label>
          <input id="conf" className="input mono" type="number" step={0.05} min={0.5} max={1} defaultValue={ai.min_confidence} onBlur={(e) => void save({ ai: { min_confidence: Number(e.target.value) } })} /></div>
      </div>
      <div className="btn-row">
        <button className="btn" disabled={busy || st?.runtime_installed || st?.installing}
          onClick={() => { if (window.confirm("Baixar o Ollama portátil oficial (~1,6 GB) e conferir o SHA-256?")) void call("ai_install").then(load).catch((e) => setErr(errorMessage(e))); }}>
          Instalar runtime</button>
        <button className="btn" disabled={busy || !st?.runtime_installed || !ai.model}
          onClick={async () => { setBusy(true); try { await call("ai_pull", { model: ai.model }); } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); void load(); } }}>
          {busy ? "Baixando modelo…" : "Baixar modelo selecionado"}</button>
      </div>
      {err && <div className="notice" data-tone="danger" role="alert">{err}</div>}
    </div>
  );
}

function Startup({ cfg, save }: SP) {
  return (
    <div className="form-grid">
      <label className="check"><input type="checkbox" checked={cfg.autostart} onChange={(e) => void save({ autostart: e.target.checked })} /> Iniciar com o Windows</label>
      <label className="check"><input type="checkbox" checked={cfg.start_minimized} onChange={(e) => void save({ start_minimized: e.target.checked })} /> Iniciar minimizado na bandeja</label>
      <div className="field"><label htmlFor="sh">Validade máxima da sessão (horas)</label>
        <input id="sh" className="input mono" type="number" min={1} max={168} defaultValue={cfg.session_max_hours} onBlur={(e) => void save({ session_max_hours: Number(e.target.value) })} />
        <span className="hint">Após este prazo, novo login com MFA é exigido.</span></div>
      <p className="muted small">Fechar a janela mantém o app na bandeja processando a fila. Use “Sair” no menu da bandeja para encerrar.</p>
    </div>
  );
}

function Updates({ info }: { info: AppInfo | null }) {
  const [res, setRes] = useState<UpdateCheck | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setErr(null);
    setChecking(true);
    try { setRes(await call<UpdateCheck>("update_check")); } catch (e) { setErr(errorMessage(e)); } finally { setChecking(false); }
  }, []);
  // Ao abrir a aba já mostra a versão disponível (vinda do aviso de atualização, por exemplo).
  useEffect(() => void check(), [check]);

  return (
    <div className="stack">
      <dl className="kv">
        <div><dt>Versão instalada</dt><dd className="mono">{info?.version}</dd></div>
        <div><dt>Canal</dt><dd className="mono">{info?.channel}</dd></div>
        <div><dt>Versão disponível</dt><dd className="mono" aria-live="polite">
          {checking ? "verificando…" : res ? res.available ? <span className="status" data-tone="attention">{res.available}</span> : "nenhuma" : "—"}
        </dd></div>
      </dl>
      {res?.notes && <><h2 className="section-title">Novidades</h2><pre className="notes">{res.notes}</pre></>}
      <div className="btn-row">
        <button className="btn" disabled={busy || checking} onClick={() => void check()}>{checking ? "Verificando…" : "Verificar agora"}</button>
        <button className="btn btn-primary" disabled={busy || !res?.available}
          onClick={async () => {
            if (!window.confirm(`Instalar a versão ${res?.available}? O app será reiniciado.`)) return;
            setBusy(true);
            try { await call("update_install"); } catch (e) { setErr(errorMessage(e)); setBusy(false); }
          }}>{busy ? "Instalando…" : "Baixar, verificar e instalar"}</button>
      </div>
      <p className="muted small">Somente releases assinadas são aceitas: a assinatura é verificada com a chave pública embutida antes da instalação.
        A instalação nunca ocorre durante a execução de uma proposta.</p>
      {err && <div className="notice" data-tone="danger" role="alert">{err}</div>}
    </div>
  );
}

function Logs({ cfg, save }: SP) {
  const [level, setLevel] = useState("INFO");
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const load = () => call<LogLine[]>("logs_tail", { level, limit: 400 })
      .then((l) => { setLines(l); setErr(null); })
      .catch((e) => setErr(errorMessage(e)));
    void load();
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, [level]);
  return (
    <div className="stack">
      <div className="btn-row">
        <label className="field inline"><span>Exibir a partir de</span>
          <select className="input" value={level} onChange={(e) => setLevel(e.target.value)}>
            {["DEBUG", "INFO", "WARNING", "ERROR"].map((l) => <option key={l}>{l}</option>)}
          </select></label>
        <label className="field inline"><span>Nível gravado</span>
          <select className="input" value={cfg.log_level} onChange={(e) => void save({ log_level: e.target.value })}>
            {["DEBUG", "INFO", "WARNING", "ERROR"].map((l) => <option key={l}>{l}</option>)}
          </select></label>
      </div>
      <p className="muted small">Logs técnicos com identificadores de operação; dados pessoais são omitidos/redigidos. Retenção local: 30 dias.</p>
      {err && <div className="notice" data-tone="danger" role="alert">Não foi possível ler os logs: {err}</div>}
      {/* aria-live off: atualiza a cada 3 s; anunciar cada linha tornaria o leitor de tela inutilizável. */}
      <div className="log-view mono" role="log" aria-label="Logs técnicos" aria-live="off" tabIndex={0}>
        {lines === null && !err && <span className="muted">Carregando…</span>}
        {lines?.map((l, i) => (
          <div key={i} className="log-line" data-level={l.level}>
            <span className="muted">{l.timestamp ? fmt(l.timestamp) : ""}</span> <b>{l.level}</b> <span className="muted">{l.target}</span> {l.fields?.message}
          </div>
        ))}
        {lines?.length === 0 && <span className="muted">Nenhum registro neste nível.</span>}
      </div>
    </div>
  );
}

function Install() {
  const [d, setD] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    setErr(null);
    call<Record<string, unknown>>("diagnostics").then(setD).catch((e) => setErr(errorMessage(e)));
  }, []);
  useEffect(load, [load]);
  if (err) return <ErrorState title="Não foi possível obter o diagnóstico" message={err} onRetry={load} />;
  if (!d) return <Loading label="Coletando diagnóstico…" />;
  const yes = (v: unknown) => (v === true ? "sim" : v === false ? "não" : v == null ? "—" : String(v));
  return (
    <dl className="kv">
      {[
        ["Versão", d.app_version], ["Canal", d.channel], ["Sistema", d.os], ["RAM total (MB)", d.total_ram_mb],
        ["RAM disponível (MB)", d.available_ram_mb], ["CPUs", d.cpu_count], ["Google Chrome instalado", yes(d.chrome_installed)],
        ["Supabase configurado", yes(d.supabase_configured)], ["Supabase acessível", yes(d.supabase_reachable)],
        ["PID do motor", d.engine_pid ?? "—"], ["Executável do motor", d.engine_path],
        ["Pasta de dados", d.data_dir], ["Pasta de logs", d.log_dir], ["Resultados pendentes", d.pending_results],
      ].map(([k, v]) => <div key={String(k)}><dt>{String(k)}</dt><dd className="mono">{String(v)}</dd></div>)}
    </dl>
  );
}
