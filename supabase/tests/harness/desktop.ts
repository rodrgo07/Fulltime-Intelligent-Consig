// MODELO do worker do desktop (apps/desktop/src-tauri/src/worker.rs) para os testes ponta a ponta (D2).
// Reproduz a mesma sequência de RPCs e as mesmas regras (pending-results.json gravado ANTES do envio,
// bloqueio PENDING_RESULTS, ponto sem retorno confirmado no banco), sem Tauri. Diferenças conhecidas:
// sem backoff/retry de rede (with_retry) e sem Realtime — o teste chama cycle() no lugar do polling.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { as, rpc } from "./db";
import type { EngineProcess, JobEvent } from "./engine";

export type PendingResult = {
  job_id: string;
  adhesion_number: string;
  result_status: string | null;
  external_operation_id: string | null;
};

type Current = { job_id: string; request_id: string; side_effect: boolean };

export class FakeDesktop {
  online = true;
  current: Current | null = null;
  blocked: string | null = null;
  readonly log: string[] = [];
  /** Hook de teste: chamado antes de tratar cada evento do motor. */
  beforeEvent: (ev: JobEvent) => void = () => {};
  private chain: Promise<void> = Promise.resolve();

  constructor(private db: PGlite, private boId: string, private engine: EngineProcess, private dataDir: string) {
    engine.onEvent = (ev) => {
      this.beforeEvent(ev); // síncrono: roda antes de qualquer chamada do motor que venha depois do evento
      // Eventos do mesmo job são tratados em ordem (como handle_engine_messages).
      this.chain = this.chain.then(() => this.handleEvent(ev)).catch((e) => void this.log.push(`event error ${e}`));
    };
    engine.onHostCall = async (call) => ({ confirmed: await this.confirmSideEffect(call.params) });
  }

  /** Chamada à API como o backoffice (aal2). Sem rede: falha como o reqwest falharia. */
  async api<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
    if (!this.online) throw new Error("NETWORK");
    return as(this.db, { sub: this.boId, aal: "aal2" }, (tx) => rpc<T>(tx, sql, params));
  }

  // ---------------------------------------------------------------- pending-results.json
  get pendingPath() {
    return join(this.dataDir, "pending-results.json");
  }

  loadPending(): PendingResult[] {
    if (!existsSync(this.pendingPath)) return [];
    try {
      return JSON.parse(readFileSync(this.pendingPath, "utf8")) as PendingResult[];
    } catch {
      return [];
    }
  }

  savePending(items: PendingResult[]) {
    const tmp = `${this.pendingPath.slice(0, -5)}.tmp`;
    writeFileSync(tmp, JSON.stringify(items));
    renameSync(tmp, this.pendingPath);
  }

  async flushPending(): Promise<number> {
    const remaining: PendingResult[] = [];
    for (const item of this.loadPending()) {
      try {
        await this.api("public.complete_job($1, $2, $3, $4)",
          [item.job_id, item.adhesion_number, item.external_operation_id, item.result_status]);
        this.log.push(`complete_job ok ${item.job_id}`);
      } catch (e) {
        this.log.push(`complete_job pendente ${(e as Error).message}`);
        remaining.push(item);
      }
    }
    this.savePending(remaining);
    return remaining.length;
  }

  // ---------------------------------------------------------------- motor → desktop
  private async confirmSideEffect(params: Record<string, unknown>): Promise<boolean> {
    if (this.current?.job_id !== params.job_id) return false;
    try {
      await this.api("public.mark_side_effect_started($1, $2)", [params.job_id, params.step]);
      this.current.side_effect = true;
      return true;
    } catch (e) {
      this.log.push(`mark_side_effect_started falhou ${(e as Error).message}`);
      return false;
    }
  }

  private async handleEvent(ev: JobEvent) {
    if (this.current?.job_id !== ev.job_id) return;
    const d = ev.data;
    const report = async (sql: string, params: unknown[]) => {
      try {
        await this.api(sql, params);
      } catch (e) {
        this.log.push(`report falhou ${sql} ${(e as Error).message}`); // reserva expira e o banco recupera
      }
    };
    switch (ev.type) {
      case "step_started":
      case "heartbeat":
        await report("public.heartbeat_job($1, $2)", [ev.job_id, ev.step]);
        break;
      case "completed": {
        const items = this.loadPending();
        items.push({
          job_id: ev.job_id,
          adhesion_number: String(d.adhesion_number ?? ""),
          result_status: (d.result_status as string) ?? null,
          external_operation_id: (d.external_operation_id as string) ?? null,
        });
        this.savePending(items); // em disco ANTES de enviar
        this.current = null;
        await this.flushPending();
        break;
      }
      case "failed":
        await report("public.fail_job($1, $2, $3, $4)",
          [ev.job_id, d.error_code ?? "ENGINE_ERROR", d.message ?? null, d.retryable ?? false]);
        this.current = null;
        break;
      case "escalated":
        await report("public.escalate_job($1, $2, $3)", [ev.job_id, d.reason_code ?? "NEEDS_HUMAN", d.message ?? null]);
        this.current = null;
        break;
    }
  }

  /** Espera os eventos já recebidos serem tratados. */
  settle() {
    return this.chain;
  }

  // ---------------------------------------------------------------- ciclo da fila (worker.rs::cycle)
  async cycle(): Promise<string | null> {
    try {
      await this.flushPending();
      await this.api("public.acknowledge_received_requests()");
    } catch (e) {
      return (this.blocked = (e as Error).message);
    }
    if (this.current) return (this.blocked = "BUSY");
    if (this.loadPending().length > 0) return (this.blocked = "PENDING_RESULTS");
    const claimed = await this.api<Record<string, unknown> | null>("public.claim_next_job('pc-teste', '0.1.0')");
    if (!claimed) return (this.blocked = "QUEUE_EMPTY");
    this.blocked = null;
    const jobId = String(claimed.job_id);
    this.current = { job_id: jobId, request_id: String(claimed.request_id), side_effect: false };
    try {
      await this.api("public.mark_job_running($1)", [jobId]);
      await this.engine.call("job.execute", {
        job_id: claimed.job_id, request_id: claimed.request_id, public_ref: claimed.public_ref,
        attempt: claimed.attempt, form_version: claimed.form_version, fields: claimed.fields ?? [],
        payload: claimed.payload, deadline_s: 900,
      });
    } catch (e) {
      await this.api("public.release_job($1, $2)", [jobId, (e as Error).message]).catch(() => {});
      this.current = null;
      return (this.blocked = (e as Error).message);
    }
    return null;
  }
}

/** Espera uma condição (poll curto). */
export async function waitFor<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  what: string, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout esperando: ${what}`);
}
