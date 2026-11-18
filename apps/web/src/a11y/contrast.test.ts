import { describe, expect, it } from "vitest";

// Tokens reais compartilhados por portal e desktop.
const css = Object.values(import.meta.glob<string>("../../../../packages/brand/tokens.css", { query: "?raw", import: "default", eager: true }))[0];

function block(selector: string): Record<string, string> {
  const re = new RegExp(`${selector.replace(/[[\]"]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const body = css.match(re)?.[1] ?? "";
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function theme(name: "light" | "dark") {
  const vars = { ...block(":root"), ...block(`[data-theme="${name}"]`) };
  const resolve = (v: string, depth = 0): string => {
    const m = v.match(/^var\((--[\w-]+)\)$/);
    if (!m || depth > 5) return v;
    return resolve(vars[m[1]] ?? "", depth + 1);
  };
  return (token: string) => resolve(vars[token] ?? "");
}

function luminance(hex: string) {
  const [r, g, b] = hex.replace("#", "").match(/../g)!.map((x) => parseInt(x, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const BACKGROUNDS = ["--bg", "--bg-raised", "--bg-sunken", "--bg-hover"];
const TEXT = ["--text", "--text-muted", "--text-faint", "--state-success", "--state-danger", "--state-attention"];

describe.each(["light", "dark"] as const)("contraste WCAG 2.1 AA — tema %s", (name) => {
  const t = theme(name);

  it("todos os tokens usados nos pares são cores hex", () => {
    for (const tok of [...BACKGROUNDS, ...TEXT, "--line-strong", "--focus", "--accent", "--accent-text"]) {
      expect(t(tok), tok).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it.each(TEXT)("texto %s ≥ 4.5:1 sobre todos os fundos (1.4.3)", (fg) => {
    for (const bg of BACKGROUNDS) expect(contrast(t(fg), t(bg)), `${fg} sobre ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it("botão primário ≥ 4.5:1", () => {
    expect(contrast(t("--accent-text"), t("--accent"))).toBeGreaterThanOrEqual(4.5);
  });

  it("bordas de controles e indicador de foco ≥ 3:1 (1.4.11)", () => {
    for (const bg of ["--bg", "--bg-raised"]) {
      expect(contrast(t("--line-strong"), t(bg)), `--line-strong sobre ${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast(t("--focus"), t(bg)), `--focus sobre ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});
