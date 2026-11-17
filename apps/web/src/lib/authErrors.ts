import { ERROR_MESSAGE } from "@fic/contracts";

type AuthLikeError = { name?: string; status?: number; code?: string } | null | undefined;

/**
 * Mensagem para erros do Supabase Auth. Falhas de rede e limite de tentativas ganham texto próprio;
 * o resto usa o texto genérico da tela (não revela se o e-mail existe).
 */
export function authErrorMessage(error: AuthLikeError, fallback: string): string {
  if (!error) return fallback;
  if (error.name === "AuthRetryableFetchError" || error.status === 0) return ERROR_MESSAGE.NETWORK;
  if (error.status === 429 || error.code === "over_request_rate_limit" || error.code === "over_email_send_rate_limit") {
    return "Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.";
  }
  return fallback;
}
