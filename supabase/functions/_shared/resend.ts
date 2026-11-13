// Cliente mínimo da API do Resend. A chave vem do ambiente (secret da Edge Function), nunca do código.

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: string; retryable: boolean };

export type Mail = { from: string; to: string; subject: string; html: string; text: string };

export async function sendWithResend(
  fetchFn: typeof fetch,
  apiKey: string,
  mail: Mail,
  idempotencyKey: string,
): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Mesmo id da notificação em todas as tentativas: o provedor não envia duas vezes.
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(mail),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, error: `NETWORK: ${(e as Error).name}`, retryable: true };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: body.id ?? "" };
  }
  // 409 = mesma chave de idempotência com conteúdo diferente/ em andamento; trata como recuperável.
  const retryable = res.status === 429 || res.status === 409 || res.status >= 500;
  return { ok: false, error: `HTTP ${res.status}`, retryable };
}
