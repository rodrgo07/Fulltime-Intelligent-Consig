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
    markPasswordChanged: vi.fn(async () => ({ ok: true, data: null })),
    ...overrides,
  };
}

export function fakeAuth(overrides: Record<string, unknown> = {}) {
  return {
    loading: false,
    session: { user: { id: FAKE_UID } },
    profile: { id: FAKE_UID, role: "operator", display_name: "Operador Teste", active: true, must_change_password: false },
    operator: { id: FAKE_UID, operator_code: "OP-TESTE" },
    aal: "aal1",
    loadError: null,
    api: fakeApi(),
    sb: { auth: { updateUser: vi.fn(async () => ({ data: {}, error: null })) } },
    refresh: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    ...overrides,
  };
}
