import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { robotOffline } from "@fic/contracts";
import { createApi } from "../../lib/api";
import { apiError, fakeApi, fakeAuth, FAKE_UID } from "../../test/fakeAuth";

let auth = fakeAuth();
vi.mock("../../auth/AuthProvider", () => ({ useAuth: () => auth }));

const { App } = await import("../../App");

const now = new Date().toISOString();
const robot = (extra = {}) => ({
  paused: false, consig_session: "authenticated", current_step: null, current_job_id: null, version: "2.0.0",
  flow_ready: true, ai_enabled: false, ai_model: null, last_seen_at: now, ...extra,
});
const awaitingRow = (captured: string | null) => ({
  id: "r1", public_ref: "FIC-261117-AAAAAAAA", status: "awaiting_confirmation", status_reason: "UNEXPECTED_SCREEN",
  received_at: now, pii_purged_at: null, proposal_results: null,
  automation_jobs: [{ id: "j1", request_id: "r1", attempt: 1, status: "awaiting_confirmation", current_step: "enviar",
    side_effect_started_at: now, error_code: "UNEXPECTED_SCREEN", error_message: null, captured_adhesion_number: captured,
    created_at: now }],
});

function backoffice(api: Record<string, unknown> = {}) {
  return fakeAuth({
    profile: { id: FAKE_UID, role: "backoffice", display_name: "Backoffice Teste", active: true },
    operator: null,
    aal: "aal2",
    api: fakeApi({
      dashboardCounts: vi.fn(async () => ({ ok: true, data: { awaiting_confirmation: 2, queued: 5 } })),
      robotState: vi.fn(async () => ({ ok: true, data: robot() })),
      requestsByStatus: vi.fn(async () => ({ ok: true, data: [] })),
      robotCommand: vi.fn(async () => ({ ok: true, data: 1 })),
      resolveAwaiting: vi.fn(async () => ({ ok: true, data: {} })),
      auditLogs: vi.fn(async () => ({ ok: true, data: [] })),
      ...api,
    }),
  });
}

beforeEach(() => window.history.replaceState(null, "", "/painel"));
afterEach(cleanup);

describe("área Backoffice", () => {
  it("painel mostra contagens, estado do robô e o contador no título da aba", async () => {
    auth = backoffice();
    render(<App />);
    await screen.findByText("Logado");
    expect(document.title).toMatch(/^\(2\) Painel/);
    expect(screen.queryByText(/Robô sem sinal/)).toBeNull();
  });

  it("robô sem sinal há mais de 2 min acende o alerta", async () => {
    auth = backoffice({ robotState: vi.fn(async () => ({ ok: true, data: robot({ last_seen_at: new Date(Date.now() - 180_000).toISOString() }) })) });
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/sem sinal/);
  });

  it("com número capturado pelo robô, só oferece concluir (sem reprocessar/falhar/cancelar)", async () => {
    window.history.replaceState(null, "", "/automacao");
    auth = backoffice({ requestsByStatus: vi.fn(async () => ({ ok: true, data: [awaitingRow("ADE-777")] })) });
    render(<App />);
    expect(await screen.findByText("ADE-777")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reprocessar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Marcar falha" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Concluir" }));
    await waitFor(() => expect(auth.api.resolveAwaiting).toHaveBeenCalledWith("r1", "completed", "ADE-777"));
  });

  it("sem número capturado, reprocessar fica disponível", async () => {
    window.history.replaceState(null, "", "/automacao");
    auth = backoffice({ requestsByStatus: vi.fn(async () => ({ ok: true, data: [awaitingRow(null)] })) });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Reprocessar" }));
    await waitFor(() => expect(auth.api.resolveAwaiting).toHaveBeenCalledWith("r1", "requeue"));
  });

  it("comandos do robô vão pela API e erros aparecem", async () => {
    window.history.replaceState(null, "", "/robo");
    auth = backoffice({ robotCommand: vi.fn(async () => ({ ok: false, error: apiError("FORBIDDEN", "Sem permissão.") })) });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Pausar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Sem permissão.");
    expect(auth.api.robotCommand).toHaveBeenCalledWith("pause");
  });
});

describe("contratos v2", () => {
  it("robotOffline: nunca visto ou > 2 min", () => {
    expect(robotOffline(null)).toBe(true);
    expect(robotOffline({ last_seen_at: new Date(1_000).toISOString() }, 1_000 + 119_000)).toBe(false);
    expect(robotOffline({ last_seen_at: new Date(1_000).toISOString() }, 1_000 + 121_000)).toBe(true);
  });

  it("submit converte o retorno {error: RATE_LIMITED} em erro", async () => {
    const sb = { rpc: vi.fn(async () => ({ data: { error: "RATE_LIMITED" }, error: null })) };
    const r = await createApi(sb as never).submit(crypto.randomUUID(), 1, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RATE_LIMITED");
  });
});
