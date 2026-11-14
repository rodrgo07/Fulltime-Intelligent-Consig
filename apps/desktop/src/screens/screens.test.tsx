import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_CONFIG, DEFAULT_WORKER, defaultHandlers, installTauri, type Handler } from "../test/fakeTauri";

let tauri = installTauri(defaultHandlers());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => tauri.invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { ConsigSession } = await import("./ConsigSession");
const { Automation } = await import("./Automation");

const use = (overrides: Record<string, Handler> = {}) => { tauri = installTauri({ ...defaultHandlers(), ...overrides }); };

afterEach(cleanup);

describe("ConsigSession", () => {
  it("instrui o login humano sem guardar senha e mostra o estado da sessão", async () => {
    use({ worker_status: () => ({ ...DEFAULT_WORKER, consig_session: "open_unverified" }) });
    render(<ConsigSession onNavigate={() => {}} />);
    expect(screen.getByRole("heading", { level: 1, name: "Abrir Consig" })).toBeTruthy();
    expect(screen.getByText(/não lê, não grava e não envia/)).toBeTruthy();
    expect(await screen.findByText("Aberta (verificação não mapeada)")).toBeTruthy();
    expect(screen.getByText(/nenhuma solicitação é processada/)).toBeTruthy();
  });

  it("sem endereço inicial, avisa e leva a Configurações → Motor RPA", async () => {
    use();
    const onNavigate = vi.fn();
    render(<ConsigSession onNavigate={onNavigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Configurações → Motor RPA" }));
    expect(onNavigate).toHaveBeenCalledWith("settings", "Motor RPA");
  });

  it("abre o navegador e informa o resultado; erro do motor vira alerta legível", async () => {
    use({ config_get: () => ({ ...DEFAULT_CONFIG, consig_start_url: "https://exemplo.invalid/" }), consig_session_open: () => ({ state: "open_unverified" }) });
    render(<ConsigSession onNavigate={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir Consig" }));
    expect(await screen.findByText(/Navegador aberto · sessão: Aberta/)).toBeTruthy();

    cleanup();
    use({ consig_session_open: () => { throw { code: "BROWSER_MISSING" }; } });
    render(<ConsigSession onNavigate={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir Consig" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Google Chrome não encontrado neste computador.");
  });

  it("Chrome ausente desabilita o botão", async () => {
    use({ diagnostics: () => ({ chrome_installed: false }) });
    render(<ConsigSession onNavigate={() => {}} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Abrir Consig" }) as HTMLButtonElement).disabled).toBe(true));
  });
});

const req = {
  id: "00000000-0000-4000-8000-0000000000aa", public_ref: "FIC-000000-TESTE001", status: "queued", status_reason: "LEASE_EXPIRED",
  received_at: "2026-01-01T12:00:00Z", updated_at: "2026-01-01T12:00:00Z", completed_at: null, pii_expires_at: "2026-01-04T12:00:00Z",
  pii_purged_at: null, form_version: 1, submitter: { operator_code: "OP-0001" }, owner: { operator_code: "OP-0001" },
  proposal_results: null, automation_jobs: [],
};

describe("Automation", () => {
  it("estado de erro com nova tentativa e estado vazio por filtro", async () => {
    let fail = true;
    use({ requests_list: () => { if (fail) throw { code: "NETWORK" }; return []; } });
    render(<Automation />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Sem conexão/);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText("Nenhuma solicitação recebida ainda.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Falha" }));
    expect(await screen.findByText("Nenhuma solicitação no estado “Falha”.")).toBeTruthy();
  });

  it("linha acessível por teclado: botão abre o painel, Esc fecha e devolve o foco", async () => {
    use({
      requests_list: () => [req],
      request_detail: () => ({ request: req, audit: [] }),
    });
    render(<Automation />);
    const rowBtn = await screen.findByRole("button", { name: "FIC-000000-TESTE001" });
    expect(screen.getByText("Reserva expirada; devolvida à fila.")).toBeTruthy();
    expect(rowBtn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(rowBtn);
    const heading = await screen.findByRole("heading", { level: 2, name: "FIC-000000-TESTE001" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(rowBtn.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Nenhum evento registrado.")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "FIC-000000-TESTE001" })));
  });
});
