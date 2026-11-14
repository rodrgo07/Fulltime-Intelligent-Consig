import { describe, expect, it } from "vitest";
import { ERROR_MESSAGE } from "@fic/contracts";
import { authErrorMessage } from "./authErrors";

describe("authErrorMessage", () => {
  it("rede tem mensagem própria", () => {
    expect(authErrorMessage({ name: "AuthRetryableFetchError", status: 0 }, "x")).toBe(ERROR_MESSAGE.NETWORK);
  });
  it("limite de tentativas tem mensagem própria", () => {
    expect(authErrorMessage({ status: 429 }, "x")).toMatch(/Aguarde/);
    expect(authErrorMessage({ code: "over_email_send_rate_limit", status: 400 }, "x")).toMatch(/Aguarde/);
  });
  it("credencial inválida mantém o texto neutro (não revela se o e-mail existe)", () => {
    expect(authErrorMessage({ status: 400, code: "invalid_credentials" }, "neutro")).toBe("neutro");
    expect(authErrorMessage(null, "neutro")).toBe("neutro");
  });
});
