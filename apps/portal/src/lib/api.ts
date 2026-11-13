// Única camada que fala com o Supabase. Telas não montam queries.
import {
  toApiError, type ApiError, type FormDefinition, type ProposalRequestRow, type ProposalResultRow,
  type SubmitResult, type AppRole,
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

export function createApi(sb: SupabaseClient) {
  return {
    myProfile: (uid: string) =>
      wrap<Profile>(sb.from("profiles").select("id, role, display_name, active").eq("id", uid).single()),

    myOperator: (uid: string) =>
      wrap<OperatorInfo | null>(sb.from("operators").select("id, operator_code, notification_email").eq("id", uid).maybeSingle()),

    activeForm: () =>
      wrap<FormDefinition | null>(sb.from("form_definitions").select("version, title, fields").eq("active", true).maybeSingle()),

    submit: (idempotencyKey: string, formVersion: number, payload: Record<string, unknown>) =>
      wrap<SubmitResult>(sb.rpc("submit_proposal_request", {
        p_idempotency_key: idempotencyKey,
        p_form_version: formVersion,
        p_payload: payload,
      })),

    cancel: (requestId: string) =>
      wrap<unknown>(sb.rpc("cancel_proposal_request", { p_request_id: requestId, p_reason: "Cancelada pelo operador" })),

    myRequests: (limit = 100) =>
      wrap<RequestWithResult[]>(sb.from("proposal_requests")
        .select("*, proposal_results(request_id, adhesion_number, external_operation_id, result_status, completed_at, source)")
        .order("received_at", { ascending: false })
        .limit(limit)),

    backofficePresence: () => wrap<string | null>(sb.rpc("backoffice_presence")),

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
      const ctx = (error as { context?: Response }).context;
      const body = ctx ? await ctx.json().catch(() => ({})) as { code?: string } : {};
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
