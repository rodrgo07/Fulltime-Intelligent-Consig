import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiError, FAKE_UID, fakeApi, fakeAuth } from "../test/fakeAuth";

let auth = fakeAuth();
vi.mock("../auth/AuthProvider", () => ({ useAuth: () => auth }));
const { App } = await import("../App");
const { LoginPage } = await import("./LoginPage");

const NEW_PW = "SenhaFicticia123"; // senha fictícia só de teste

function fill(pw = NEW_PW, pw2 = pw) {
  fireEvent.change(screen.getByLabelText("Nova senha"), { target: { value: pw } });
  fireEvent.change(screen.getByLabelText("Confirmar a nova senha"), { target: { value: pw2 } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar nova senha" }));
}

beforeEach(() => window.history.replaceState(null, "", "/solicitacoes"));
afterEach(cleanup);

describe("troca de senha obrigatória (must_change_password)", () => {
  it("nada além da troca abre: sem menu, sem conteúdo", () => {
    auth = fakeAuth({ profile: { id: FAKE_UID, role: "operator", display_name: "Op", active: true, must_change_password: true } });
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Troca de senha obrigatória");
    expect(screen.queryByRole("navigation", { name: "Principal" })).toBeNull();
    expect(auth.api.myRequests).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sair" })).toBeTruthy();
  });

  it("troca: updateUser → mark_password_changed → recarrega o perfil", async () => {
    const updateUser = vi.fn(async () => ({ data: {}, error: null }));
    const markPasswordChanged = vi.fn(async () => ({ ok: true, data: null }));
    const refresh = vi.fn(async () => {});
    auth = fakeAuth({
      profile: { id: FAKE_UID, role: "operator", display_name: "Op", active: true, must_change_password: true },
      sb: { auth: { updateUser } }, api: fakeApi({ markPasswordChanged }), refresh,
    });
    render(<App />);
    fill();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(updateUser).toHaveBeenCalledWith({ password: NEW_PW });
    expect(markPasswordChanged).toHaveBeenCalledTimes(1);
    expect(updateUser.mock.invocationCallOrder[0]).toBeLessThan(markPasswordChanged.mock.invocationCallOrder[0]);
  });

  it("valida no cliente antes de chamar o Auth e mostra erro do Auth sem marcar", async () => {
    const updateUser = vi.fn(async () => ({ data: {}, error: { status: 422, code: "same_password" } }));
    const markPasswordChanged = vi.fn();
    auth = fakeAuth({
      profile: { id: FAKE_UID, role: "operator", display_name: "Op", active: true, must_change_password: true },
      sb: { auth: { updateUser } }, api: fakeApi({ markPasswordChanged }),
    });
    render(<App />);
    fill("curta");
    expect(screen.getByRole("alert").textContent).toMatch(/12 caracteres/);
    fill(NEW_PW, NEW_PW + "x");
    expect(screen.getByRole("alert").textContent).toMatch(/não conferem/);
    expect(updateUser).not.toHaveBeenCalled();
    fill();
    expect((await screen.findByRole("alert")).textContent).toMatch(/diferente da atual/);
    expect(markPasswordChanged).not.toHaveBeenCalled();
  });

  it("falha ao registrar a troca no banco é informada", async () => {
    auth = fakeAuth({
      profile: { id: FAKE_UID, role: "operator", display_name: "Op", active: true, must_change_password: true },
      api: fakeApi({ markPasswordChanged: vi.fn(async () => ({ ok: false, error: apiError("NETWORK", "Sem conexão") })) }),
    });
    render(<App />);
    fill();
    expect((await screen.findByRole("alert")).textContent).toMatch(/senha foi alterada, mas .*Sem conexão/);
  });
});

describe("alterar senha pelo menu", () => {
  it("menu do usuário tem 'Alterar senha', que abre a tela dentro do portal", async () => {
    auth = fakeAuth();
    render(<App />);
    fireEvent.click(screen.getByRole("link", { name: "Alterar senha" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Alterar senha" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Principal" })).toBeTruthy();
    fill();
    expect(await screen.findByText("Senha alterada.")).toBeTruthy();
  });
});

describe("login sem e-mail", () => {
  it("sem 'Esqueci minha senha'; orienta falar com o administrador", () => {
    auth = fakeAuth({ session: null });
    render(<LoginPage />);
    expect(screen.queryByRole("button", { name: /Esqueci/ })).toBeNull();
    expect(screen.getByText("Esqueceu a senha? Fale com o administrador.")).toBeTruthy();
  });
});
