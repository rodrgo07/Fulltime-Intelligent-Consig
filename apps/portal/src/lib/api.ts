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

/** `must_change_password`: senha provisória definida pelo admin; o portal exige a troca antes de qualquer tela. */
export type Profile = { id: string; role: AppRole; display_name: string; active: boolean; must_change_password: boolean };
export type OperatorInfo = { id: string; operator_code: string };
export type RequestWithResult = ProposalRequestRow & { proposal_results: ProposalResultRow | null };

export function createApi(sb: SupabaseClient) {
  return {
    // maybeSingle: perfil ausente/oculto pelo RLS (desativado) é `null`, não erro — erro é só falha real.
    myProfile: (uid: string) =>
      wrap<Profile | null>(sb.from("profiles").select("id, role, display_name, active, must_change_password").eq("id", uid).maybeSingle()),

    myOperator: (uid: string) =>
      wrap<OperatorInfo | null>(sb.from("operators").select("id, operator_code").eq("id", uid).maybeSingle()),

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
      wrap<(Profile & { created_at: string; operators: Pick<OperatorInfo, "operator_code"> | null })[]>(
        sb.from("profiles").select("id, role, display_name, active, created_at, operators(operator_code)")
          .order("created_at", { ascending: true })),

    /** Depois de trocar a senha no Auth: o banco desmarca `must_change_password` do próprio usuário. */
    markPasswordChanged: () => wrap<unknown>(sb.rpc("mark_password_changed")),

    setMemberActive: (profileId: string, active: boolean) =>
      wrap<unknown>(sb.rpc("admin_set_member_active", { p_profile_id: profileId, p_active: active })),


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
