import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider";

/** Exige MFA TOTP (aal2) antes de mostrar o conteúdo. Cadastra o fator na primeira vez. */
export function MfaGate({ children }: { children: ReactNode }) {
  const { sb, aal, refresh } = useAuth();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (aal === "aal2") return;
    (async () => {
      const { data } = await sb.auth.mfa.listFactors();
      const verified = data?.totp.find((f) => f.status === "verified");
      if (verified) return setFactorId(verified.id);
      const { data: en, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `portal-${Date.now()}` });
      if (error || !en) return setErr("Não foi possível iniciar o cadastro do autenticador.");
      setFactorId(en.id);
      setQr(en.totp.qr_code);
    })();
  }, [aal, sb]);

  if (aal === "aal2") return <>{children}</>;

  async function verify(ev: FormEvent) {
    ev.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setErr(null);
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    setBusy(false);
    if (error) return setErr("Código inválido ou expirado.");
    await refresh();
  }

  return (
    <section className="page page-narrow">
      <header className="page-head"><h1>Verificação em duas etapas</h1></header>
      {qr && (
        <div className="mfa-enroll">
          <p>Escaneie com um app autenticador (Microsoft Authenticator, Google Authenticator, 1Password…).</p>
          <img src={qr} alt="QR code do autenticador" width={180} height={180} />
        </div>
      )}
      <form onSubmit={verify} className="stack">
        <div className="field">
          <label htmlFor="totp">Código de 6 dígitos</label>
          <input id="totp" className="input mono" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}"
            maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} disabled={busy || !factorId} required />
        </div>
        {err && <div className="notice" data-tone="danger" role="alert">{err}</div>}
        <button className="btn btn-primary" disabled={busy || !factorId}>Verificar</button>
      </form>
    </section>
  );
}
