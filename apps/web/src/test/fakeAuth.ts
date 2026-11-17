// Contexto de autenticação falso para testes de tela. Somente dados fictícios.
import { vi } from "vitest";
import type { ApiError } from "@fic/contracts";

export const FAKE_UID = "00000000-0000-4000-8000-000000000001";

export const apiError = (code: string, message = `msg ${code}`): ApiError => ({ code, message, fields: [] });

export function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    myRequests: vi.fn(async () => ({ ok: true, data: [] })),
    backofficePresence: vi.fn(async () => ({ ok: true, data: null })),
    subscribeMyRequests: vi.fn(() => () => {}),
    cancel: vi.fn(async () => ({ ok: true, data: null })),
    activeForm: vi.fn(async () => ({ ok: true, data: null })),
    submit: vi.fn(),
    members: vi.fn(async () => ({ ok: true, data: [] })),
    setMemberActive: vi.fn(async () => ({ ok: true, data: null })),
    invite: vi.fn(async () => ({ ok: true, data: {} })),
    // backoffice
    dashboardCounts: vi.fn(async () => ({ ok: true, data: {} })),
    robotState: vi.fn(async () => ({ ok: true, data: null })),
    requestsByStatus: vi.fn(async () => ({ ok: true, data: [] })),
    resolveAwaiting: vi.fn(async () => ({ ok: true, data: {} })),
    requeueFailed: vi.fn(async () => ({ ok: true, data: null })),
    cancelBackoffice: vi.fn(async () => ({ ok: true, data: null })),
    robotCommand: vi.fn(async () => ({ ok: true, data: 1 })),
    robotSetAi: vi.fn(async () => ({ ok: true, data: null })),
    auditLogs: vi.fn(async () => ({ ok: true, data: [] })),
    ...overrides,
  };
}

export function fakeAuth(overrides: Record<string, unknown> = {}) {
  return {
    loading: false,
    session: { user: { id: FAKE_UID } },
    profile: { id: FAKE_UID, role: "operator", display_name: "Operador Teste", active: true },
    operator: { id: FAKE_UID, operator_code: "OP-TESTE", notification_email: "operador@example.test" },
    aal: "aal1",
    needsPassword: false,
    loadError: null,
    api: fakeApi(),
    sb: {},
    refresh: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    clearNeedsPassword: vi.fn(),
    ...overrides,
  };
}
