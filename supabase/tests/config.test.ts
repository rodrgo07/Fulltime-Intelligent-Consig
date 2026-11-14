import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regressões do supabase/config.toml que afetam o projeto real no `supabase config push`.
const supabaseDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(supabaseDir, "..");
const toml = readFileSync(resolve(supabaseDir, "config.toml"), "utf8");

/** Linhas chave = valor de uma seção exata do TOML (sem parser: o arquivo é simples). */
function section(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inside = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      inside = header[1] === name;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (inside && kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

describe("config.toml do Supabase", () => {
  it("bloqueia cadastro aberto sem desligar o login por e-mail", () => {
    expect(section("auth").enable_signup).toBe("false");
    // No CLI v3, auth.email.enable_signup vira auth.email.enabled: false desligaria o login de todos.
    expect(section("auth.email")).not.toHaveProperty("enable_signup");
    expect(section("auth.email").enabled).toBe("true");
  });

  it("mantém MFA TOTP ligado e senha mínima de 12", () => {
    expect(section("auth.mfa.totp")).toMatchObject({ enroll_enabled: "true", verify_enabled: "true" });
    expect(Number(section("auth").minimum_password_length)).toBeGreaterThanOrEqual(12);
  });

  it.each(["invite", "recovery"])("template %s em PT-BR existe e usa o link do Supabase", (kind) => {
    const t = section(`auth.email.template.${kind}`);
    expect(t.subject).toMatch(/Fulltime Intelligent Consig/);
    const path = resolve(repoRoot, JSON.parse(t.content_path));
    expect(existsSync(path)).toBe(true);
    const html = readFileSync(path, "utf8");
    expect(html).toContain('lang="pt-BR"');
    expect(html).toContain("{{ .ConfirmationURL }}");
  });
});
