import { LogOut } from "lucide-react";
import { useAuth } from "./auth/AuthProvider";
import { MfaGate } from "./components/MfaGate";
import { navigate, usePath } from "./lib/router";
import { AdminPage } from "./pages/AdminPage";
import { LoginPage } from "./pages/LoginPage";
import { NewRequestPage } from "./pages/NewRequestPage";
import { RequestsPage } from "./pages/RequestsPage";
import { SetPasswordPage } from "./pages/SetPasswordPage";

export function App() {
  const { loading, session, profile, operator, needsPassword, signOut } = useAuth();
  const path = usePath();

  if (loading) return <div className="boot" aria-busy="true" />;
  if (needsPassword && session) return <SetPasswordPage />;
  if (!session) return <LoginPage />;
  if (!profile) {
    return (
      <main className="auth-screen">
        <section className="auth-panel">
          <h1>Acesso não liberado</h1>
          <p className="muted">Seu usuário está desativado ou ainda não foi cadastrado por um administrador.</p>
          <button className="btn" onClick={() => void signOut()}>Sair</button>
        </section>
      </main>
    );
  }

  const isAdmin = profile.role === "admin";
  const nav = [
    ...(operator ? [{ to: "/", label: "Nova solicitação" }, { to: "/solicitacoes", label: "Minhas solicitações" }] : []),
    ...(isAdmin ? [{ to: "/admin", label: "Acessos" }] : []),
  ];

  let page;
  if (path === "/admin" && isAdmin) page = <MfaGate><AdminPage /></MfaGate>;
  else if (path === "/solicitacoes" && operator) page = <RequestsPage />;
  else if (operator) page = <NewRequestPage />;
  else if (isAdmin) page = <MfaGate><AdminPage /></MfaGate>;
  else page = <div className="notice">O portal é destinado a operadores. O backoffice usa o aplicativo desktop.</div>;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img src="/fulltime.png" alt="Fulltime" />
          <span className="brand-name">Intelligent Consig</span>
        </div>
        <nav aria-label="Principal">
          {nav.map((n) => (
            <a key={n.to} href={n.to} aria-current={path === n.to ? "page" : undefined}
              onClick={(e) => { e.preventDefault(); navigate(n.to); }}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="who">
          <span>{profile.display_name}</span>
          {operator && <span className="mono muted">{operator.operator_code}</span>}
          <button className="btn btn-sm" onClick={() => void signOut()} aria-label="Sair"><LogOut size={14} /></button>
        </div>
      </header>
      <main className="content">{page}</main>
    </div>
  );
}
