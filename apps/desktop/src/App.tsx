import { useCallback, useEffect, useState } from "react";
import { Activity, LayoutGrid, LogOut, Settings as SettingsIcon } from "lucide-react";
import { Intro } from "./intro/Intro";
import { call, type AppConfig, type AppInfo, type AuthStatus } from "./lib/ipc";
import { Automation } from "./screens/Automation";
import { Dashboard } from "./screens/Dashboard";
import { Login } from "./screens/Login";
import { Settings } from "./screens/Settings";

type Screen = "dashboard" | "automation" | "settings";

const NAV: { id: Screen; label: string; icon: typeof Activity }[] = [
  { id: "dashboard", label: "Painel", icon: LayoutGrid },
  { id: "automation", label: "Central de automação", icon: Activity },
  { id: "settings", label: "Configurações", icon: SettingsIcon },
];

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [introDone, setIntroDone] = useState(false);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    call<AppInfo>("app_info").then(setInfo);
    call<AppConfig>("config_get").then((c) => setPaused(c.worker_paused));
  }, []);

  // Recarrega o estado de autenticação periodicamente (sessão pode expirar/ser revogada).
  const refreshAuth = useCallback(() => call<AuthStatus>("auth_status").then(setAuth), []);
  useEffect(() => {
    void refreshAuth();
    const t = window.setInterval(refreshAuth, 15000);
    return () => window.clearInterval(t);
  }, [refreshAuth]);

  const finishIntro = useCallback(() => {
    setIntroDone(true);
    void call("intro_mark_seen");
  }, []);

  if (!info) return <div className="boot" />;
  if (!introDone) return <Intro canSkip={info.intro_seen} onDone={finishIntro} />;
  if (!auth) return <div className="boot" />;
  if (auth.state !== "signed_in") return <Login status={auth} onChange={setAuth} />;

  async function togglePause() {
    await call("worker_set_paused", { paused: !paused });
    setPaused(!paused);
  }

  return (
    <div className="app">
      <aside className="rail">
        <div className="rail-brand">
          <span className="brand-chip"><img src="/fulltime.png" alt="Fulltime" /></span>
          <span className="rail-product">Intelligent<br />Consig</span>
        </div>
        <nav aria-label="Principal">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} className="rail-item" aria-current={screen === id ? "page" : undefined} onClick={() => setScreen(id)}>
              <Icon size={16} strokeWidth={1.75} /> <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          <span className="status" data-tone={paused ? "attention" : "success"}>{paused ? "Fila pausada" : "Fila ativa"}</span>
          <span className="rail-user" title={auth.email}>{auth.email}</span>
          <span className="mono muted small">v{info.version} · {info.channel}</span>
          <button className="rail-item" onClick={() => void call("auth_logout").then(refreshAuth)}>
            <LogOut size={16} strokeWidth={1.75} /> <span>Sair da conta</span>
          </button>
        </div>
      </aside>
      <main className="main">
        {screen === "dashboard" && <Dashboard auth={auth} info={info} paused={paused} onTogglePause={() => void togglePause()} />}
        {screen === "automation" && <Automation />}
        {screen === "settings" && <Settings info={info} />}
      </main>
    </div>
  );
}
