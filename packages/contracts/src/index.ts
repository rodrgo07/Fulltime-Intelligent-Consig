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

/**
 * Mensagens para os códigos estáveis devolvidos pelo backend (message do erro).
 * Cobre todos os códigos de `supabase/migrations` (verificado em index.test.ts).
 */
export const ERROR_MESSAGE: Record<string, string> = {
  // Autenticação e permissão
  UNAUTHENTICATED: "Sessão expirada. Entre novamente.",
  FORBIDDEN: "Seu acesso não permite esta ação ou está desativado.",
  MFA_REQUIRED: "Confirme o código do autenticador para continuar.",
  NOT_AN_OPERATOR: "Seu usuário não está ativo como operador. Fale com um administrador.",
  CANNOT_CHANGE_SELF: "Você não pode alterar o seu próprio acesso.",
  UNAUTHORIZED: "Chamada não autorizada.",
  // Envio de solicitação
  IDEMPOTENCY_KEY_REQUIRED: "Não foi possível identificar este envio. Recarregue a página e tente de novo.",
  RATE_LIMITED: "Muitas solicitações em pouco tempo. Aguarde um minuto.",
  DUPLICATE_REQUEST: "Já existe uma solicitação em andamento com estes mesmos dados.",
  FORM_NOT_CONFIGURED: "O formulário ainda não foi configurado pelo backoffice.",
  FORM_VERSION_OUTDATED: "O formulário foi atualizado. Recarregue a página.",
  FORM_DEFINITION_INVALID: "A definição do formulário é inválida e não foi publicada.",
  PAYLOAD_INVALID: "Revise os campos destacados.",
  PAYLOAD_TOO_LARGE: "Os dados enviados excedem o tamanho permitido.",
  OWNER_NOT_ALLOWED: "Proprietário do cliente não permitido.",
  // Acompanhamento e decisões do backoffice
  NOT_CANCELLABLE: "Esta solicitação já está em processamento e não pode ser cancelada.",
  NOT_FOUND: "Registro não encontrado.",
  NOT_FAILED: "Só é possível reenfileirar solicitações que estão em falha.",
  PII_EXPIRED: "Os dados desta solicitação expiraram pela política de retenção.",
  ADHESION_NUMBER_REQUIRED: "Informe o número de adesão.",
  SIDE_EFFECT_STARTED: "A proposta pode já ter sido criada no Consig; confirme manualmente.",
  INVALID_TRANSITION: "Mudança de estado não permitida.",
  INVALID_RESOLUTION: "Decisão inválida para esta solicitação.",
  NOT_AWAITING_CONFIRMATION: "A solicitação não está aguardando confirmação.",
  JOB_NOT_FOUND: "Execução não encontrada.",
  JOB_NOT_ACTIVE: "Esta execução já foi encerrada ou a reserva expirou.",
  // Infraestrutura
  INVALID_INPUT: "Dados inválidos.",
  NETWORK: "Sem conexão com o servidor. Tente novamente.",
  UNKNOWN: "Não foi possível concluir a operação.",
};

/**
 * Motivos gravados em `proposal_requests.status_reason` / `automation_jobs.error_code`
 * (banco, motor RPA e app desktop). Texto livre (observações do backoffice) não tem rótulo.
 */
export const STATUS_REASON_LABEL: Record<string, string> = {
  // Banco
  LEASE_EXPIRED: "Reserva expirada; devolvida à fila.",
  PII_EXPIRED: "Dados pessoais expirados pela política de retenção.",
  PII_MISSING: "Dados pessoais indisponíveis para processamento.",
  REQUEUED: "Reenfileirada pelo backoffice.",
  RESOLVED_BY_BACKOFFICE: "Resolvida pelo backoffice.",
  // Motor RPA
  ENGINE_ERROR: "Erro no motor de automação.",
  WORKFLOW_NOT_READY: "Fluxo do Consig ainda não implementado.",
  SESSION_UNAVAILABLE: "Sessão do Consig indisponível; requer login humano.",
  BROWSER_MISSING: "Google Chrome não encontrado no computador do backoffice.",
  STEP_TIMEOUT: "Uma etapa excedeu o tempo limite.",
  STEP_CRASHED: "Uma etapa falhou inesperadamente.",
  INVALID_JOB_DATA: "Os dados da solicitação não atendem ao que o processo exige.",
  JOB_CANCELLED: "Execução cancelada.",
  HOST_REJECTED_SIDE_EFFECT: "O app não confirmou o ponto sem retorno; nada foi enviado.",
  UNEXPECTED_SCREEN: "Tela não prevista; requer confirmação humana.",
  NO_RESULT: "O processo terminou sem número de adesão; requer confirmação humana.",
  NEEDS_HUMAN: "Requer confirmação humana.",
  ENGINE_BUSY: "Motor ocupado com outra execução.",
  CONTRACT_MISMATCH: "Versão do motor incompatível com o app.",
  AI_RUNTIME_MISSING: "Runtime da IA local não instalado.",
  MODEL_NOT_IN_MANIFEST: "Modelo de IA fora da lista aprovada.",
  // App desktop
  ENGINE_CRASHED: "O motor parou durante a execução; nada foi enviado.",
  ENGINE_CRASHED_AFTER_SIDE_EFFECT: "O motor parou depois do ponto sem retorno; confirme no Consig.",
  ENGINE_UNAVAILABLE: "Motor de automação indisponível.",
  ENGINE_TIMEOUT: "O motor não respondeu a tempo.",
  ENGINE_EXITED: "O motor foi encerrado.",
};

/** Rótulo do motivo quando ele é um código conhecido; `null` para texto livre ou código novo. */
export function statusReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return STATUS_REASON_LABEL[reason] ?? null;
}

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

/**
 * Códigos técnicos do PostgREST/Postgres que não são erros de negócio (SQLSTATE ≠ P0001), mas que a
 * interface precisa tratar: JWT expirado/inválido e permissão negada pelo banco.
 */
const TRANSPORT_CODE: Record<string, string> = {
  PGRST301: "UNAUTHENTICATED", // JWT expirado
  PGRST302: "UNAUTHENTICATED", // sem credencial
  PGRST303: "UNAUTHENTICATED", // JWT inválido
  "42501": "FORBIDDEN", // insufficient_privilege
};

/** Converte o erro do PostgREST/supabase-js no formato do contrato. */
export function toApiError(err: unknown): ApiError {
  const e = (err ?? {}) as { message?: string; details?: string | null; code?: string; name?: string };
  const raw = e.message ?? "";
  const code = /^[A-Z][A-Z0-9_]+$/.test(raw)
    ? raw
    : e.code && TRANSPORT_CODE[e.code]
      ? TRANSPORT_CODE[e.code]
      : e.name === "TypeError" || e.name === "FunctionsFetchError" || /fetch|network/i.test(raw)
        ? "NETWORK"
        : "UNKNOWN";
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
    message: ERROR_MESSAGE[code] ?? ERROR_MESSAGE.UNKNOWN,
    fields,
    // Detalhe só para códigos de negócio (ex.: referência em DUPLICATE_REQUEST); nunca texto técnico.
    detail: code === raw && code !== "PAYLOAD_INVALID" ? (e.details ?? undefined) : undefined,
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
