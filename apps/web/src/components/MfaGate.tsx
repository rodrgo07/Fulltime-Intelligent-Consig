import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider";
import { ErrorState, Loading } from "./States";

/** Exige MFA TOTP (aal2) antes de mostrar o conteúdo. Cadastra o fator na primeira vez. */
export function MfaGate({ children }: { children: ReactNode }) {
  const { sb, aal, refresh } = useAuth();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [prepError, setPrepError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const prepare = useCallback(async () => {
    setPreparing(true);
    setPrepError(null);
    try {
      const { data, error: listError } = await sb.auth.mfa.listFactors();
      if (listError) return setPrepError("Não foi possível consultar seus autenticadores. Verifique a conexão.");
      const verified = data?.totp.find((f) => f.status === "verified");
      if (verified) return setFactorId(verified.id);
      const { data: en, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `portal-${Date.now()}` });
      if (error || !en) return setPrepError("Não foi possível iniciar o cadastro do autenticador.");
      setFactorId(en.id);
      setQr(en.totp.qr_code);
      setSecret(en.totp.secret);
    } catch {
      setPrepError("Sem conexão com o servidor. Tente novamente.");
    } finally {
      setPreparing(false);
    }
  }, [sb]);

  // Uma preparação automática por montagem (StrictMode roda efeitos 2x e criaria 2 fatores).
  const started = useRef(false);
  useEffect(() => {
    if (aal === "aal2" || started.current) return;
    started.current = true;
    void prepare();
  }, [aal, prepare]);

  if (aal === "aal2") return <>{children}</>;

  async function verify(ev: FormEvent) {
    ev.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setErr(null);
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    setBusy(false);
    if (error) return setErr("Código inválido ou expirado. Confira o horário do celular e tente o código atual.");
    await refresh();
  }

  return (
    <section className="page page-narrow" aria-labelledby="mfa-title">
      <header className="page-head">
        <div>
          <p className="eyebrow">Área administrativa</p>
          <h1 id="mfa-title">Verificação em duas etapas</h1>
        </div>
      </header>
      {prepError ? (
        <ErrorState message={prepError} onRetry={() => void prepare()} retrying={preparing} />
      ) : !factorId ? (
        <Loading label="Preparando a verificação…" />
      ) : (
        <>
          {qr && (
            <div className="mfa-enroll">
              <p>Escaneie o QR code com um app autenticador (Microsoft Authenticator, Google Authenticator, 1Password…).</p>
              <img src={qr} alt="QR code para cadastrar o Intelligent Consig no app autenticador" width={180} height={180} />
              {secret && (
                <details>
                  <summary>Não consegue escanear? Digite a chave manualmente</summary>
                  <p className="mono secret" aria-label={`Chave: ${secret.split("").join(" ")}`}>{secret}</p>
                </details>
              )}
            </div>
          )}
          <form onSubmit={verify} className="stack" aria-busy={busy}>
            <div className="field">
              <label htmlFor="totp">Código de 6 dígitos</label>
              <input id="totp" className="input mono" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}"
                maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} disabled={busy}
                aria-invalid={err ? true : undefined} aria-describedby={err ? "totp-err" : "totp-hint"} required />
              <span className="hint" id="totp-hint">Use o código exibido agora no app autenticador.</span>
            </div>
            {err && <div className="notice" data-tone="danger" role="alert" id="totp-err">{err}</div>}
            <button className="btn btn-primary" disabled={busy || code.length !== 6}>{busy ? "Verificando…" : "Verificar"}</button>
          </form>
        </>
      )}
    </section>
  );
}
