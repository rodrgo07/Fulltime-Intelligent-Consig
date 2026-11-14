import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { errorMessage } = await import("./ipc");

// Fontes reais dos códigos: camada nativa (Rust) e motor RPA (JSON-RPC data.code).
const rust = import.meta.glob<string>("../../src-tauri/src/*.rs", { query: "?raw", import: "default", eager: true });
const engine = import.meta.glob<string>("../../../../services/engine/src/fic_rpa/*.py", { query: "?raw", import: "default", eager: true });

const collect = (sources: Record<string, string>, re: RegExp) =>
  [...new Set(Object.values(sources).flatMap((s) => [...s.matchAll(re)].map((m) => m[1])))].sort();

const isFallback = (msg: string) => msg.includes("(código ");

describe("errorMessage", () => {
  it("todo AppError::Code do Rust tem mensagem", () => {
    const codes = collect(rust, /AppError::Code\("([A-Z][A-Z0-9_]+)"\)/g)
      .concat(collect(rust, /Code\(if [^)]*?\{\s*"([A-Z][A-Z0-9_]+)"/g));
    expect(codes.length).toBeGreaterThan(25);
    expect(codes.filter((c) => isFallback(errorMessage({ code: c })))).toEqual([]);
  });

  it("todo código de erro do motor RPA tem mensagem", () => {
    const codes = collect(engine, /code\s*=\s*"([A-Z][A-Z0-9_]+)"/g).concat(collect(engine, /"(ENGINE_BUSY|CONTRACT_MISMATCH)"/g));
    expect(codes).toEqual(expect.arrayContaining(["WORKFLOW_NOT_READY", "SESSION_UNAVAILABLE", "BROWSER_MISSING"]));
    expect(codes.filter((c) => isFallback(errorMessage({ code: c })))).toEqual([]);
  });

  it("códigos do backend vêm do contrato compartilhado", () => {
    expect(errorMessage({ code: "NOT_AWAITING_CONFIRMATION" })).toBe("A solicitação não está aguardando confirmação.");
    expect(errorMessage({ code: "JOB_NOT_ACTIVE" })).toMatch(/encerrada/);
  });

  it("HTTP genérico vira mensagem compreensível", () => {
    expect(errorMessage({ code: "HTTP_401" })).toMatch(/Sessão expirada/);
    expect(errorMessage({ code: "HTTP_503" })).toMatch(/indisponível.*503/);
    expect(errorMessage({ code: "ALGO_NOVO" })).toBe("Não foi possível concluir a operação. (código ALGO_NOVO)");
    expect(errorMessage(undefined)).toMatch(/Não foi possível concluir/);
  });
});
