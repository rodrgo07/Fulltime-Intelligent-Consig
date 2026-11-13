import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fic/brand/tokens.css";
import "./desktop.css";
import { App } from "./App";

// Sem menu de contexto do navegador: é um app nativo.
window.addEventListener("contextmenu", (e) => {
  if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
