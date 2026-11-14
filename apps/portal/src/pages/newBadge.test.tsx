import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FAKE_UID, fakeApi, fakeAuth } from "../test/fakeAuth";

let auth = fakeAuth();
vi.mock("../auth/AuthProvider", () => ({ useAuth: () => auth }));
const { App } = await import("../App");

// Dados fictícios.
const OTHER_UID = "00000000-0000-4000-8000-000000000002";
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const row = (id: string, ref: string, status: string) => ({
  id, public_ref: ref, submitted_by: FAKE_UID, owner_operator_id: FAKE_UID, form_version: 1, status, status_reason: null,
  received_at: "2026-01-01T12:00:00Z", updated_at: "2026-01-01T12:00:00Z",
  completed_at: status === "completed" ? "2026-01-01T12:05:00Z" : null, pii_expires_at: "2026-01-04T12:00:00Z",
  pii_purged_at: null, proposal_results: null,
});

let rows: ReturnType<typeof row>[] = [];
let realtime: (() => void) | null = null;

function setup(uid = FAKE_UID) {
  const api = fakeApi({
    myRequests: vi.fn(async () => ({ ok: true, data: rows })),
    subscribeMyRequests: vi.fn((cb: () => void) => { realtime = cb; return () => {}; }),
  });
  auth = fakeAuth({
    api, session: { user: { id: uid } },
    profile: { id: uid, role: "operator", display_name: "Operador Teste", active: true },
    operator: { id: uid, operator_code: "OP-TESTE", notification_email: "op@example.test" },
  });
  return render(<App />);
}

const nav = () => screen.getByRole("navigation", { name: "Principal" });
const badge = (ref: string) => screen.queryByRole("button", { name: `Nova: proposta gerada para ${ref}. Marcar como vista` });
const live = () => document.querySelector('[aria-live="polite"][aria-atomic="true"]')!;

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/solicitacoes");
  realtime = null;
});
afterEach(cleanup);

describe("selo 'Nova' de proposta gerada", () => {
  it("1º acesso não marca o que já estava concluído; um evento do Realtime cria o selo, o contador e o anúncio", async () => {
    rows = [row(A, "FIC-000000-TESTEA01", "queued"), row(B, "FIC-000000-TESTEB02", "completed")];
    setup();
    await screen.findByText("FIC-000000-TESTEA01");
    expect(badge("FIC-000000-TESTEB02")).toBeNull();
    expect(document.title).toMatch(/^Minhas solicitações/);

    rows = [row(A, "FIC-000000-TESTEA01", "completed"), row(B, "FIC-000000-TESTEB02", "completed")];
    await act(async () => { realtime!(); });

    const b = await screen.findByRole("button", { name: /Nova: proposta gerada para FIC-000000-TESTEA01/ });
    expect(b.textContent).toBe("Nova"); // texto, não só cor
    await waitFor(() => expect(document.title).toMatch(/^\(1\) Minhas solicitações/));
    expect(within(nav()).getByRole("link", { name: /Minhas solicitações, 1 proposta nova/ })).toBeTruthy();
    await waitFor(() => expect(live().textContent).toBe("Proposta gerada: FIC-000000-TESTEA01"));
  });

  it("some ao abrir (clicar no selo) e continua visto depois de recarregar", async () => {
    localStorage.setItem(`fic:propostas-vistas:${FAKE_UID}`, "[]");
    rows = [row(A, "FIC-000000-TESTEA01", "completed")];
    const first = setup();
    fireEvent.click(await screen.findByRole("button", { name: /Nova: .*TESTEA01/ }));
    expect(badge("FIC-000000-TESTEA01")).toBeNull();
    expect(document.title).not.toMatch(/^\(/);
    first.unmount();

    setup();
    await screen.findByText("FIC-000000-TESTEA01");
    expect(badge("FIC-000000-TESTEA01")).toBeNull();
  });

  it("não visto persiste no reload; 'Marcar todas como vistas' limpa tudo", async () => {
    localStorage.setItem(`fic:propostas-vistas:${FAKE_UID}`, "[]");
    rows = [row(A, "FIC-000000-TESTEA01", "completed"), row(B, "FIC-000000-TESTEB02", "completed")];
    const first = setup();
    await screen.findByRole("button", { name: /Nova: .*TESTEA01/ });
    first.unmount();

    setup();
    await screen.findByRole("button", { name: /Nova: .*TESTEB02/ });
    await waitFor(() => expect(document.title).toMatch(/^\(2\) /));
    fireEvent.click(screen.getByRole("button", { name: "Marcar todas como vistas" }));
    await waitFor(() => expect(badge("FIC-000000-TESTEA01")).toBeNull());
    expect(badge("FIC-000000-TESTEB02")).toBeNull();
    expect(screen.queryByRole("button", { name: "Marcar todas como vistas" })).toBeNull();
  });

  it("isolado por usuário: o que um viu não some para o outro", async () => {
    localStorage.setItem(`fic:propostas-vistas:${FAKE_UID}`, JSON.stringify([A]));
    localStorage.setItem(`fic:propostas-vistas:${OTHER_UID}`, "[]");
    rows = [row(A, "FIC-000000-TESTEA01", "completed")];

    const first = setup(FAKE_UID);
    await screen.findByText("FIC-000000-TESTEA01");
    expect(badge("FIC-000000-TESTEA01")).toBeNull();
    first.unmount();

    setup(OTHER_UID);
    expect(await screen.findByRole("button", { name: /Nova: .*TESTEA01/ })).toBeTruthy();
  });

  it("o contador aparece no menu também em outra página", async () => {
    localStorage.setItem(`fic:propostas-vistas:${FAKE_UID}`, "[]");
    rows = [row(A, "FIC-000000-TESTEA01", "completed")];
    window.history.replaceState(null, "", "/");
    setup();
    expect(await within(nav()).findByText("(1)")).toBeTruthy();
  });
});
