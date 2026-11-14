// Cabeçalhos que o supabase-js envia (ver @supabase/supabase-js/cors, v2.119). Sem x-client-info o
// preflight do navegador falha em functions.invoke.
export const SUPABASE_CLIENT_HEADERS =
  "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage";

export function corsHeaders(origin: string | null, allowed: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin === allowed ? allowed : "null",
    "Access-Control-Allow-Headers": SUPABASE_CLIENT_HEADERS,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

/** Comparação em tempo constante para segredos. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0 && a.length > 0;
}
