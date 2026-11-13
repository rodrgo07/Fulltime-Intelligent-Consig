import { useId, useState, type FormEvent } from "react";
import { FIELD_ERROR_MESSAGE, normalizeFieldValue, type FieldError, type FormField } from "@fic/contracts";

type Props = {
  fields: FormField[];
  busy: boolean;
  serverErrors: FieldError[];
  onSubmit: (payload: Record<string, unknown>) => void;
  submitLabel?: string;
};

const inputType: Record<FormField["type"], string> = {
  text: "text", integer: "text", decimal: "text", date: "date", select: "", cpf: "text", email: "email", phone: "tel",
};
const inputMode: Partial<Record<FormField["type"], "numeric" | "decimal" | "email" | "tel">> = {
  integer: "numeric", decimal: "decimal", cpf: "numeric", phone: "tel", email: "email",
};

/**
 * Renderiza qualquer versão do formulário a partir da definição vinda do banco.
 * As restrições HTML são só conveniência; a validação que vale é a do backend.
 */
export function DynamicForm({ fields, busy, serverErrors, onSubmit, submitLabel = "Enviar solicitação" }: Props) {
  const formId = useId();
  const [values, setValues] = useState<Record<string, string>>({});

  const errorFor = (key: string) => serverErrors.find((e) => e.field === key);
  const general = serverErrors.filter((e) => !e.field || !fields.some((f) => f.key === e.field));

  function handleSubmit(ev: FormEvent) {
    ev.preventDefault();
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      const v = normalizeFieldValue(f, values[f.key] ?? "");
      if (v !== null) payload[f.key] = v;
    }
    onSubmit(payload);
  }

  return (
    <form className="dyn-form" onSubmit={handleSubmit} noValidate={false} aria-busy={busy}>
      {fields.map((f) => {
        const id = `${formId}-${f.key}`;
        const err = errorFor(f.key);
        const common = {
          id,
          name: f.key,
          required: f.required,
          "aria-invalid": err ? true : undefined,
          "aria-describedby": err ? `${id}-err` : f.help ? `${id}-hint` : undefined,
          value: values[f.key] ?? "",
          onChange: (e: { target: { value: string } }) => setValues((s) => ({ ...s, [f.key]: e.target.value })),
          disabled: busy,
          className: "input",
          autoComplete: "off",
        };
        return (
          <div className="field" key={f.key}>
            <label htmlFor={id}>
              {f.label}
              {f.required && <span aria-hidden="true"> *</span>}
            </label>
            {f.type === "select" ? (
              <select {...common}>
                <option value="">Selecione</option>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : (
              <input
                {...common}
                type={inputType[f.type]}
                inputMode={inputMode[f.type]}
                maxLength={f.max_length}
                minLength={f.min_length}
                min={f.type === "date" ? (f.min as string | undefined) : undefined}
                max={f.type === "date" ? (f.max as string | undefined) : undefined}
                spellCheck={false}
              />
            )}
            {f.help && !err && <span className="hint" id={`${id}-hint`}>{f.help}</span>}
            {err && (
              <span className="error" id={`${id}-err`} role="alert">
                {FIELD_ERROR_MESSAGE[err.code] ?? "Valor inválido."}
              </span>
            )}
          </div>
        );
      })}
      {general.length > 0 && (
        <div className="notice" data-tone="danger" role="alert">
          {general.map((e) => FIELD_ERROR_MESSAGE[e.code] ?? e.code).join(" ")}
        </div>
      )}
      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Enviando…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
