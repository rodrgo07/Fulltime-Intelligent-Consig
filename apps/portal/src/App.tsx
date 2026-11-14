import { useEffect, useRef, useState } from "react";
import { LogOut } from "lucide-react";
import { useAuth } from "./auth/AuthProvider";
import { MfaGate } from "./components/MfaGate";
import { ErrorState, Loading } from "./components/States";
import { navigate, usePath } from "./lib/router";
import { useMyRequests } from "./lib/useMyRequests";
import { AdminPage } from "./pages/AdminPage";
import { LoginPage } from "./pages/LoginPage";
import { NewRequestPage } from "./pages/NewRequestPage";
import { RequestsPage } from "./pages/RequestsPage";
import { SetPasswordPage } from "./pages/SetPasswordPage";

const APP_TITLE = "Fulltime Intelligent Consig — Portal";

/** Título da aba por tela (WCAG 2.4.2) — leitores de tela anunciam a troca de página. */
export function pageTitle(name: string | null) {
  return name ? `${name} · ${APP_TITLE}` : APP_TITLE;
}

function AuthMessage({ title, children }: { title: string; children: React.ReactNode }) {
  useEffect(() => { document.title = pageTitle(title); }, [title]);
  return (
    <main className="auth-screen" id="conteudo">
      <section className="auth-panel" aria-labelledby="auth-msg-title">
        <h1 id="auth-msg-title">{title}</h1>
        {children}
      </section>
    </main>
  );
}

export function App() {
  const { loading, session, profile, operator, needsPassword, loadError, refresh, signOut, api } = useAuth();
  // Só operadores têm solicitações: sem operador, o hook não consulta nada.
  const requests = useMyRequests(api, operator ? session?.user.id ?? null : null);
  const newCount = requests.newCount;
  const path = usePath();
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  const [retrying, setRetrying] = useState(false);

  const isAdmin = profile?.role === "admin";
  const nav = [
    ...(operator ? [{ to: "/", label: "Nova solicitação" }, { to: "/solicitacoes", label: "Minhas solicitações" }] : []),
    ...(isAdmin ? [{ to: "/admin", label: "Acessos" }] : []),
  ];

  let page;
  let title: string;
  if (path === "/admin" && isAdmin) [page, title] = [<MfaGate><AdminPage /></MfaGate>, "Acessos"];
  else if (path === "/solicitacoes" && operator) [page, title] = [<RequestsPage data={requests} />, "Minhas solicitações"];
  else if (operator) [page, title] = [<NewRequestPage />, "Nova solicitação"];
  else if (isAdmin) [page, title] = [<MfaGate><AdminPage /></MfaGate>, "Acessos"];
  else [page, title] = [<div className="notice">O portal é destinado a operadores. O backoffice usa o aplicativo desktop.</div>, "Portal"];

  const inShell = !loading && !loadError && !(needsPassword && session) && !!session && !!profile;

  // Título com o contador de propostas novas, ex.: "(2) Minhas solicitações · …".
  useEffect(() => {
    if (inShell) document.title = (newCount > 0 ? `(${newCount}) ` : "") + pageTitle(title);
  }, [title, inShell, newCount]);

  // Troca de página: leva o foco ao conteúdo (não na primeira carga).
  useEffect(() => {
    if (!inShell) return;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [path, title, inShell]);

  if (loading) {
    return <main className="boot" id="conteudo"><Loading label="Carregando o portal…" /></main>;
  }
  if (needsPassword && session) return <SetPasswordPage />;
  if (!session) return <LoginPage />;
  if (loadError) {
    return (
      <AuthMessage title="Não foi possível carregar seu acesso">
        <ErrorState title="Falha de comunicação" message={loadError.message} retrying={retrying}
          onRetry={async () => { setRetrying(true); await refresh(); setRetrying(false); }} />
        <button className="btn-link" onClick={() => void signOut()}>Sair</button>
      </AuthMessage>
    );
  }
  if (!profile) {
    return (
      <AuthMessage title="Acesso não liberado">
        <p className="muted">Seu usuário está desativado ou ainda não foi cadastrado por um administrador.</p>
        <button className="btn" onClick={() => void signOut()}>Sair</button>
      </AuthMessage>
    );
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#conteudo">Pular para o conteúdo</a>
      <header className="topbar">
        <div className="brand">
          <img src="/fulltime.png" alt="Fulltime" />
          <span className="brand-name">Intelligent Consig</span>
        </div>
        <nav aria-label="Principal">
          {nav.map((n) => (
            <a key={n.to} href={n.to} aria-current={path === n.to ? "page" : undefined}
              onClick={(e) => { e.preventDefault(); navigate(n.to); }}>
              {n.to === "/solicitacoes" && newCount > 0 && <span className="nav-count" aria-hidden="true">({newCount}) </span>}
              {n.label}
              {n.to === "/solicitacoes" && newCount > 0 && (
                <span className="visually-hidden">, {newCount} {newCount === 1 ? "proposta nova" : "propostas novas"}</span>
              )}
            </a>
          ))}
        </nav>
        <div className="who">
          <span>{profile.display_name}</span>
          {operator && <span className="mono muted">{operator.operator_code}</span>}
          <button className="btn btn-sm" onClick={() => void signOut()} aria-label="Sair" title="Sair"><LogOut size={14} aria-hidden="true" /></button>
        </div>
      </header>
      <main className="content" id="conteudo" ref={mainRef} tabIndex={-1}>{page}</main>
      {/* Aviso em tempo real de proposta gerada (o operador não recebe mais e-mail). */}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{requests.announcement}</div>
    </div>
  );
}
