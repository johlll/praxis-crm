import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A11 — teste estático do workflow de reconciliação.
 *
 * Achado real: o fallback de `target_url` apontava para
 * `https://praxis-crm.vercel.app`, um domínio que não é alias deste
 * projeto na Vercel (pertence a outra conta) — toda execução agendada
 * (schedule, sem override manual) falharia contra o domínio errado assim
 * que este workflow entrasse em `main`. Este teste impede que o domínio
 * inexistente volte, sem travar o valor exato para sempre: qualquer
 * alias real e estável serve, o que ele proíbe é especificamente o
 * domínio comprovadamente errado.
 */

const WORKFLOW_PATH = join(process.cwd(), ".github/workflows/a11-reconcile.yml");

describe("a11-reconcile.yml — domínio padrão do target_url", () => {
  const content = readFileSync(WORKFLOW_PATH, "utf8");

  it("nunca reintroduz o domínio comprovadamente inexistente (praxis-crm.vercel.app)", () => {
    expect(content).not.toContain("https://praxis-crm.vercel.app");
  });

  it("usa o alias real de produção como fallback (workflow_dispatch e schedule)", () => {
    const occurrences = content.split("https://praxis-crm-eight.vercel.app").length - 1;
    // Um no `default:` do input, um em cada um dos dois jobs que usam o fallback.
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  it("preserva a possibilidade de informar uma URL diferente manualmente", () => {
    expect(content).toContain("github.event.inputs.target_url ||");
  });
});
