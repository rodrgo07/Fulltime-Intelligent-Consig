// Única porta da interface para o processo nativo. A UI não fala com o Supabase diretamente:
// tokens e regras ficam no Rust/banco.
import { invoke } from "@tauri-apps/api/core";
import { ERROR_MESSAGE, type RequestStatus } from "@fic/contracts";

export type IpcError = { code: string; detail?: string | null };

const DESKTOP_MESSAGES: Record<string, string> = {
  SUPABASE_NOT_CONFIGURED: "Conexão com o Supabase não configurada.",
  INVALID_CREDENTIALS: "E-mail ou senha inválidos.",
  INVALID_TOTP: "Código do autenticador inválido.",
  MFA_NOT_ENROLLED: "Nenhum autenticador cadastrado.",
  SESSION_EXPIRED: "Sessão expirada pelo prazo de segurança. Entre novamente.",
  SESSION_REVOKED: "Sessão revogada. Entre novamente.",
  SERVICE_ROLE_FORBIDDEN: "Chave service_role não é permitida no aplicativo. Use a chave pública (anon).",
  INVALID_SUPABASE_URL: "URL do Supabase inválida (use https://<projeto>.supabase.co).",
  INVALID_ANON_KEY: "Chave pública inválida.",
  INVALID_CONSIG_URL: "A URL do Consig deve começar com https://.",
  ENGINE_UNAVAILABLE: "Motor RPA indisponível.",
  ENGINE_NOT_FOUND: "Executável do motor RPA não encontrado.",
  WORKFLOW_NOT_READY: "Fluxo do Consig ainda não implementado.",
  BROWSER_MISSING: "Google Chrome não encontrado neste computador.",
  JOB_RUNNING: "Há uma proposta em execução. Aguarde a conclusão.",
  UPDATER_NOT_CONFIGURED: "Atualização automática não configurada neste build (sem chave pública/endpoint).",
  UPDATE_CHECK_FAILED: "Não foi possível verificar atualizações.",
  UPDATE_INSTALL_FAILED: "A atualização foi recusada ou falhou. Nada foi alterado.",
  NO_UPDATE: "Nenhuma atualização disponível.",
  MODEL_NOT_IN_MANIFEST: "Modelo fora da lista aprovada.",
  AI_RUNTIME_MISSING: "Runtime da IA local não instalado.",
  CREDENTIAL_STORE_UNAVAILABLE: "Credential Manager do Windows indisponível.",
  INVALID_ID: "Identificador inválido.",
  UNKNOWN_SETTING: "Configuração desconhecida.",
};

export function errorMessage(e: unknown): string {
  const code = (e as IpcError)?.code ?? "UNKNOWN";
  return DESKTOP_MESSAGES[code] ?? ERROR_MESSAGE[code] ?? `Erro: ${code}`;
}

export const call = <T,>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args);

export type AuthStatus =
  | { state: "signed_out" }
  | { state: "mfa_required"; has_factor: boolean }
  | { state: "signed_in"; email: string; user_id: string; login_epoch: number };

export type CurrentJob = { job_id: string; request_id: string; public_ref: string; step: string | null; side_effect: boolean; started_at: number };

export type WorkerStatus = {
  engine_state: string;
  engine_version: string | null;
  workflow_ready: boolean;
  consig_session: string;
  ai_state: string;
  supabase_reachable: boolean | null;
  last_cycle_at: number | null;
  last_error: string | null;
  blocked_reason: string | null;
  current: CurrentJob | null;
  pending_results: number;
  processed_since_start: number;
};

export type Dashboard = {
  counts: Record<RequestStatus, number>;
  storage: { database_bytes: number; limit_bytes: number; pii_rows: number; tables: Record<string, number> } | null;
  worker: WorkerStatus;
  realtime_connected: boolean;
  recent_activity: { occurred_at: string; action: string; actor_role: string | null; request_id: string | null }[];
};

export type JobRow = {
  id: string; attempt: number; status: string; current_step: string | null; error_code: string | null;
  error_message: string | null; created_at: string; finished_at: string | null; side_effect_started_at: string | null;
};

export type RequestRow = {
  id: string; public_ref: string; status: RequestStatus; status_reason: string | null; received_at: string;
  updated_at: string; completed_at: string | null; pii_expires_at: string; pii_purged_at: string | null; form_version: number;
  submitter: { operator_code: string } | null; owner: { operator_code: string } | null;
  proposal_results: { adhesion_number: string; result_status: string; completed_at: string; source: string } | null;
  automation_jobs: JobRow[];
};

export type AppConfig = {
  supabase_url: string; supabase_anon_key: string; consig_start_url: string; poll_interval_s: number;
  log_level: "DEBUG" | "INFO" | "WARNING" | "ERROR"; autostart: boolean; start_minimized: boolean; intro_seen: boolean;
  session_max_hours: number; worker_paused: boolean;
  ai: { enabled: boolean; model: string | null; timeout_s: number; min_free_ram_mb: number; max_cpu_percent: number; min_confidence: number };
};

export type AppInfo = { version: string; channel: string; identifier: string; data_dir: string; log_dir: string; intro_seen: boolean };

export const BLOCKED_LABEL: Record<string, string> = {
  SUPABASE_NOT_CONFIGURED: "Conexão com o Supabase não configurada.",
  NOT_SIGNED_IN: "Backoffice não autenticado.",
  PAUSED: "Fila pausada manualmente.",
  BUSY: "Executando uma proposta.",
  PENDING_RESULTS: "Há resultados aguardando confirmação no servidor.",
  ENGINE_UNAVAILABLE: "Motor RPA indisponível.",
  WORKFLOW_NOT_READY: "Fluxo do Consig ainda não implementado. As solicitações permanecem aguardando processamento.",
  CONSIG_SESSION_REQUIRED: "Sessão do Consig não autenticada. Abra o Consig e faça login no navegador controlado.",
  QUEUE_EMPTY: "Fila vazia.",
};

export const fmt = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" }).format(new Date(iso)) : "—";

export const fmtBytes = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
