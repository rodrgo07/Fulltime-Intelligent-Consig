import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FormField } from "@fic/contracts";
import { DynamicForm } from "./DynamicForm";

afterEach(cleanup);

// Campos fictícios apenas para teste da infraestrutura (não são campos do Consig).
const fields: FormField[] = [
  { key: "documento", label: "Documento", type: "cpf", required: true },
  { key: "valor", label: "Valor", type: "decimal" },
  { key: "opcao", label: "Opção", type: "select", options: [{ value: "a", label: "A" }] },
];

describe("DynamicForm", () => {
  it("normaliza e envia apenas campos preenchidos", () => {
    const onSubmit = vi.fn();
    render(<DynamicForm fields={fields} busy={false} serverErrors={[]} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/Documento/), { target: { value: "529.982.247-25" } });
    fireEvent.change(screen.getByLabelText(/Valor/), { target: { value: "1.234,56" } });
    fireEvent.submit(screen.getByRole("button", { name: /Enviar/ }).closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith({ documento: "52998224725", valor: 1234.56 });
  });

  it("exibe erros devolvidos pelo backend no campo certo", () => {
    render(<DynamicForm fields={fields} busy={false} onSubmit={() => {}}
      serverErrors={[{ field: "documento", code: "INVALID_CPF" }, { field: "x", code: "UNKNOWN_FIELD" }]} />);
    expect(screen.getByLabelText(/Documento/).getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("CPF inválido.")).toBeTruthy();
    expect(screen.getByText("Campo não reconhecido.")).toBeTruthy();
  });

  it("bloqueia o formulário durante o envio", () => {
    render(<DynamicForm fields={fields} busy serverErrors={[]} onSubmit={() => {}} />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
