import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** null quando o portal ainda não foi configurado (sem projeto Supabase). */
export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          // sessionStorage: a sessão termina ao fechar a aba (máquinas compartilhadas).
          storage: window.sessionStorage,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: "pkce",
        },
      })
    : null;

export function requireClient(): SupabaseClient {
  if (!supabase) throw new Error("PORTAL_NOT_CONFIGURED");
  return supabase;
}
