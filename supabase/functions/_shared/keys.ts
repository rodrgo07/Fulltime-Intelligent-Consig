// Chaves de API injetadas pelo Supabase nas Edge Functions.
// Projetos com as chaves novas recebem SUPABASE_SECRET_KEYS / SUPABASE_PUBLISHABLE_KEYS (JSON por nome,
// a primeira chave se chama "default"). As variáveis legadas SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY
// continuam existindo, mas carregam as chaves JWT legadas, que deixam de funcionar quando o projeto as desativa.
// Por isso: preferir a chave nova e usar a legada só como alternativa (ex.: `supabase functions serve` antigo).

export type EnvGet = (name: string) => string | undefined;

function namedKey(get: EnvGet, jsonVar: string, name: string): string | undefined {
  const raw = get(jsonVar);
  if (!raw) return undefined;
  try {
    const v = (JSON.parse(raw) as Record<string, unknown>)[name];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined; // valor malformado: cai na variável legada
  }
}

/** Chave de servidor (papel service_role). Nunca sai da Edge Function. */
export function serverKey(get: EnvGet, name = "default"): string {
  const k = namedKey(get, "SUPABASE_SECRET_KEYS", name) ?? get("SUPABASE_SERVICE_ROLE_KEY");
  if (!k) throw new Error("missing env SUPABASE_SECRET_KEYS/SUPABASE_SERVICE_ROLE_KEY");
  return k;
}

/** Chave pública (publishable ou anon legada), usada para agir em nome do usuário com o JWT dele. */
export function publicKey(get: EnvGet, name = "default"): string {
  const k = namedKey(get, "SUPABASE_PUBLISHABLE_KEYS", name) ?? get("SUPABASE_ANON_KEY");
  if (!k) throw new Error("missing env SUPABASE_PUBLISHABLE_KEYS/SUPABASE_ANON_KEY");
  return k;
}

/**
 * JWT de usuário do header Authorization, ou null.
 * Chaves de API (sb_publishable_/sb_secret_) não são JWT e não identificam um usuário: são recusadas.
 */
export function bearerJwt(authorization: string | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec((authorization ?? "").trim());
  if (!m) return null;
  const token = m[1];
  if (token.startsWith("sb_")) return null;
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ? token : null;
}
