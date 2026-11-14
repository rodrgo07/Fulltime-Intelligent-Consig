// IPC falso do Tauri para testes de tela. Somente dados fictícios.
import { vi } from "vitest";

export type Handler = (args?: Record<string, unknown>) => unknown;

export const DEFAULT_WORKER = {
  engine_state: "ready", engine_version: "0.1.0", workflow_ready: false, consig_session: "closed", ai_state: "disabled",
  supabase_reachable: true, last_cycle_at: null, last_error: null, blocked_reason: "WORKFLOW_NOT_READY", current: null,
  pending_results: 0, processed_since_start: 0,
};

export const DEFAULT_CONFIG = {
  supabase_url: "https://exemplo-teste.supabase.co", supabase_anon_key: "••••", consig_start_url: "", poll_interval_s: 30,
  log_level: "INFO", autostart: true, start_minimized: false, intro_seen: true, session_max_hours: 12, worker_paused: false,
  ai: { enabled: false, model: null, timeout_s: 60, min_free_ram_mb: 2048, max_cpu_percent: 80, min_confidence: 0.8 },
};

export function defaultHandlers(): Record<string, Handler> {
  return {
    app_info: () => ({ version: "0.1.0", channel: "development", identifier: "teste", data_dir: "C:\\teste", log_dir: "C:\\teste\\logs", intro_seen: true }),
    config_get: () => DEFAULT_CONFIG,
    auth_status: () => ({ state: "signed_in", email: "backoffice@example.test", user_id: "00000000-0000-4000-8000-000000000009", login_epoch: 0 }),
    update_check: () => ({ current: "0.1.0", available: null }),
    intro_mark_seen: () => null,
    dashboard: () => ({
      counts: { received: 0, queued: 0, preparing: 0, running: 0, awaiting_confirmation: 0, completed: 0, failed: 0, cancelled: 0 },
      storage: null, worker: DEFAULT_WORKER, recent_activity: [],
    }),
    worker_status: () => DEFAULT_WORKER,
    diagnostics: () => ({ chrome_installed: true }),
    requests_list: () => [],
  };
}

/** Instala o mock: `handlers[cmd]` responde; erro = lançar `{ code }` (formato do AppError serializado). */
export function installTauri(handlers: Record<string, Handler>) {
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    const h = handlers[cmd];
    if (!h) throw { code: "UNKNOWN_COMMAND", detail: cmd };
    return h(args);
  });
  const listeners: Record<string, ((e: { payload: unknown }) => void)[]> = {};
  const listen = vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    (listeners[event] ??= []).push(cb);
    return () => { listeners[event] = (listeners[event] ?? []).filter((x) => x !== cb); };
  });
  const emit = (event: string, payload: unknown) => (listeners[event] ?? []).forEach((cb) => cb({ payload }));
  return { invoke, listen, emit };
}
