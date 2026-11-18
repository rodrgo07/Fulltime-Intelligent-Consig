// Única camada que fala com o Supabase. Telas não montam queries.
import {
  toApiError, type ApiError, type FormDefinition, type JobRow, type ProposalRequestRow, type ProposalResultRow,
  type RequestStatus, type RobotCommand, type RobotState, type SubmitResult, type AppRole,
} from "@fic/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

// shortcut: tipos das linhas declarados à mão; gerar com `supabase gen types` quando o projeto existir.
async function wrap<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<Result<T>> {
  try {
    const { data, error } = await p;
    if (error) return { ok: false, error: toApiError(error) };
    return { ok: true, data: data as T };
  } catch (e) {
    return { ok: false, error: toApiError(e) };
  }
}

export type Profile = { id: string; role: AppRole; display_name: string; active: boolean };
export type OperatorInfo = { id: string; operator_code: string; notification_email: string };
export type RequestWithResult = ProposalRequestRow & { proposal_results: ProposalResultRow | null };
export type BackofficeRow = RequestWithResult & { automation_jobs: JobRow[] };
export type AuditRow = {
  id: number; occurred_at: string; actor_role: string | null; action: string; request_id: string | null;
  details: Record<string, unknown>;
};

/** Colunas de proposal_requests lidas pelo site (payload_fingerprint fica de fora). */
const REQUEST_COLUMNS = "id, public_ref, submitted_by, owner_operator_id, form_version, status, status_reason, "
  + "received_at, updated_at, completed_at, pii_expires_at, pii_purged_at";
const RESULT_COLUMNS = "proposal_results(request_id, adhesion_number, external_operation_id, result_status, completed_at, source)";
const JOB_COLUMNS = "automation_jobs(id, request_id, attempt, status, current_step, side_effect_started_at, error_code, "
  + "error_message, captured_adhesion_number, created_at)";

export function createApi(sb: SupabaseClient) {
  return {
    // maybeSingle: perfil ausente/oculto pelo RLS (desativado) é `null`, não erro — erro é só falha real.
    myProfile: (uid: string) =>
      wrap<Profile | null>(sb.from("profiles").select("id, role, display_name, active").eq("id", uid).maybeSingle()),

    myOperator: (uid: string) =>
      wrap<OperatorInfo | null>(sb.from("operators").select("id, operator_code, notification_email").eq("id", uid).maybeSingle()),

    activeForm: () =>
      wrap<FormDefinition | null>(sb.from("form_definitions").select("version, title, fields").eq("active", true).maybeSingle()),

    submit: async (idempotencyKey: string, formVersion: number, payload: Record<string, unknown>): Promise<Result<SubmitResult>> => {
      const r = await wrap<SubmitResult | { error: string }>(sb.rpc("submit_proposal_request", {
        p_idempotency_key: idempotencyKey,
        p_form_version: formVersion,
        p_payload: payload,
      }));
      // Recusa auditada (ex.: RATE_LIMITED) chega como retorno, não como exceção (migration 0007).
      if (r.ok && r.data && "error" in r.data) return { ok: false, error: toApiError({ message: r.data.error }) };
      return r as Result<SubmitResult>;
    },

    cancel: (requestId: string) =>
      wrap<unknown>(sb.rpc("cancel_proposal_request", { p_request_id: requestId, p_reason: "Cancelada pelo operador" })),

    myRequests: (limit = 100) =>
      wrap<RequestWithResult[]>(sb.from("proposal_requests")
        .select(`${REQUEST_COLUMNS}, ${RESULT_COLUMNS}`)
        .order("received_at", { ascending: false })
        .limit(limit)),

    backofficePresence: () => wrap<string | null>(sb.rpc("backoffice_presence")),

    // ---------- backoffice (o banco exige MFA)
    dashboardCounts: () => wrap<Partial<Record<RequestStatus, number>>>(sb.rpc("dashboard_counts")),

    requestsByStatus: (status: RequestStatus | "all", limit = 200) => {
      let q = sb.from("proposal_requests")
        .select(`${REQUEST_COLUMNS}, ${RESULT_COLUMNS}, ${JOB_COLUMNS}`)
        .order("received_at", { ascending: status !== "all" })
        .limit(limit);
      if (status !== "all") q = q.eq("status", status);
      return wrap<BackofficeRow[]>(q);
    },

    resolveAwaiting: (requestId: string, resolution: "completed" | "requeue" | "failed", adhesionNumber?: string, note?: string) =>
      wrap<unknown>(sb.rpc("resolve_awaiting_request", {
        p_request_id: requestId, p_resolution: resolution,
        p_adhesion_number: adhesionNumber || null, p_note: note || null,
      })),

    requeueFailed: (requestId: string) => wrap<unknown>(sb.rpc("requeue_failed_request", { p_request_id: requestId })),

    cancelBackoffice: (requestId: string, reason: string) =>
      wrap<unknown>(sb.rpc("cancel_request_backoffice", { p_request_id: requestId, p_reason: reason })),

    robotState: () =>
      wrap<RobotState | null>(sb.from("robot_state")
        .select("paused, consig_session, current_step, current_job_id, version, flow_ready, ai_enabled, ai_model, last_seen_at")
        .maybeSingle()),

    robotCommand: (kind: RobotCommand) => wrap<number>(sb.rpc("robot_command", { p_kind: kind })),

    robotSetAi: (enabled: boolean, model: string | null) =>
      wrap<unknown>(sb.rpc("robot_set_ai", { p_enabled: enabled, p_model: model })),

    auditLogs: (limit = 200) =>
      wrap<AuditRow[]>(sb.from("audit_logs").select("id, occurred_at, actor_role, action, request_id, details")
        .order("occurred_at", { ascending: false }).limit(limit)),

    // ---------- admin
    members: () =>
      wrap<(Profile & { created_at: string; operators: Pick<OperatorInfo, "operator_code" | "notification_email"> | null })[]>(
        sb.from("profiles").select("id, role, display_name, active, created_at, operators(operator_code, notification_email)")
          .order("created_at", { ascending: true })),

    setMemberActive: (profileId: string, active: boolean) =>
      wrap<unknown>(sb.rpc("admin_set_member_active", { p_profile_id: profileId, p_active: active })),

    invite: async (email: string, displayName: string, role: AppRole): Promise<Result<unknown>> => {
      const { data, error } = await sb.functions.invoke("admin-invite", {
        body: { email, display_name: displayName, role },
      });
      if (!error) return { ok: true, data };
      // Sem resposta HTTP (FunctionsFetchError) = rede; com resposta, o corpo traz o código estável.
      const ctx = (error as { context?: unknown }).context;
      if (!(ctx instanceof Response)) return { ok: false, error: toApiError({ name: "FunctionsFetchError", message: "fetch" }) };
      const body = await ctx.json().catch(() => ({})) as { code?: string };
      return { ok: false, error: toApiError({ message: body.code ?? "UNKNOWN" }) };
    },

    /** Realtime + reconsulta: o chamador recarrega a lista a cada evento. */
    subscribeMyRequests: (onChange: () => void) => {
      const ch = sb.channel("my-requests")
        .on("postgres_changes", { event: "*", schema: "public", table: "proposal_requests" }, onChange)
        .subscribe();
      return () => void sb.removeChannel(ch);
    },
  };
}

export type Api = ReturnType<typeof createApi>;
