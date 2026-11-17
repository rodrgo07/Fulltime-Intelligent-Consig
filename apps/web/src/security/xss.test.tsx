// D3 — XSS no portal: todo texto vindo do banco/servidor é exibido como texto, nunca como HTML.
// Dados 100% fictícios. Fonte dos textos: form_definitions (admin), resultados (backoffice), membros (admin).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toApiError, type FormField } from "@fic/contracts";
import HEADERS from "../../public/_headers?raw";

const auth = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../auth/AuthProvider", () => ({ useAuth: () => auth.value }));

import { DynamicForm } from "../components/DynamicForm";
import { AdminPage } from "../pages/AdminPage";
import { NewRequestPage } from "../pages/NewRequestPage";
import { RequestsPage } from "../pages/RequestsPage";

const PAYLOADS = [
  `<img src=x onerror="window.__xss=1">`,
  `<script>window.__xss=1</script>`,
  `"><svg onload="window.__xss=1"></svg>`,
  `<iframe src="javascript:window.__xss=1"></iframe>`,
];
const X = PAYLOADS.join(" ");
// svg:not(.lucide) — os ícones lucide-react são SVG legítimos dos componentes.
const DANGEROUS = "script, img, svg:not(.lucide), iframe, object, embed, [onerror], [onload]";

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
const user = { id: "00000000-0000-4000-8000-000000000001" };

function expectInert(container: HTMLElement) {
  expect(container.querySelector(DANGEROUS)).toBeNull();
  expect((window as { __xss?: number }).__xss).toBeUndefined();
}

beforeEach(() => {
  delete (window as { __xss?: number }).__xss;
});
afterEach(cleanup);

describe("D3 — XSS: textos do servidor são exibidos como texto", () => {
  it("DynamicForm: rótulo, ajuda e opções vindos da definição do formulário", () => {
    const fields: FormField[] = [
      { key: "campo_a", label: PAYLOADS[0], type: "text", help: PAYLOADS[1] },
      { key: "campo_b", label: "Opção", type: "select", options: [{ value: PAYLOADS[2], label: PAYLOADS[3] }] },
    ];
    const { container } = render(<DynamicForm fields={fields} busy={false} serverErrors={[]} onSubmit={() => {}} />);
    expectInert(container);
    expect(container.textContent).toContain(PAYLOADS[0]);
    expect(container.textContent).toContain(PAYLOADS[1]);
    expect(screen.getByRole("option", { name: PAYLOADS[3] })).toBeTruthy();
  });

  it("DynamicForm: código de erro desconhecido do servidor não vira HTML", () => {
    const { container } = render(<DynamicForm fields={[]} busy={false} onSubmit={() => {}}
      serverErrors={[{ field: null, code: PAYLOADS[0] }]} />);
    expectInert(container);
  });

  it("NewRequestPage: título do formulário, referência e detalhe do erro DUPLICATE_REQUEST", async () => {
    auth.value = {
      operator: { id: user.id, operator_code: PAYLOADS[1], notification_email: "op@exemplo.test" },
      api: {
        activeForm: () => ok({ version: 1, title: X, fields: [{ key: "nome_teste", label: "Nome", type: "text" }] }),
        submit: () => Promise.resolve({ ok: false as const, error: toApiError({ message: "DUPLICATE_REQUEST", details: X }) }),
      },
    };
    const { container } = render(<NewRequestPage />);
    await screen.findByRole("heading", { level: 1 });
    fireEvent.change(screen.getByLabelText(/Nome/), { target: { value: "Teste" } });
    fireEvent.submit(container.querySelector("form")!);
    await screen.findByRole("alert");
    expectInert(container);
    expect(screen.getByRole("alert").textContent).toContain(PAYLOADS[0]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(X);
  });

  it("RequestsPage: referência e número de adesão (digitado pelo backoffice na resolução manual)", async () => {
    auth.value = {
      session: { user },
      api: {
        myRequests: () => ok([{
          id: "r1", public_ref: PAYLOADS[2], submitted_by: user.id, owner_operator_id: user.id, form_version: 1,
          status: "completed", status_reason: X, received_at: "2026-11-12T10:00:00Z", updated_at: "2026-11-12T10:05:00Z",
          completed_at: "2026-11-12T10:05:00Z", pii_expires_at: "2026-11-15T10:00:00Z", pii_purged_at: "2026-11-12T10:05:00Z",
          proposal_results: { request_id: "r1", adhesion_number: PAYLOADS[0], external_operation_id: null,
            result_status: PAYLOADS[1], completed_at: "2026-11-12T10:05:00Z", source: "manual" },
        }]),
        backofficePresence: () => ok(null),
        subscribeMyRequests: () => () => {},
      },
    };
    const { container } = render(<RequestsPage />);
    await waitFor(() => expect(container.querySelector("tbody tr")).not.toBeNull());
    expectInert(container);
    expect(container.textContent).toContain(PAYLOADS[0]);
    expect(container.textContent).toContain(PAYLOADS[2]);
  });

  it("AdminPage: nome e e-mail de membros", async () => {
    auth.value = {
      session: { user },
      api: {
        members: () => ok([{
          id: "m1", role: "operator", display_name: X, active: true, created_at: "2026-11-12T10:00:00Z",
          operators: { operator_code: PAYLOADS[3], notification_email: PAYLOADS[0] },
        }]),
      },
    };
    const { container } = render(<AdminPage />);
    await waitFor(() => expect(container.querySelector("tbody tr")).not.toBeNull());
    expectInert(container);
    expect(container.textContent).toContain(PAYLOADS[1]);
  });

  it("toApiError não reflete a mensagem crua do servidor", () => {
    const e = toApiError({ message: PAYLOADS[1] });
    expect(e.code).toBe("UNKNOWN");
    expect(e.message).toBe("Não foi possível concluir a operação.");
  });
});

// ---------------------------------------------------------------- verificações estáticas
// Leitura dos fontes via Vite (sem @types/node no portal). Caminhos relativos a este arquivo.
const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const SOURCES = Object.fromEntries(Object.entries({
  ...raw(import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true })),
}).filter(([f]) => !/\.test\./.test(f)));
const directive = (csp: string, name: string) =>
  csp.split(";").map((d) => d.trim().split(/\s+/)).find(([n]) => n === name)?.slice(1) ?? null;

describe("D3 — XSS: barreiras estáticas", () => {
  it("o site (operador, backoffice e admin) não usa sinks de HTML/código dinâmico", () => {
    const sinks = /dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/;
    const files = Object.keys(SOURCES);
    expect(files.some((f) => f.includes("pages/RequestsPage.tsx"))).toBe(true);
    expect(files.some((f) => f.includes("pages/backoffice/BackofficePages.tsx"))).toBe(true);
    expect(files.filter((f) => sinks.test(SOURCES[f]))).toEqual([]);
  });

  it("CSP do portal (Cloudflare _headers) bloqueia script inline, plugins, framing e base", () => {
    const headers = HEADERS;
    const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1] ?? "";
    expect(directive(csp, "script-src")).toEqual(["'self'"]);
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp, "base-uri")).toEqual(["'none'"]);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*\s|data:\s*;?\s*script/);
    expect(headers).toMatch(/X-Content-Type-Options:\s*nosniff/);
  });
});
