import { useEffect, useState } from "react";
import type { ApiError, FormDefinition, SubmitResult } from "@fic/contracts";
import { useAuth } from "../auth/AuthProvider";
import { DynamicForm } from "../components/DynamicForm";
import { navigate } from "../lib/router";

export function NewRequestPage() {
  const { api, operator } = useAuth();
  const [form, setForm] = useState<FormDefinition | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  // Chave de idempotência por tentativa de envio: reenvios (rede instável, duplo clique) não duplicam.
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<SubmitResult | null>(null);

  useEffect(() => {
    api.activeForm().then((r) => (r.ok ? setForm(r.data) : setLoadError(r.error)));
  }, [api]);

  async function submit(payload: Record<string, unknown>) {
    if (!form) return;
    setBusy(true);
    setError(null);
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
    return <div className="notice" data-tone="attention">Seu usuário não está cadastrado como operador.</div>;
  }
  if (loadError) return <div className="notice" data-tone="danger">{loadError.message}</div>;
  if (form === undefined) return <p className="muted">Carregando formulário…</p>;
  if (form === null) {
    return (
      <section className="page">
        <header className="page-head"><h1>Nova solicitação</h1></header>
        <div className="notice" data-tone="attention">
          O formulário de proposta ainda não foi configurado. Os campos serão publicados pelo backoffice
          quando o processo do Consig for mapeado.
        </div>
      </section>
    );
  }

  return (
    <section className="page page-narrow">
      <header className="page-head">
        <div>
          <p className="eyebrow">Formulário v{form.version}</p>
          <h1>{form.title}</h1>
        </div>
      </header>

      <dl className="meta-grid">
        <div><dt>Remetente</dt><dd className="mono">{operator.operator_code}</dd></div>
        <div><dt>Proprietário do cliente</dt><dd className="mono">{operator.operator_code} <span className="muted">(você)</span></dd></div>
      </dl>

      {done && (
        <div className="notice" data-tone="success" role="status">
          Solicitação <strong className="mono">{done.public_ref}</strong> {done.duplicate ? "já havia sido registrada" : "registrada"}.{" "}
          <button className="btn-link" onClick={() => navigate("/solicitacoes")}>Acompanhar</button>
        </div>
      )}
      {error && error.code !== "PAYLOAD_INVALID" && (
        <div className="notice" data-tone="danger" role="alert">
          {error.message}
          {error.code === "DUPLICATE_REQUEST" && error.detail && <> Referência: <span className="mono">{error.detail}</span>.</>}
        </div>
      )}

      <DynamicForm key={formKey} fields={form.fields} busy={busy} serverErrors={error?.fields ?? []} onSubmit={submit} />
    </section>
  );
}
