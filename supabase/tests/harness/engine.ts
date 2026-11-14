// Processo REAL do motor Python (services/engine) com o fluxo FALSO de tests/fake_engine.py.
// Fala JSON-RPC 2.0 por stdio, uma mensagem por linha, como o desktop (apps/desktop/src-tauri/src/engine.rs).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const ENGINE_DIR = join(import.meta.dirname, "..", "..", "..", "services", "engine");

export type JobEvent = { job_id: string; type: string; step: string | null; data: Record<string, unknown> };
export type HostCall = { id: string; method: string; params: Record<string, unknown> };
type Msg = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string; data?: Record<string, unknown> } };

const VENV_PYTHON = process.platform === "win32"
  ? join(ENGINE_DIR, ".venv", "Scripts", "python.exe")
  : join(ENGINE_DIR, ".venv", "bin", "python");

/**
 * Prepara o venv do motor (`uv sync --frozen`, como no README/CI). Devolve false se o uv não existe.
 * O processo é iniciado com o python do venv (não via `uv run`) para que kill() derrube o motor de verdade.
 */
export function prepareEngine(): boolean {
  if (spawnSync("uv", ["--version"], { stdio: "ignore" }).status !== 0) return false;
  const r = spawnSync("uv", ["sync", "--frozen"], { cwd: ENGINE_DIR, stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) throw new Error(`uv sync falhou: ${r.stderr}`);
  return true;
}

export class EngineProcess {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];
  private proc: ChildProcess;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private exited: Promise<void>;
  private alive = true;
  onEvent: (ev: JobEvent) => void = () => {};
  onHostCall: (call: HostCall) => Promise<unknown> = async () => ({ confirmed: false });

  constructor(dataDir: string, scenario: string) {
    this.proc = spawn(VENV_PYTHON, [join(ENGINE_DIR, "tests", "fake_engine.py"), "--data-dir", dataDir, "--scenario", scenario], {
      cwd: ENGINE_DIR,
      env: { ...process.env, FIC_FAKE_ENGINE_FOR_TESTS: "1", PYTHONUTF8: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((res) => this.proc.once("exit", () => {
      this.alive = false;
      res();
    }));
    createInterface({ input: this.proc.stderr! }).on("line", (l) => this.stderr.push(l));
    createInterface({ input: this.proc.stdout! }).on("line", (line) => {
      this.stdout.push(line);
      const m = JSON.parse(line) as Msg;
      if (m.method === "job.event") return this.onEvent(m.params as JobEvent);
      if (typeof m.id === "string" && m.method) {
        // Mesma regra do desktop: só host.confirm_side_effect é aceito.
        const reply = m.method === "host.confirm_side_effect"
          ? this.onHostCall({ id: m.id, method: m.method, params: m.params ?? {} })
          : Promise.resolve({ confirmed: false });
        void reply.then((result) => this.write({ jsonrpc: "2.0", id: m.id, result }));
        return;
      }
      if (typeof m.id === "number") {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(Object.assign(new Error(String(m.error.data?.code ?? m.error.message)), { rpc: m.error }));
        else p?.resolve(m.result);
      }
    });
  }

  private write(msg: unknown) {
    this.proc.stdin!.write(`${JSON.stringify(msg)}\n`);
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v as T); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Encerramento normal (engine.shutdown + fim do stdin). */
  async stop() {
    if (!this.alive) return;
    await this.call("engine.shutdown", {}, 5_000).catch(() => {});
    this.proc.stdin!.end();
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 5_000))]);
    if (this.alive) await this.kill();
  }

  /** Queda abrupta (app/PC desligado no meio do job). */
  kill() {
    if (this.alive) this.proc.kill("SIGKILL");
    return this.exited;
  }

  allOutput(): string {
    return [...this.stdout, ...this.stderr].join("\n");
  }
}
