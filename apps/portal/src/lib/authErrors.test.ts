import { describe, expect, it } from "vitest";
import { ERROR_MESSAGE } from "@fic/contracts";
import { authErrorMessage } from "./authErrors";

describe("authErrorMessage", () => {
  it("rede tem mensagem própria", () => {
    expect(authErrorMessage({ name: "AuthRetryableFetchError", status: 0 }, "x")).toBe(ERROR_MESSAGE.NETWORK);
  });
  it("limite de tentativas tem mensagem própria", () => {
    expect(authErrorMessage({ status: 429 }, "x")).toMatch(/Aguarde/);
    expect(authErrorMessage({ code: "over_request_rate_limit", status: 400 }, "x")).toMatch(/Aguarde/);
  });
  it("troca de senha: mesma senha e senha fraca", () => {
    expect(authErrorMessage({ code: "same_password", status: 422 }, "x")).toMatch(/diferente da atual/);
    expect(authErrorMessage({ code: "weak_password", status: 422 }, "x")).toMatch(/Senha fraca/);
  });
  it("credencial inválida mantém o texto neutro (não revela se o e-mail existe)", () => {
    expect(authErrorMessage({ status: 400, code: "invalid_credentials" }, "neutro")).toBe("neutro");
    expect(authErrorMessage(null, "neutro")).toBe("neutro");
  });
});
