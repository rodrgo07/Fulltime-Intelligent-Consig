import { describe, expect, it } from "vitest";
import {
  ERROR_MESSAGE, normalizeFieldValue, REQUEST_STATUSES, STATUS_LABEL, STATUS_REASON_LABEL, statusReasonLabel, toApiError,
} from "./index.ts";

declare global {
  interface ImportMeta {
    glob<T>(pattern: string | string[], opts: { query: string; import: string; eager: true }): Record<string, T>;
  }
}

// Fontes reais dos códigos: o teste falha se o backend ganhar um código sem mensagem na interface.
const sql = import.meta.glob<string>("../../../supabase/migrations/*.sql", { query: "?raw", import: "default", eager: true });
const functions = import.meta.glob<string>("../../../supabase/functions/**/*.ts", { query: "?raw", import: "default", eager: true });
const engine = import.meta.glob<string>("../../../services/robot/src/fic_robot/*.py", { query: "?raw", import: "default", eager: true });

const matches = (sources: Record<string, string>, re: RegExp) =>
  [...new Set(Object.values(sources).flatMap((src) => [...src.matchAll(re)].map((m) => m[1])))].sort();

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
    const e = toApiError({ message: 'relation "x" does not exist', details: "linha 3" });
    expect(e.code).toBe("UNKNOWN");
    expect(e.message).not.toContain("relation");
    expect(e.detail).toBeUndefined();
  });

  it("mantém o detalhe de negócio (referência do duplicado)", () => {
    expect(toApiError({ message: "DUPLICATE_REQUEST", details: "FIC-000000-TESTE001" }).detail).toBe("FIC-000000-TESTE001");
  });

  it("mapeia erros de transporte do PostgREST e de rede", () => {
    expect(toApiError({ message: "JWT expired", code: "PGRST301" }).code).toBe("UNAUTHENTICATED");
    expect(toApiError({ message: "permission denied for table x", code: "42501" }).code).toBe("FORBIDDEN");
    expect(toApiError({ name: "TypeError", message: "Failed to fetch" }).code).toBe("NETWORK");
    expect(toApiError({ name: "FunctionsFetchError", message: "Failed to send a request to the Edge Function" }).code).toBe("NETWORK");
  });

  it("cobre todos os códigos de erro das funções SQL", () => {
    const codes = matches(sql, /errcode\s*=\s*'P0001',\s*message\s*=\s*'([A-Z][A-Z0-9_]+)'/g);
    expect(codes.length).toBeGreaterThan(20);
    expect(codes.filter((c) => !ERROR_MESSAGE[c])).toEqual([]);
  });

  it("cobre todos os códigos das Edge Functions", () => {
    // Todo literal em MAIÚSCULAS numa linha que monta `{ code: … }` (inclui ternários e fallbacks).
    const codeLines = Object.values(functions).flatMap((src) =>
      src.split("\n").filter((l) => /\bcode:/.test(l)).map((l) => l.slice(l.search(/\bcode:/))));
    const all = [...new Set(codeLines.flatMap((l) => [...l.matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1])))];
    expect(all).toEqual(expect.arrayContaining(["INVALID_INPUT", "ALREADY_REGISTERED", "INVITE_FAILED", "REGISTER_FAILED"]));
    expect(all.filter((c) => !ERROR_MESSAGE[c])).toEqual([]);
  });

  it("todo motivo de estado gravado pelo banco e pelo motor tem rótulo", () => {
    const fromSql = matches(sql, /status_reason\s*=\s*'([A-Z][A-Z0-9_]+)'/g)
      .concat(matches(sql, /coalesce\(p_note,\s*'([A-Z][A-Z0-9_]+)'\)/g));
    const fromEngine = matches(engine, /code\s*=\s*"([A-Z][A-Z0-9_]+)"/g);
    expect(fromSql).toEqual(expect.arrayContaining(["LEASE_EXPIRED", "PII_EXPIRED", "REQUEUED"]));
    expect(fromEngine).toEqual(expect.arrayContaining(["SESSION_UNAVAILABLE", "UNEXPECTED_SCREEN"]));
    expect([...fromSql, ...fromEngine].filter((c) => !STATUS_REASON_LABEL[c])).toEqual([]);
    expect(statusReasonLabel("Cancelada pelo operador")).toBeNull();
    expect(statusReasonLabel(null)).toBeNull();
  });

  it("normaliza máscaras e números", () => {
    expect(normalizeFieldValue({ key: "c", label: "c", type: "cpf" }, "529.982.247-25")).toBe("52998224725");
    expect(normalizeFieldValue({ key: "v", label: "v", type: "decimal" }, "1.500,50")).toBe(1500.5);
    expect(normalizeFieldValue({ key: "t", label: "t", type: "text" }, "  ")).toBeNull();
  });
});
