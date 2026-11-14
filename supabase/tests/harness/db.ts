import { PGlite, type Transaction } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

export type Claims = { sub?: string; aal?: "aal1" | "aal2"; role?: string };

const migrationFiles = () => readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();

/** Aplica as migrations em ordem; com `before`, só as de nome menor (simula um banco já em produção). */
export async function applyMigrations(db: PGlite, opts: { before?: string; from?: string } = {}) {
  for (const file of migrationFiles()) {
    if (opts.before && file >= opts.before) continue;
    if (opts.from && file < opts.from) continue;
    await db.exec(readFileSync(join(root, "migrations", file), "utf8"));
  }
}

/** Banco novo com stubs do Supabase + todas as migrations, na ordem. */
export async function freshDb(opts: { before?: string } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(readFileSync(join(root, "tests/harness/supabase-stubs.sql"), "utf8"));
  await applyMigrations(db, opts);
  return db;
}

/** Executa como um usuário da API (papel authenticated), como o PostgREST faria. */
export async function as<T>(db: PGlite, claims: Claims, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const role = claims.role ?? "authenticated";
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ role, aal: "aal1", ...claims }),
    ]);
    await tx.exec(`set local role ${role}`);
    return fn(tx);
  });
}

/** Chama uma função RPC e devolve o primeiro valor da primeira linha. */
export async function rpc<T = unknown>(tx: Transaction, sql: string, params: unknown[] = []): Promise<T> {
  const res = await tx.query<Record<string, T>>(`select ${sql} as v`, params);
  return res.rows[0]?.v as T;
}

/** Código estável do erro (message do raise). */
export async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return "NO_ERROR";
}

let seq = 0;
export async function createMember(db: PGlite, role: "operator" | "admin" | "backoffice", active = true) {
  seq += 1;
  const id = crypto.randomUUID();
  const email = `${role}${seq}@exemplo.test`;
  await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  await db.query("select public.svc_register_member($1, $2::public.app_role, $3)", [id, role, `Pessoa Teste ${seq}`]);
  if (!active) await db.query("update public.profiles set active = false where id = $1", [id]);
  return id;
}

/** Formulário fictício só para testes — os campos reais do Consig ainda não foram mapeados. */
export const TEST_FIELDS = [
  { key: "documento", label: "Documento", type: "cpf", required: true },
  { key: "nome_teste", label: "Nome", type: "text", required: true, max_length: 80 },
  { key: "valor_teste", label: "Valor", type: "decimal", min: 1, max: 100000 },
  { key: "data_teste", label: "Data", type: "date" },
  { key: "opcao_teste", label: "Opção", type: "select", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
];

export async function activateTestForm(db: PGlite, version = 1) {
  await db.query(
    "insert into public.form_definitions (version, title, fields, active) values ($1, 'Teste', $2, true)",
    [version, JSON.stringify(TEST_FIELDS)],
  );
}

/** CPFs válidos gerados apenas para teste (não pertencem a ninguém conhecido). */
export const FAKE_CPF = ["52998224725", "11144477735"];
