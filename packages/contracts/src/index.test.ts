import { describe, expect, it } from "vitest";
import { normalizeFieldValue, REQUEST_STATUSES, STATUS_LABEL, toApiError } from "./index.ts";

describe("contracts", () => {
  it("todos os estados têm rótulo", () => {
    for (const s of REQUEST_STATUSES) expect(STATUS_LABEL[s]).toBeTruthy();
  });

  it("converte erro do backend com campos", () => {
    const e = toApiError({ message: "PAYLOAD_INVALID", details: '[{"field":"documento","code":"INVALID_CPF"}]' });
    expect(e.code).toBe("PAYLOAD_INVALID");
    expect(e.fields).toEqual([{ field: "documento", code: "INVALID_CPF" }]);
  });

  it("erro desconhecido não vaza mensagem técnica", () => {
    const e = toApiError({ message: 'relation "x" does not exist' });
    expect(e.code).toBe("UNKNOWN");
    expect(e.message).not.toContain("relation");
  });

  it("normaliza máscaras e números", () => {
    expect(normalizeFieldValue({ key: "c", label: "c", type: "cpf" }, "529.982.247-25")).toBe("52998224725");
    expect(normalizeFieldValue({ key: "v", label: "v", type: "decimal" }, "1.500,50")).toBe(1500.5);
    expect(normalizeFieldValue({ key: "t", label: "t", type: "text" }, "  ")).toBeNull();
  });
});
