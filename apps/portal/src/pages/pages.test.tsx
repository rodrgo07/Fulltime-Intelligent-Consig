import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiError, FAKE_UID, fakeApi, fakeAuth } from "../test/fakeAuth";

let auth = fakeAuth();
vi.mock("../auth/AuthProvider", () => ({ useAuth: () => auth }));

const { RequestsPage } = await import("./RequestsPage");
const { NewRequestPage } = await import("./NewRequestPage");
const { AdminPage } = await import("./AdminPage");

beforeEach(() => { auth = fakeAuth(); });
afterEach(cleanup);

const row = (over: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-8000-0000000000aa", public_ref: "FIC-000000-TESTE001", submitted_by: FAKE_UID,
  owner_operator_id: FAKE_UID, form_version: 1, status: "queued", status_reason: null,
  received_at: "2026-01-01T12:00:00Z", updated_at: "2026-01-01T12:00:00Z", completed_at: null,
  pii_expires_at: "2026-01-04T12:00:00Z", pii_purged_at: null, proposal_results: null, ...over,
});

describe("RequestsPage", () => {
  it("mostra carregando e depois o estado vazio com ação", async () => {
    render(<RequestsPage />);
    expect(screen.getByRole("status").textContent).toMatch(/Carregando solicitações/);
    expect(await screen.findByText("Nenhuma solicitação enviada")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nova solicitação" })).toBeTruthy();
  });

  it("falha na primeira carga mostra erro com nova tentativa (não fica em 'Carregando')", async () => {
    const myRequests = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: apiError("NETWORK", "Sem conexão com o servidor. Tente novamente.") })
      .mockResolvedValue({ ok: true, data: [row()] });
    auth = fakeAuth({ api: fakeApi({ myRequests }) });
    render(<RequestsPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Sem conexão/);
    expect(screen.queryByText(/Carregando/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText("FIC-000000-TESTE001")).toBeTruthy();
  });

  it("exibe o motivo conhecido e esconde texto livre", async () => {
    auth = fakeAuth({ api: fakeApi({ myRequests: vi.fn(async () => ({ ok: true, data: [
      row({ status: "queued", status_reason: "LEASE_EXPIRED" }),
      row({ id: "00000000-0000-4000-8000-0000000000bb", public_ref: "FIC-000000-TESTE002", status: "cancelled", status_reason: "Texto livre interno" }),
    ] })) }) });
    render(<RequestsPage />);
    expect(await screen.findByText("Reserva expirada; devolvida à fila.")).toBeTruthy();
    expect(screen.queryByText("Texto livre interno")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancelar a solicitação FIC-000000-TESTE001" })).toBeTruthy();
  });

  it("presença do backoffice indisponível não é confundida com 'conectado'", async () => {
    auth = fakeAuth({ api: fakeApi({ backofficePresence: vi.fn(async () => ({ ok: false, error: apiError("NETWORK") })) }) });
    render(<RequestsPage />);
    expect(await screen.findByText("Backoffice: estado indisponível")).toBeTruthy();
  });
});

describe("NewRequestPage", () => {
  it("erro ao carregar o formulário oferece nova tentativa", async () => {
    const activeForm = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: apiError("NETWORK", "Sem conexão") })
      .mockResolvedValue({ ok: true, data: null });
    auth = fakeAuth({ api: fakeApi({ activeForm }) });
    render(<NewRequestPage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Não foi possível carregar o formulário/);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText("Formulário ainda não configurado")).toBeTruthy();
  });

  it("erro de envio recebe o foco e mostra a referência do duplicado", async () => {
    const form = { version: 1, title: "Formulário de teste", fields: [{ key: "campo_teste", label: "Campo de teste", type: "text" }] };
    const submit = vi.fn(async () => ({ ok: false, error: { ...apiError("DUPLICATE_REQUEST", "Já existe uma solicitação"), detail: "FIC-000000-TESTE009" } }));
    auth = fakeAuth({ api: fakeApi({ activeForm: vi.fn(async () => ({ ok: true, data: form })), submit }) });
    render(<NewRequestPage />);
    fireEvent.change(await screen.findByLabelText("Campo de teste"), { target: { value: "valor fictício" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitação" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/FIC-000000-TESTE009/);
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });
});

describe("AdminPage", () => {
  it("erro na lista de membros oferece nova tentativa", async () => {
    auth = fakeAuth({ api: fakeApi({ members: vi.fn(async () => ({ ok: false, error: apiError("FORBIDDEN", "Sem permissão") })) }) });
    render(<AdminPage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Não foi possível carregar os membros/);
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeTruthy();
  });

  it("lista com cabeçalhos de tabela e ação com nome acessível", async () => {
    const members = [
      { id: FAKE_UID, role: "admin", display_name: "Admin Teste", active: true, created_at: "2026-01-01T00:00:00Z", operators: null },
      { id: "00000000-0000-4000-8000-000000000002", role: "operator", display_name: "Operador Fictício", active: true,
        created_at: "2026-01-02T00:00:00Z", operators: { operator_code: "OP-0002", notification_email: "op2@example.test" } },
    ];
    auth = fakeAuth({ api: fakeApi({ members: vi.fn(async () => ({ ok: true, data: members })) }) });
    render(<AdminPage />);
    expect(await screen.findByRole("button", { name: "Desativar o acesso de Operador Fictício" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader").length).toBe(7);
    expect(screen.getByText("Você")).toBeTruthy();
  });
});
