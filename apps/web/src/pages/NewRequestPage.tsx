import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, FormDefinition, SubmitResult } from "@fic/contracts";
import { useAuth } from "../auth/AuthProvider";
import { DynamicForm } from "../components/DynamicForm";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { navigate } from "../lib/router";

export function NewRequestPage() {
  const { api, operator } = useAuth();
  const [form, setForm] = useState<FormDefinition | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [loadingForm, setLoadingForm] = useState(false);
  // Chave de idempotência por tentativa de envio: reenvios (rede instável, duplo clique) não duplicam.
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<SubmitResult | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const loadForm = useCallback(async () => {
    setLoadingForm(true);
    const r = await api.activeForm();
    setLoadingForm(false);
    if (r.ok) {
      setForm(r.data);
      setLoadError(null);
    } else setLoadError(r.error);
  }, [api]);

  useEffect(() => void loadForm(), [loadForm]);

  // Resultado do envio (sucesso ou erro geral) recebe o foco para ser lido imediatamente.
  useEffect(() => {
    if (done || (error && error.code !== "PAYLOAD_INVALID")) resultRef.current?.focus();
  }, [done, error]);

  async function submit(payload: Record<string, unknown>) {
    if (!form) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const r = await api.submit(idemKey, form.version, payload);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      // Validação recusada: a próxima tentativa já é outro envio.
      if (r.error.code !== "NETWORK") setIdemKey(crypto.randomUUID());
      return;
    }
    setDone(r.data);
    setIdemKey(crypto.randomUUID());
    setFormKey((k) => k + 1);
  }

  if (!operator) {
    return <div className="notice" data-tone="attention" role="status">Seu usuário não está cadastrado como operador.</div>;
  }
  if (loadError && form === undefined) {
    return (
      <section className="page page-narrow" aria-labelledby="new-title">
        <header className="page-head"><h1 id="new-title">Nova solicitação</h1></header>
        <ErrorState title="Não foi possível carregar o formulário" message={loadError.message}
          onRetry={() => void loadForm()} retrying={loadingForm} />
      </section>
    );
  }
  if (form === undefined) return <Loading label="Carregando formulário…" />;
  if (form === null) {
    return (
      <section className="page page-narrow" aria-labelledby="new-title">
        <header className="page-head"><h1 id="new-title">Nova solicitação</h1></header>
        <EmptyState title="Formulário ainda não configurado"
          action={<button className="btn" onClick={() => void loadForm()} disabled={loadingForm}>
            {loadingForm ? "Verificando…" : "Verificar novamente"}</button>}>
          Os campos da proposta serão publicados pelo backoffice quando o processo do Consig for mapeado.
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="page page-narrow" aria-labelledby="new-title">
      <header className="page-head">
        <div>
          <p className="eyebrow">Formulário v{form.version}</p>
          <h1 id="new-title">{form.title}</h1>
        </div>
      </header>

      <dl className="meta-grid">
        <div><dt>Remetente</dt><dd className="mono">{operator.operator_code}</dd></div>
        <div><dt>Proprietário do cliente</dt><dd className="mono">{operator.operator_code} <span className="muted">(você)</span></dd></div>
      </dl>

      {done && (
        <div className="notice" data-tone="success" role="status" tabIndex={-1} ref={resultRef}>
          Solicitação <strong className="mono">{done.public_ref}</strong> {done.duplicate ? "já havia sido registrada" : "registrada"}.{" "}
          <button className="btn-link" onClick={() => navigate("/solicitacoes")}>Acompanhar</button>
        </div>
      )}
      {error && error.code !== "PAYLOAD_INVALID" && (
        <div className="notice" data-tone="danger" role="alert" tabIndex={-1} ref={resultRef}>
          {error.message}
          {error.code === "DUPLICATE_REQUEST" && error.detail && <> Referência: <span className="mono">{error.detail}</span>.</>}
          {error.code === "FORM_VERSION_OUTDATED" && (
            <> <button className="btn-link" onClick={() => { setError(null); setForm(undefined); void loadForm(); }}>Carregar a versão atual</button></>
          )}
        </div>
      )}

      <DynamicForm key={formKey} fields={form.fields} busy={busy} serverErrors={error?.fields ?? []} onSubmit={submit} />
    </section>
  );
}
