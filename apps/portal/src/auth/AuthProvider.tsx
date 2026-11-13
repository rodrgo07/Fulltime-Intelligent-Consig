import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { createApi, type Api, type OperatorInfo, type Profile } from "../lib/api";

type AuthState = {
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  operator: OperatorInfo | null;
  aal: "aal1" | "aal2" | null;
  /** Evento do link de e-mail (convite/recuperação): o usuário precisa definir a senha. */
  needsPassword: boolean;
  api: Api;
  sb: SupabaseClient;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  clearNeedsPassword: () => void;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ sb, children }: { sb: SupabaseClient; children: ReactNode }) {
  const api = useMemo(() => createApi(sb), [sb]);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [operator, setOperator] = useState<OperatorInfo | null>(null);
  const [aal, setAal] = useState<"aal1" | "aal2" | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsPassword, setNeedsPassword] = useState(window.location.pathname === "/definir-senha");

  const load = useCallback(async (s: Session | null) => {
    setSession(s);
    if (!s) {
      setProfile(null);
      setOperator(null);
      setAal(null);
      setLoading(false);
      return;
    }
    const [p, o, level] = await Promise.all([
      api.myProfile(s.user.id),
      api.myOperator(s.user.id),
      sb.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    setProfile(p.ok ? p.data : null);
    setOperator(o.ok ? o.data : null);
    setAal((level.data?.currentLevel as "aal1" | "aal2" | null) ?? "aal1");
    setLoading(false);
  }, [api, sb]);

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => load(data.session));
    const { data } = sb.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setNeedsPassword(true);
      // Evita chamadas ao Supabase dentro do callback (recomendação do supabase-js).
      setTimeout(() => void load(s), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [sb, load]);

  const value: AuthState = {
    loading, session, profile, operator, aal, needsPassword, api, sb,
    refresh: async () => load((await sb.auth.getSession()).data.session),
    signOut: async () => {
      await sb.auth.signOut({ scope: "local" });
    },
    clearNeedsPassword: () => setNeedsPassword(false),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth fora do AuthProvider");
  return v;
}
