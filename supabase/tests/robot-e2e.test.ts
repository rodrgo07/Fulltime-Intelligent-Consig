// Ponta a ponta: robô Python REAL (Worker + SupabaseApi + fluxo falso) ↔ PostgREST simulado ↔ banco PGlite.
// Prova que os nomes de função e de parâmetro que o robô envia batem com as funções SQL.
// Nada aqui toca o Consig, o Supabase real ou dados reais. Pulado se não houver Python com httpx.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { activateTestForm, as, createMember, FAKE_CPF, freshDb, rpc } from "./harness/db";

const ROBOT = join(import.meta.dirname, "..", "..", "services", "robot");
const PY = [join(ROBOT, ".venv", "Scripts", "python.exe"), join(ROBOT, ".venv", "bin", "python"), "python3", "python"]
  .find((p) => {
    if (p.includes(".venv") && !existsSync(p)) return false;
    return spawnSync(p, ["-c", "import httpx"], { stdio: "ignore" }).status === 0;
  });
if (!PY && process.env.FIC_REQUIRE_E2E === "1") throw new Error("FIC_REQUIRE_E2E=1, mas não há Python com httpx");

let db: PGlite;
let op: string;
let bo: string;
let server: Server;
let url: string;
let dir: string;

/** PostgREST mínimo: POST /rest/v1/rpc/<nome> com {p_x: ...} → select public.<nome>(p_x => $1, ...) como backoffice aal2. */
function startPostgrest(): Promise<void> {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const name = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(req.url ?? "")?.[1];
      if (req.method !== "POST" || !name) {
        res.writeHead(404).end();
        return;
      }
      const params = JSON.parse(body || "{}") as Record<string, unknown>;
      const keys = Object.keys(params);
      if (keys.some((k) => !/^p_[a-z_]+$/.test(k))) {
        res.writeHead(400).end();
        return;
      }
      const args = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
      const values = keys.map((k) => (params[k] === null ? null : typeof params[k] === "object" ? JSON.stringify(params[k]) : String(params[k])));
      try {
        const out = await as(db, { sub: bo, aal: "aal2" }, (tx) => rpc(tx, `public.${name}(${args})`, values));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out ?? null));
      } catch (e) {
        const err = e as { code?: string; message: string; detail?: string };
        res.writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ code: err.code, message: err.message, details: err.detail ?? null }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    resolve();
  }));
}

/** Roda o robô por N voltas (processo real) e devolve o resultado de cada tick. */
async function robot(rounds: number, env: Record<string, string> = {}): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(PY!, [join(ROBOT, "tests", "e2e_driver.py"), url, dir, String(rounds)], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8", ...env },
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => {
      if (code !== 0) reject(new Error(`robô saiu com ${code}: ${err}`));
      else resolve(out.trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { outcome: string }).outcome));
    });
  });
}

const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const submit = (cpf = FAKE_CPF[0]) => as(db, { sub: op }, (tx) => rpc<{ request_id: string; public_ref: string }>(tx,
  "public.submit_proposal_request($1, 1, $2::jsonb)",
  [crypto.randomUUID(), JSON.stringify({ documento: cpf, nome_teste: "Cliente Fictício E2E", valor_teste: 1000 })]));

describe.skipIf(!PY)("robô ponta a ponta (fluxo falso)", () => {
  beforeEach(async () => {
    db = await freshDb();
    await activateTestForm(db);
    op = await createMember(db, "operator");
    bo = await createMember(db, "backoffice");
    dir = mkdtempSync(join(tmpdir(), "fic-robot-e2e-"));
    await startPostgrest();
  }, 30_000);
  afterEach(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("gera a proposta, grava o número capturado, conclui e apaga os dados pessoais", async () => {
    const r = await submit();
    expect(await robot(2)).toEqual(["completed", "idle"]);
    const req = await one<{ status: string; pii_purged_at: Date | null }>(
      "select status, pii_purged_at from public.proposal_requests where id = $1", [r.request_id]);
    expect(req.status).toBe("completed");
    expect(req.pii_purged_at).not.toBeNull();
    const res = await one<{ adhesion_number: string; source: string }>("select adhesion_number, source from public.proposal_results");
    expect(res).toEqual({ adhesion_number: `FALSO-${r.public_ref.slice(-8)}`, source: "rpa" });
    const job = await one<{ captured_adhesion_number: string; side_effect_started_at: Date | null }>(
      "select captured_adhesion_number, side_effect_started_at from public.automation_jobs");
    expect(job.captured_adhesion_number).toBe(res.adhesion_number);
    expect(job.side_effect_started_at).not.toBeNull();
    const st = await one<{ version: string; flow_ready: boolean; last_seen_at: Date | null }>(
      "select version, flow_ready, last_seen_at from public.robot_state");
    expect(st).toMatchObject({ version: "2.0.0", flow_ready: true });
    expect(readFileSync(join(dir, "pending-results.json"), "utf8").trim()).toBe("[]");
  }, 60_000);

  it("tela inesperada depois do envio vai para confirmação humana com mensagem sem CPF", async () => {
    const r = await submit();
    expect(await robot(2, { FIC_FAKE_SCENARIO: "unexpected_after_submit" })).toEqual(["escalated", "idle"]);
    const req = await one<{ status: string }>("select status from public.proposal_requests where id = $1", [r.request_id]);
    expect(req.status).toBe("awaiting_confirmation");
    const job = await one<{ error_code: string; error_message: string }>("select error_code, error_message from public.automation_jobs");
    expect(job.error_code).toBe("UNEXPECTED_SCREEN");
    expect(job.error_message).not.toContain(FAKE_CPF[0]);
  }, 60_000);

  it("pausa e retomada pelo painel chegam ao robô", async () => {
    await submit();
    await as(db, { sub: bo, aal: "aal2" }, (tx) => rpc(tx, "public.robot_command('pause')"));
    expect(await robot(1)).toEqual(["paused"]);
    expect((await one<{ paused: boolean }>("select paused from public.robot_state")).paused).toBe(true);
    expect((await one<{ n: number }>("select count(*)::int n from public.automation_jobs")).n).toBe(0);
    await as(db, { sub: bo, aal: "aal2" }, (tx) => rpc(tx, "public.robot_command('resume')"));
    expect(await robot(1)).toEqual(["completed"]);
  }, 60_000);

  it("resultado pendente de um processo anterior é enviado antes de reservar outro job", async () => {
    const r = await submit();
    // Simula: o processo anterior gerou a proposta e caiu antes do complete_job.
    const job = await as(db, { sub: bo, aal: "aal2" }, async (tx) => {
      await rpc(tx, "public.acknowledge_received_requests()");
      const j = await rpc<{ job_id: string }>(tx, "public.claim_next_job('pc-anterior', '2.0.0')");
      await rpc(tx, "public.mark_job_running($1)", [j.job_id]);
      await rpc(tx, "public.mark_side_effect_started($1, 'enviar_falso')", [j.job_id]);
      return j;
    });
    writeFileSync(join(dir, "pending-results.json"), JSON.stringify([
      { job_id: job.job_id, request_id: r.request_id, adhesion_number: "ADE-PENDENTE", result_status: "GERADA", external_operation_id: null },
    ]));
    const second = await submit(FAKE_CPF[1]);
    expect(await robot(2)).toEqual(["completed", "idle"]);
    const adhesion = async (id: string) =>
      (await one<{ adhesion_number: string }>("select adhesion_number from public.proposal_results where request_id = $1", [id]))
        ?.adhesion_number;
    expect(await adhesion(r.request_id)).toBe("ADE-PENDENTE");
    expect(await adhesion(second.request_id)).toBe(`FALSO-${second.public_ref.slice(-8)}`);
    // Ordem: a auditoria usa id sequencial (o relógio do Windows pode repetir o mesmo instante).
    const order = (await db.query<{ action: string; request_id: string }>(
      "select action, request_id from public.audit_logs where action in ('request.completed', 'job.claimed') order by id")).rows
      .map((a) => `${a.action}:${a.request_id === r.request_id ? "antigo" : "novo"}`);
    expect(order).toEqual(["job.claimed:antigo", "request.completed:antigo", "job.claimed:novo", "request.completed:novo"]);
  }, 60_000);
});

