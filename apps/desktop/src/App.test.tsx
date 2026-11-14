import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers, installTauri, type Handler } from "./test/fakeTauri";

let tauri = installTauri(defaultHandlers());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => tauri.invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (e: string, cb: (x: { payload: unknown }) => void) => tauri.listen(e, cb) }));

const { App } = await import("./App");

function setup(overrides: Record<string, Handler> = {}) {
  tauri = installTauri({ ...defaultHandlers(), ...overrides });
  return render(<App />);
}

/** Passa a introdução (já vista: "Pular" com Esc). */
async function pastIntro() {
  await screen.findByRole("button", { name: /Pular/ });
  fireEvent.keyDown(window, { key: "Escape" });
  await screen.findByRole("navigation", { name: "Principal" }, { timeout: 2000 });
}

beforeEach(() => { document.title = ""; });
afterEach(cleanup);

describe("App desktop", () => {
  it("falha ao iniciar mostra erro com nova tentativa", async () => {
    let fail = true;
    setup({ app_info: () => { if (fail) throw { code: "INTERNAL" }; return defaultHandlers().app_info(); } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Não foi possível iniciar/);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByRole("button", { name: /Pular/ })).toBeTruthy();
  });

  it("aviso de atualização: consulta inicial, evento do Rust e atalho para Configurações → Atualizações", async () => {
    setup({ update_check: () => ({ current: "0.1.0", available: null }) });
    await pastIntro();
    expect(screen.queryByText(/disponível\./)).toBeNull();

    act(() => tauri.emit("update-available", "0.2.0"));
    expect(await screen.findByText("Versão 0.2.0 disponível.")).toBeTruthy();
    expect(screen.getByText("(atualização disponível)")).toBeTruthy();

    tauri = installTauri({ ...defaultHandlers(), update_check: () => ({ current: "0.1.0", available: "0.2.0", notes: "Notas fictícias" }) });
    fireEvent.click(screen.getByRole("button", { name: "Ver atualização" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Atualizações" })).toBeTruthy();
    expect(await screen.findByText("Notas fictícias")).toBeTruthy();
  });

  it("aviso pode ser dispensado e já aparece se a consulta inicial encontrar versão", async () => {
    setup({ update_check: () => ({ current: "0.1.0", available: "0.3.0" }) });
    await pastIntro();
    expect(await screen.findByText("Versão 0.3.0 disponível.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dispensar aviso de atualização" }));
    expect(screen.queryByText("Versão 0.3.0 disponível.")).toBeNull();
  });

  it("link para pular ao conteúdo, foco e título ao trocar de tela", async () => {
    setup();
    await pastIntro();
    expect(screen.getByRole("link", { name: "Pular para o conteúdo" }).getAttribute("href")).toBe("#conteudo");
    await waitFor(() => expect(document.title).toBe("Painel · Fulltime Intelligent Consig"));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Principal" })).getByRole("button", { name: "Abrir Consig" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Abrir Consig" })).toBeTruthy();
    expect(document.activeElement?.id).toBe("conteudo");
    expect(document.title).toBe("Abrir Consig · Fulltime Intelligent Consig");
  });
});
