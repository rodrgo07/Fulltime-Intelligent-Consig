// Contrato v1 compartilhado entre portal e desktop (espelha supabase/migrations).
// Regras de negócio NÃO ficam aqui: apenas tipos, rótulos e mapeamento de códigos de erro.

export const CONTRACT_VERSION = 1;

export const REQUEST_STATUSES = [
  "received", "queued", "preparing", "running", "awaiting_confirmation", "completed", "failed", "cancelled",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const STATUS_LABEL: Record<RequestStatus, string> = {
  received: "Solicitação recebida",
  queued: "Aguardando processamento",
  preparing: "Em preparação",
  running: "Em execução",
  awaiting_confirmation: "Aguardando confirmação",
  completed: "Concluída",
  failed: "Falha",
  cancelled: "Cancelada",
};

/** Tom visual do estado (o significado nunca depende só da cor: o rótulo sempre aparece). */
export const STATUS_TONE: Record<RequestStatus, "neutral" | "active" | "attention" | "success" | "danger" | "muted"> = {
  received: "neutral",
  queued: "neutral",
  preparing: "active",
  running: "active",
  awaiting_confirmation: "attention",
  completed: "success",
  failed: "danger",
  cancelled: "muted",
};

export const FINAL_STATUSES: readonly RequestStatus[] = ["completed", "failed", "cancelled"];

export type AppRole = "operator" | "admin" | "backoffice";

export type FieldType = "text" | "integer" | "decimal" | "date" | "select" | "cpf" | "email" | "phone";

export type FormField = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  min_length?: number;
  max_length?: number;
  pattern?: string;
  min?: number | string;
  max?: number | string;
  options?: { value: string; label: string }[];
  help?: string;
};

export type FormDefinition = { version: number; title: string; fields: FormField[] };

export type ProposalRequestRow = {
  id: string;
  public_ref: string;
  submitted_by: string;
  owner_operator_id: string;
  form_version: number;
  status: RequestStatus;
  status_reason: string | null;
  received_at: string;
  updated_at: string;
  completed_at: string | null;
  pii_expires_at: string;
  pii_purged_at: string | null;
};

export type ProposalResultRow = {
  request_id: string;
  adhesion_number: string;
  external_operation_id: string | null;
  result_status: string;
  completed_at: string;
  source: "rpa" | "manual";
};

export type SubmitResult = { request_id: string; public_ref: string; status: RequestStatus; duplicate: boolean };

export type FieldError = { field: string | null; code: string };

/** Mensagens para os códigos estáveis devolvidos pelo backend (message do erro). */
export const ERROR_MESSAGE: Record<string, string> = {
  UNAUTHENTICATED: "Sessão expirada. Entre novamente.",
  FORBIDDEN: "Seu acesso não permite esta ação ou está desativado.",
  MFA_REQUIRED: "Confirme o código do autenticador para continuar.",
  RATE_LIMITED: "Muitas solicitações em pouco tempo. Aguarde um minuto.",
  DUPLICATE_REQUEST: "Já existe uma solicitação em andamento com estes mesmos dados.",
  FORM_NOT_CONFIGURED: "O formulário ainda não foi configurado pelo backoffice.",
  FORM_VERSION_OUTDATED: "O formulário foi atualizado. Recarregue a página.",
  PAYLOAD_INVALID: "Revise os campos destacados.",
  PAYLOAD_TOO_LARGE: "Os dados enviados excedem o tamanho permitido.",
  OWNER_NOT_ALLOWED: "Proprietário do cliente não permitido.",
  NOT_CANCELLABLE: "Esta solicitação já está em processamento e não pode ser cancelada.",
  NOT_FOUND: "Registro não encontrado.",
  PII_EXPIRED: "Os dados desta solicitação expiraram pela política de retenção.",
  ADHESION_NUMBER_REQUIRED: "Informe o número de adesão.",
  SIDE_EFFECT_STARTED: "A proposta pode já ter sido criada no Consig; confirme manualmente.",
  INVALID_TRANSITION: "Mudança de estado não permitida.",
  NOT_AWAITING_CONFIRMATION: "A solicitação não está aguardando confirmação.",
  ALREADY_REGISTERED: "Este e-mail já está cadastrado.",
  INVALID_INPUT: "Dados inválidos.",
  NETWORK: "Sem conexão com o servidor. Tente novamente.",
};

export const FIELD_ERROR_MESSAGE: Record<string, string> = {
  REQUIRED: "Campo obrigatório.",
  NOT_A_NUMBER: "Informe um número.",
  NOT_AN_INTEGER: "Informe um número inteiro.",
  NOT_A_STRING: "Valor inválido.",
  BELOW_MIN: "Valor abaixo do mínimo.",
  ABOVE_MAX: "Valor acima do máximo.",
  TOO_LONG: "Texto muito longo.",
  TOO_SHORT: "Texto muito curto.",
  PATTERN_MISMATCH: "Formato inválido.",
  INVALID_CPF: "CPF inválido.",
  INVALID_EMAIL: "E-mail inválido.",
  INVALID_PHONE: "Telefone inválido (DDD + número).",
  INVALID_DATE: "Data inválida.",
  DATE_OUT_OF_RANGE: "Data fora do período permitido.",
  INVALID_OPTION: "Opção inválida.",
  UNKNOWN_FIELD: "Campo não reconhecido.",
};

export type ApiError = { code: string; message: string; fields: FieldError[]; detail?: string };

/** Converte o erro do PostgREST/supabase-js no formato do contrato. */
export function toApiError(err: unknown): ApiError {
  const e = (err ?? {}) as { message?: string; details?: string | null; code?: string; name?: string };
  const raw = e.message ?? "";
  const code = /^[A-Z][A-Z0-9_]+$/.test(raw) ? raw : e.name === "TypeError" || /fetch/i.test(raw) ? "NETWORK" : "UNKNOWN";
  let fields: FieldError[] = [];
  if (code === "PAYLOAD_INVALID" && e.details) {
    try {
      fields = JSON.parse(e.details) as FieldError[];
    } catch {
      fields = [];
    }
  }
  return {
    code,
    message: ERROR_MESSAGE[code] ?? "Não foi possível concluir a operação.",
    fields,
    detail: code === "PAYLOAD_INVALID" ? undefined : (e.details ?? undefined),
  };
}

/** Normaliza o valor digitado antes do envio (máscaras saem; o backend valida). */
export function normalizeFieldValue(field: FormField, raw: string): string | number | null {
  const v = raw.trim();
  if (v === "") return null;
  switch (field.type) {
    case "cpf":
    case "phone":
      return v.replace(/\D/g, "");
    case "integer":
    case "decimal": {
      const n = Number(v.replace(/\./g, "").replace(",", "."));
      return Number.isFinite(n) ? n : v;
    }
    case "email":
      return v.toLowerCase();
    default:
      return v;
  }
}
