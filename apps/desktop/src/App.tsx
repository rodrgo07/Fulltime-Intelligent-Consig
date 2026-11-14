import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Download, ExternalLink, LayoutGrid, LogOut, Settings as SettingsIcon, X } from "lucide-react";
import { ErrorState, Loading } from "./components/States";
import { Intro } from "./intro/Intro";
import { call, errorMessage, onUpdateAvailable, type AppConfig, type AppInfo, type AuthStatus, type UpdateCheck } from "./lib/ipc";
import { Automation } from "./screens/Automation";
import { ConsigSession } from "./screens/ConsigSession";
import { Dashboard } from "./screens/Dashboard";
import { Login } from "./screens/Login";
import { Settings, type SettingsTab } from "./screens/Settings";

export type Screen = "dashboard" | "automation" | "consig" | "settings";

const NAV: { id: Screen; label: string; icon: typeof Activity }[] = [
  { id: "dashboard", label: "Painel", icon: LayoutGrid },
  { id: "automation", label: "Central de automação", icon: Activity },
  { id: "consig", label: "Abrir Consig", icon: ExternalLink },
  { id: "settings", label: "Configurações", icon: SettingsIcon },
];

const APP_TITLE = "Fulltime Intelligent Consig";

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [introDone, setIntroDone] = useState(false);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("Conexão");
  const [paused, setPaused] = useState(false);
  const [update, setUpdate] = useState<string | null>(null);
  const [dismissedUpdate, setDismissedUpdate] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const firstScreen = useRef(true);

  const boot = useCallback(() => {
    setBootError(null);
    call<AppInfo>("app_info").then(setInfo).catch((e) => setBootError(errorMessage(e)));
    call<AppConfig>("config_get").then((c) => setPaused(c.worker_paused)).catch(() => {});
  }, []);
  useEffect(boot, [boot]);

  // Recarrega o estado de autenticação periodicamente (sessão pode expirar/ser revogada).
  const refreshAuth = useCallback(() => call<AuthStatus>("auth_status")
    .then((a) => { setAuth(a); setAuthError(null); })
    .catch((e) => setAuthError(errorMessage(e))), []);
  useEffect(() => {
    void refreshAuth();
    const t = window.setInterval(refreshAuth, 15000);
    return () => window.clearInterval(t);
  }, [refreshAuth]);

  // Atualização: consulta ao abrir + evento `update-available` do Rust (a cada 6 h). Instalação só pelo usuário.
  useEffect(() => {
    call<UpdateCheck>("update_check").then((u) => setUpdate(u.available)).catch(() => {});
    return onUpdateAvailable(setUpdate);
  }, []);

  const finishIntro = useCallback(() => {
    setIntroDone(true);
    void call("intro_mark_seen");
  }, []);

  const go = useCallback((s: Screen, tab?: SettingsTab) => {
    if (tab) setSettingsTab(tab);
    setScreen(s);
  }, []);

  const signedIn = auth?.state === "signed_in";
  const label = NAV.find((n) => n.id === screen)?.label ?? "";

  // Troca de tela: título da janela + foco no conteúdo (leitor de tela anuncia a nova tela).
  useEffect(() => {
    if (!signedIn || !introDone) return;
    document.title = `${label} · ${APP_TITLE}`;
    if (firstScreen.current) {
      firstScreen.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [screen, label, signedIn, introDone]);

  if (bootError) {
    return <main className="boot boot-msg"><ErrorState title="Não foi possível iniciar o aplicativo" message={bootError} onRetry={boot} /></main>;
  }
  if (!info) return <main className="boot boot-msg"><Loading label="Iniciando…" /></main>;
  if (!introDone) return <Intro canSkip={info.intro_seen} onDone={finishIntro} />;
  if (!auth) {
    return (
      <main className="boot boot-msg">
        {authError ? <ErrorState title="Não foi possível verificar a sessão" message={authError} onRetry={() => void refreshAuth()} />
          : <Loading label="Verificando a sessão…" />}
      </main>
    );
  }
  if (auth.state !== "signed_in") return <Login status={auth} onChange={setAuth} />;

  async function togglePause() {
    await call("worker_set_paused", { paused: !paused });
    setPaused(!paused);
  }

  const onUpdatesTab = screen === "settings" && settingsTab === "Atualizações";
  const showUpdate = update && update !== dismissedUpdate && !onUpdatesTab;

  return (
    <div className="app">
      <a className="skip-link" href="#conteudo">Pular para o conteúdo</a>
      <aside className="rail">
        <div className="rail-brand">
          <span className="brand-chip"><img src="/fulltime.png" alt="Fulltime" /></span>
          <span className="rail-product">Intelligent<br />Consig</span>
        </div>
        <nav aria-label="Principal">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} className="rail-item" aria-current={screen === id ? "page" : undefined} onClick={() => go(id)}>
              <Icon size={16} strokeWidth={1.75} aria-hidden="true" /> <span>{label}</span>
              {id === "settings" && update && (
                <span className="rail-badge"><span aria-hidden="true">●</span><span className="visually-hidden">(atualização disponível)</span></span>
              )}
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          <span className="status" data-tone={paused ? "attention" : "success"}>{paused ? "Fila pausada" : "Fila ativa"}</span>
          <span className="rail-user" title={auth.email}>{auth.email}</span>
          <span className="mono muted small">v{info.version} · {info.channel}</span>
          <button className="rail-item" onClick={() => void call("auth_logout").then(refreshAuth)}>
            <LogOut size={16} strokeWidth={1.75} aria-hidden="true" /> <span>Sair da conta</span>
          </button>
        </div>
      </aside>
      <main className="main" id="conteudo" ref={mainRef} tabIndex={-1} aria-label={label}>
        {showUpdate && (
          <div className="update-banner" role="status">
            <Download size={16} aria-hidden="true" />
            <span>
              <strong>Versão {update} disponível.</strong>{" "}
              <span className="muted">A instalação só acontece quando você confirmar, nunca durante uma proposta em execução.</span>
            </span>
            <button className="btn btn-sm btn-primary" onClick={() => go("settings", "Atualizações")}>Ver atualização</button>
            <button className="icon-btn" onClick={() => setDismissedUpdate(update)} aria-label="Dispensar aviso de atualização" title="Dispensar">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
        {screen === "dashboard" && (
          <Dashboard auth={auth} info={info} paused={paused} update={update}
            onTogglePause={() => void togglePause()} onNavigate={go} />
        )}
        {screen === "automation" && <Automation />}
        {screen === "consig" && <ConsigSession onNavigate={go} />}
        {screen === "settings" && <Settings info={info} tab={settingsTab} onTabChange={setSettingsTab} />}
      </main>
    </div>
  );
}
