import type { ReactNode } from "react";

/** Estados padronizados de tela: carregando, erro (com nova tentativa) e vazio. */

export function Loading({ label = "Carregando…" }: { label?: string }) {
  return (
    <div className="state state-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ title = "Não foi possível carregar", message, onRetry, retrying = false }: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="state" data-tone="danger" role="alert">
      <p className="state-title">{title}</p>
      <p className="state-text">{message}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry} disabled={retrying} aria-busy={retrying || undefined}>
          {retrying ? "Tentando…" : "Tentar novamente"}
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state" data-tone="empty">
      <p className="state-title">{title}</p>
      {children && <p className="state-text">{children}</p>}
      {action}
    </div>
  );
}
