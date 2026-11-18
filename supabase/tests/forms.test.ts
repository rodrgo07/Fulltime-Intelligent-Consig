// Formulário real (supabase/forms/consig-inss-v1.sql): aceito pelo guard e com os campos que o robô lê.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { activateTestForm, as, createMember, FAKE_CPF, freshDb, rpc } from "./harness/db";

const SQL = readFileSync(join(import.meta.dirname, "..", "forms", "consig-inss-v1.sql"), "utf8");
const ROBOT = readFileSync(join(import.meta.dirname, "..", "..", "services", "robot", "src", "fic_robot", "consig.py"), "utf8");

let db: PGlite;
let op: string;

beforeEach(async () => {
  db = await freshDb();
  op = await createMember(db, "operator");
}, 30_000);

const submit = (version: number, payload: Record<string, unknown>) =>
  as(db, { sub: op }, (tx) => rpc<Record<string, unknown>>(tx, "public.submit_proposal_request($1, $2, $3::jsonb)",
    [crypto.randomUUID(), version, JSON.stringify(payload)]));

describe("formulário da digitação no ConsigMais", () => {
  it("vira a única versão ativa, mesmo com um formulário anterior", async () => {
    await activateTestForm(db);
    await db.exec(SQL);
    const rows = (await db.query<{ version: number; active: boolean }>(
      "select version, active from public.form_definitions order by version")).rows;
    expect(rows).toEqual([{ version: 1, active: false }, { version: 2, active: true }]);
  });

  it("aceita CPF + entidade INSS e o robô recebe exatamente esses campos", async () => {
    await db.exec(SQL);
    const r = await submit(1, { cpf: FAKE_CPF[0], entidade: "1581" });
    expect(r.request_id).toBeTruthy();
    const { payload } = (await db.query<{ payload: Record<string, string> }>("select payload from public.clients_temp")).rows[0];
    expect(Object.keys(payload).sort()).toEqual(["cpf", "entidade"]);
    for (const key of Object.keys(payload)) expect(ROBOT).toContain(`"${key}"`);
  });

  it("recusa entidade fora da lista", async () => {
    await db.exec(SQL);
    await expect(submit(1, { cpf: FAKE_CPF[0], entidade: "9999" })).rejects.toThrow();
  });
});
