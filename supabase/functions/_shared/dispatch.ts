import { buildCompletionEmail, type CompletionNotice } from "./email.ts";
import { sendWithResend } from "./resend.ts";

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export type DispatchDeps = {
  rpc: Rpc;
  fetch: typeof fetch;
  resendApiKey: string;
  from: string;
  log: (msg: string, meta: Record<string, unknown>) => void;
};

/** Processa um lote da fila. Logs usam apenas o id da notificação (sem e-mail ou dados do cliente). */
export async function dispatchNotifications(deps: DispatchDeps, limit = 10) {
  const { data, error } = await deps.rpc("svc_claim_notifications", { p_limit: limit });
  if (error) throw new Error(`claim failed: ${error.message}`);
  const batch = (data ?? []) as CompletionNotice[];
  let sent = 0;
  let failed = 0;
  for (const n of batch) {
    const mail = buildCompletionEmail(n);
    const res = await sendWithResend(deps.fetch, deps.resendApiKey,
      { from: deps.from, to: n.recipient_email, ...mail }, n.notification_id);
    const fin = await deps.rpc("svc_finish_notification", {
      p_notification_id: n.notification_id,
      p_ok: res.ok,
      p_provider_message_id: res.ok ? res.id : null,
      p_error: res.ok ? null : res.error,
      p_retryable: res.ok ? true : res.retryable,
    });
    if (fin.error) deps.log("finish_failed", { notification_id: n.notification_id });
    if (res.ok) sent++;
    else {
      failed++;
      deps.log("send_failed", { notification_id: n.notification_id, attempt: n.attempt, error: res.error });
    }
  }
  return { processed: batch.length, sent, failed };
}
