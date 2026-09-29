import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A11 — testes estáticos dos workflows de reconciliação e de retenção.
 *
 * Dois achados reais que estes testes impedem de voltar:
 *
 * 1. O fallback de `target_url` apontava para `https://praxis-crm.vercel.app`,
 *    domínio que não é alias deste projeto na Vercel (pertence a outra
 *    conta) — toda execução agendada falharia contra o domínio errado.
 *
 * 2. O workflow de reconciliação também chamava `/api/cron/retention`, num
 *    schedule de 10 minutos. A retenção apaga conteúdo pessoal de forma
 *    irreversível (`purge_expired_webhook_events` anula as colunas de
 *    payload quando `expires_at` vence) e sinaliza como "travado" qualquer
 *    evento não processado — inclusive o evento histórico `dead` guardado
 *    como evidência. Reconciliar fila e apagar dado são operações de risco
 *    e cadência diferentes: ficam em workflows separados, e a retenção não
 *    tem schedule até haver decisão explícita sobre os payloads antigos.
 */

const RECONCILE_PATH = join(process.cwd(), ".github/workflows/a11-reconcile.yml");
const RETENTION_PATH = join(process.cwd(), ".github/workflows/a11-retention.yml");

const reconcile = readFileSync(RECONCILE_PATH, "utf8");
const retention = readFileSync(RETENTION_PATH, "utf8");

describe("domínio padrão do target_url", () => {
  it("nunca reintroduz o domínio comprovadamente inexistente (praxis-crm.vercel.app)", () => {
    for (const content of [reconcile, retention]) {
      expect(content).not.toContain("https://praxis-crm.vercel.app");
    }
  });

  it("usa o alias real de produção como fallback nos dois workflows", () => {
    for (const content of [reconcile, retention]) {
      // Um no `default:` do input e um no job que usa o fallback.
      const occurrences = content.split("https://praxis-crm-eight.vercel.app").length - 1;
      expect(occurrences).toBeGreaterThanOrEqual(2);
    }
  });

  it("preserva a possibilidade de informar uma URL diferente manualmente", () => {
    for (const content of [reconcile, retention]) {
      expect(content).toContain("github.event.inputs.target_url ||");
    }
  });
});

describe("separação de escopo entre reconciliação e retenção", () => {
  it("o workflow de reconciliação chama apenas /api/cron/outbox", () => {
    expect(reconcile).toContain("/api/cron/outbox");
    expect(reconcile).not.toContain("/api/cron/retention");
  });

  it("o workflow de retenção chama apenas /api/cron/retention", () => {
    expect(retention).toContain("/api/cron/retention");
    expect(retention).not.toContain("/api/cron/outbox");
  });

  it("a reconciliação roda por schedule", () => {
    expect(reconcile).toMatch(/^\s{2}schedule:/m);
    expect(reconcile).toMatch(/cron:/);
  });

  it("a retenção NÃO tem schedule — só acionamento manual", () => {
    expect(retention).not.toMatch(/^\s{2}schedule:/m);
    expect(retention).not.toMatch(/cron:/);
    expect(retention).toMatch(/^\s{2}workflow_dispatch:/m);
  });
});
