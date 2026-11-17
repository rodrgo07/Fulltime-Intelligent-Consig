import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fic/brand/tokens.css";
import "./portal.css";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { supabase } from "./lib/supabase";

const root = createRoot(document.getElementById("root")!);

root.render(
  <StrictMode>
    {supabase ? (
      <AuthProvider sb={supabase}>
        <App />
      </AuthProvider>
    ) : (
      <main className="auth-screen">
        <section className="auth-panel">
          <p className="eyebrow">Configuração pendente</p>
          <h1>Portal não configurado</h1>
          <p className="muted">
            Defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no ambiente de build (ver apps/portal/.env.example).
          </p>
        </section>
      </main>
    )}
  </StrictMode>,
);
