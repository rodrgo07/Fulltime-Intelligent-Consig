import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { apiError, fakeAuth } from "./test/fakeAuth";

let auth = fakeAuth();
vi.mock("./auth/AuthProvider", () => ({ useAuth: () => auth }));

const { App } = await import("./App");

beforeEach(() => {
  auth = fakeAuth();
  window.history.replaceState(null, "", "/solicitacoes");
});
afterEach(cleanup);

describe("App", () => {
  it("carregamento inicial é anunciado", () => {
    auth = fakeAuth({ loading: true });
    render(<App />);
    expect(screen.getByRole("status").textContent).toMatch(/Carregando/);
  });

  it("falha ao carregar o perfil não é tratada como 'acesso não liberado'", async () => {
    const refresh = vi.fn(async () => {});
    auth = fakeAuth({ profile: null, operator: null, loadError: apiError("NETWORK", "Sem conexão com o servidor.") , refresh });
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Não foi possível carregar seu acesso");
    expect(screen.queryByText("Acesso não liberado")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("perfil ausente sem erro = acesso não liberado", () => {
    auth = fakeAuth({ profile: null, operator: null });
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Acesso não liberado");
  });

  it("tem link para pular ao conteúdo, navegação rotulada e título da página", async () => {
    render(<App />);
    const skip = screen.getByRole("link", { name: "Pular para o conteúdo" });
    expect(skip.getAttribute("href")).toBe("#conteudo");
    expect(document.getElementById("conteudo")?.tagName).toBe("MAIN");
    expect(screen.getByRole("navigation", { name: "Principal" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Minhas solicitações" }).getAttribute("aria-current")).toBe("page");
    expect(document.title).toMatch(/^Minhas solicitações · /);
    expect(screen.getByRole("button", { name: "Sair" })).toBeTruthy();
  });

  it("troca de página leva o foco ao conteúdo principal", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("link", { name: "Nova solicitação" }));
    expect(document.activeElement?.id).toBe("conteudo");
    expect(document.title).toMatch(/^Nova solicitação · /);
  });
});
