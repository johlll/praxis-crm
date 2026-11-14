/**
 * @vitest-environment node
 *
 * Franquia gratuita do Inngest (plano Hobby: 50.000 EXECUÇÕES por mês). O Inngest cobra 3 execuções por run de um
 * passo (o run, o passo e a finalização), então a estimativa antiga (que contava runs) estava errada: a C1 a cada
 * 2 minutos consumia ~64.800 execuções por mês sozinha. Frequências finais:
 *
 *   C1 `c1-automations-scheduler`          a cada 2 min → a cada 10 min       (12.960 execuções/mês)
 *   A11 `a11-retention-scheduler`          a cada 10 min → minuto 23 de cada hora (2.160 execuções/mês)
 *   A11 `a11-reconciler-scheduler`         a cada 10 min (igual)             (12.960 execuções/mês)
 *   C3b `c3b-privacy-retention-scheduler`  06:17 UTC todo dia (igual)        (90 execuções/mês)
 *   A11 por evento                         (igual)
 *
 * Total periódico: 9.390 runs = 28.170 execuções por mês; margem de ~21.830 para os eventos.
 *
 * O que este arquivo protege (só o que mudou ou precisa continuar igual):
 *  - o payload real da sincronização (SDK real, sem rede): exatamente cinco funções, com os crons finais e nada
 *    mais alterado (concorrência, retries, passos, eventos);
 *  - o cálculo periódico feito a partir do payload real: 28.170, e a documentação diz o mesmo;
 *  - a C1 continua sendo pedida NA HORA por criar lead e mover etapa; botão manual e rota de contingência existem;
 *    tentativas e dead-letter do banco seguem como estavam (a migration é a mesma);
 *  - nenhuma função, evento, passo, limite ou código de erro novo.
 *
 * O comportamento de `scheduleAutomationRun` (melhor esforço, depois da resposta) e da rota de contingência está em
 * `c1-automacoes-gatilhos.test.ts`; o da retenção e do reconciliador, em `a11-agendador-*.test.ts`.
 *
 * Chaves fictícias.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SIGNING_KEY = `signkey-prod-${"d4".repeat(32)}`;
const URL_ROTA = "https://praxis-crm-exemplo.vercel.app/api/inngest";
const FN_C1 = "praxis-crm-c1-automations-scheduler";
const FN_A11 = "praxis-crm-a11-process-form-submission";
const FN_C3B = "praxis-crm-c3b-privacy-retention-scheduler";
const FN_RECONCILIADOR = "praxis-crm-a11-reconciler-scheduler";
const FN_RETENCAO = "praxis-crm-a11-retention-scheduler";
const RAIZ = process.cwd();

const fetchFalso = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("INNGEST_SIGNING_KEY", SIGNING_KEY);
  vi.stubEnv("INNGEST_DEV", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://projeto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_ficticia");
  fetchFalso.mockReset();
  fetchFalso.mockImplementation(async () => Response.json({ ok: true, modified: true }));
  vi.stubGlobal("fetch", fetchFalso);
});

afterEach(() => {
  vi.doUnmock("@/server/ingest/config");
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type SyncedFunction = { id: string; concurrency?: unknown; triggers: unknown[]; steps: Record<string, { retries?: unknown }> };

async function funcoesSincronizadas(): Promise<SyncedFunction[]> {
  vi.doMock("@/server/ingest/config", () => ({
    IngestConfigError: class extends Error {},
    getIngestConfig: () => ({
      NEXT_PUBLIC_SUPABASE_URL: "https://projeto-ficticio.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_ficticia",
    }),
  }));
  const route = await import("@/app/api/inngest/route");
  const response = await route.PUT(new NextRequest(URL_ROTA, { method: "PUT" }), undefined);
  expect(response.status).toBe(200);
  expect(fetchFalso).toHaveBeenCalledTimes(1);
  const [, init] = fetchFalso.mock.calls[0] as unknown as [unknown, { body: string }];
  return (JSON.parse(init.body) as { functions: SyncedFunction[] }).functions;
}

const lerArquivo = (caminho: string) => readFileSync(join(RAIZ, caminho), "utf8").replace(/\r/g, "");
const semComentarios = (texto: string) => texto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const deFuncao = (functions: SyncedFunction[], id: string) => {
  const fn = functions.find((f) => f.id === id);
  expect(fn, `função ${id} no payload`).toBeDefined();
  return fn as SyncedFunction;
};
const tentativas = (fn: SyncedFunction) => Object.values(fn.steps).map((step) => step.retries);

// Consumo faturável: um run de N passos custa N + 2 execuções (o run, os passos e a finalização) — 3 com um passo,
// conferido no painel de uso do Inngest (721 runs, 721 passos e 2.163 execuções no dia 12/11/2026).
const DIAS_NO_MES = 30;
const execucoesPorRun = (passos: number) => passos + 2;

/** Runs por mês de um cron (só as três formas usadas no app: a cada N minutos, minuto fixo de toda hora e hora fixa por dia). */
function runsPorMes(cron: string): number {
  const [minuto = "", hora = "", dia, mes, semana] = cron.split(" ");
  expect([dia, mes, semana]).toEqual(["*", "*", "*"]);
  const porHora = minuto.startsWith("*/") ? 60 / Number(minuto.slice(2)) : 1;
  const porDia = hora === "*" ? porHora * 24 : porHora;
  expect(Number.isInteger(porHora)).toBe(true);
  return porDia * DIAS_NO_MES;
}

// ---------------------------------------------------------------------------------------------------------
describe("1. o payload real da sincronização (SDK real, sem rede)", () => {
  it("serve EXATAMENTE cinco funções: A11 por evento, C1, C3b, reconciliador e retenção da A11", async () => {
    const functions = await funcoesSincronizadas();
    expect(functions).toHaveLength(5);
    expect(functions.map((fn) => fn.id).sort()).toEqual([FN_A11, FN_C1, FN_C3B, FN_RECONCILIADOR, FN_RETENCAO].sort());
  });

  it("C1: cron `*/10 * * * *` (era `*/2`), só relógio, concorrência 1, retries 0", async () => {
    const fn = deFuncao(await funcoesSincronizadas(), FN_C1);
    expect(fn.triggers).toEqual([{ cron: "*/10 * * * *" }]);
    expect(fn.concurrency).toEqual({ limit: 1 });
    expect(tentativas(fn)).toEqual([{ attempts: 0 }]);
  });

  it("retenção da A11: SÓ o cron muda — `23 * * * *` (de hora em hora, minuto 23); concorrência 1, retries 0, um passo", async () => {
    const fn = deFuncao(await funcoesSincronizadas(), FN_RETENCAO);
    expect(fn.triggers).toEqual([{ cron: "23 * * * *" }]);
    expect(fn.concurrency).toEqual({ limit: 1 });
    expect(tentativas(fn)).toEqual([{ attempts: 0 }]);
    expect(Object.keys(fn.steps)).toHaveLength(1);
  });

  it("reconciliador da A11 continua em 10 minutos, com concorrência 1 e retries 0", async () => {
    const fn = deFuncao(await funcoesSincronizadas(), FN_RECONCILIADOR);
    expect(fn.triggers).toEqual([{ cron: "*/10 * * * *" }]);
    expect(fn.concurrency).toEqual({ limit: 1 });
    expect(tentativas(fn)).toEqual([{ attempts: 0 }]);
  });

  it("C3b continua diária às 06:17 UTC, e a A11 por evento continua igual (evento, concorrência 5, 9 retries)", async () => {
    const functions = await funcoesSincronizadas();
    const c3b = deFuncao(functions, FN_C3B);
    expect(c3b.triggers).toEqual([{ cron: "17 6 * * *" }]);
    expect(c3b.concurrency).toEqual({ limit: 1 });
    expect(tentativas(c3b)).toEqual([{ attempts: 0 }]);
    const a11 = deFuncao(functions, FN_A11);
    expect(a11.triggers).toEqual([{ event: "praxis/form.submission.received" }]);
    expect(a11.concurrency).toEqual({ limit: 5 });
    expect(tentativas(a11)).toEqual([{ attempts: 9 }]);
  });

  it("nenhum evento, passo ou função nova: as quatro rotinas periódicas só têm gatilho de relógio e UM passo", async () => {
    const functions = await funcoesSincronizadas();
    for (const id of [FN_C1, FN_RECONCILIADOR, FN_RETENCAO, FN_C3B]) {
      const fn = deFuncao(functions, id);
      expect(fn.triggers).toHaveLength(1);
      expect(Object.keys(fn.triggers[0] as object)).toEqual(["cron"]);
      expect(Object.keys(fn.steps)).toHaveLength(1);
    }
    // O único evento do app inteiro é o da A11.
    const eventos = functions.flatMap((fn) => fn.triggers).filter((t) => "event" in (t as object));
    expect(eventos).toEqual([{ event: "praxis/form.submission.received" }]);
  });

  it("os passos, os limites e os códigos de erro seguem os mesmos nos arquivos", () => {
    const c1 = lerArquivo("src/app/api/inngest/automations-scheduler.ts");
    expect(c1).toContain('AUTOMATIONS_SCHEDULER_STEP_ID = "process-automations"');
    expect(c1).toContain("AUTOMATIONS_SCHEDULER_BATCH_LIMIT = 100");
    expect(c1).toContain('"automations_scheduler_not_configured" | "automations_scheduler_failed"');
    expect(c1).toContain("concurrency: { limit: 1 }");
    expect(c1).toContain("retries: 0 as const");

    const retencao = lerArquivo("src/app/api/inngest/a11-retention-scheduler.ts");
    expect(retencao).toContain('A11_RETENTION_SCHEDULER_STEP_ID = "run-a11-retention"');
    expect(retencao).toContain('"a11_retention_not_configured" | "a11_retention_failed"');
    expect(retencao).toContain("concurrency: { limit: 1 }");
    expect(retencao).toContain("retries: 0 as const");

    const reconciliador = lerArquivo("src/app/api/inngest/a11-reconciler-scheduler.ts");
    expect(reconciliador).toContain('A11_RECONCILER_SCHEDULER_STEP_ID = "reconcile-outbox"');
    expect(reconciliador).toContain("concurrency: { limit: 1 }");
    expect(reconciliador).toContain("retries: 0 as const");

    const operacaoRetencao = lerArquivo("src/server/ingest/retention-maintenance.ts");
    expect(operacaoRetencao).toContain("RETENTION_STUCK_LIMIT = 100");
    expect(operacaoRetencao).toContain("RETENTION_EXPIRING_LIMIT = 100");
    expect(operacaoRetencao).toContain("RETENTION_EXPIRING_DAYS_BEFORE = 7");
    expect(operacaoRetencao).toContain("RETENTION_PURGE_LIMIT = 200");

    const operacaoOutbox = lerArquivo("src/server/ingest/outbox-reconciler.ts");
    expect(operacaoOutbox).toContain("OUTBOX_RESOLVE_LIMIT = 200");
    expect(operacaoOutbox).toContain("OUTBOX_CLAIM_LIMIT = 20");
    expect(operacaoOutbox).toContain("OUTBOX_LOCK_SECONDS = 120");
    expect(operacaoOutbox).toContain("OUTBOX_PUBLISH_RETRY_SECONDS = 60");
  });

  it("a mudança nos arquivos é só o cron (e o nome de exibição da retenção, que dizia '10 minutos')", () => {
    const c1 = semComentarios(lerArquivo("src/app/api/inngest/automations-scheduler.ts"));
    expect(c1).toContain('triggers: [{ cron: "*/10 * * * *" }]');
    expect(c1).not.toContain("*/2 * * * *");
    const retencao = semComentarios(lerArquivo("src/app/api/inngest/a11-retention-scheduler.ts"));
    expect(retencao).toContain('triggers: [{ cron: "23 * * * *" }]');
    expect(retencao).toContain('name: "A11 — retenção e alertas dos eventos recebidos (a cada hora)"');
    expect(retencao).not.toContain("*/10 * * * *");
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("2. o consumo periódico, calculado a partir do payload real", () => {
  it("3 execuções por run de um passo; total periódico: 9.390 runs = 28.170 execuções por mês", async () => {
    const functions = await funcoesSincronizadas();
    const linha = (id: string) => {
      const fn = deFuncao(functions, id);
      const cron = (fn.triggers[0] as { cron: string }).cron;
      const runs = runsPorMes(cron);
      return { runs, execucoes: runs * execucoesPorRun(Object.keys(fn.steps).length) };
    };
    const tabela = {
      c1: linha(FN_C1),
      reconciliador: linha(FN_RECONCILIADOR),
      retencao: linha(FN_RETENCAO),
      c3b: linha(FN_C3B),
    };
    expect(tabela).toEqual({
      c1: { runs: 4320, execucoes: 12960 },
      reconciliador: { runs: 4320, execucoes: 12960 },
      retencao: { runs: 720, execucoes: 2160 },
      c3b: { runs: 30, execucoes: 90 },
    });
    const runs = Object.values(tabela).reduce((soma, l) => soma + l.runs, 0);
    const execucoes = Object.values(tabela).reduce((soma, l) => soma + l.execucoes, 0);
    expect(runs).toBe(9390);
    expect(execucoes).toBe(28170);
    expect(50000 - execucoes).toBe(21830);
  });

  it("a estimativa antiga (C1 a cada 2 minutos, 1 execução por run) estava errada: o real era ~64.800 por mês", () => {
    expect(runsPorMes("*/2 * * * *")).toBe(21600);
    expect(runsPorMes("*/2 * * * *") * execucoesPorRun(1)).toBe(64800);
    expect(runsPorMes("*/2 * * * *") * execucoesPorRun(1)).toBeGreaterThan(50000);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("3. a documentação diz o cálculo observado", () => {
  // Espaço em branco colapsado: a frase pode quebrar de linha na documentação sem mudar de sentido.
  const doc = (caminho: string) => lerArquivo(caminho).replace(/\s+/g, " ");
  const runbook = () => doc("docs/operacao/runbook-operacional.md");
  const checklist = () => doc("docs/operacao/checklist-de-lancamento.md");

  it("runbook: tabela com runs e execuções, total 28.170, margem ~21.830 e as regras de uso da franquia", () => {
    const texto = runbook();
    for (const trecho of [
      "3 execuções por run de um passo",
      "| `c1-automations-scheduler` | a cada 10 min | 4.320 | 12.960 |",
      "| `a11-reconciler-scheduler` | a cada 10 min | 4.320 | 12.960 |",
      "| `a11-retention-scheduler` | de hora em hora, minuto 23 | 720 | 2.160 |",
      "| `c3b-privacy-retention-scheduler` | diária, 06:17 UTC | 30 | 90 |",
      "| **Total periódico** | | **9.390** | **28.170** |",
      "cerca de **21.830** execuções por mês",
      "NÃO podem ser ativados sem um novo cálculo",
      "Atingir o limite PAUSA as funções no Hobby",
      "Nenhuma garantia de gratuidade depende de cobrança automática",
      "estavam **errados**, porque contavam **runs**, não execuções faturáveis",
    ]) {
      expect(texto, trecho).toContain(trecho);
    }
  });

  it("checklist: mesmo total, margem e restrições", () => {
    const texto = checklist();
    for (const trecho of ["**28.170 por mês**", "cerca de **21.830**", "Agenda e WhatsApp não podem ser ativados sem novo cálculo", "atingir o limite pausa as funções", "nenhuma cobrança foi autorizada"]) {
      expect(texto, trecho).toContain(trecho);
    }
  });

  it("o número antigo (30.271) só aparece como a estimativa ERRADA, nunca como o total atual", () => {
    for (const texto of [runbook(), checklist()]) {
      let posicao = texto.indexOf("30.271");
      expect(posicao).toBeGreaterThan(-1);
      while (posicao !== -1) {
        const janela = texto.slice(Math.max(0, posicao - 300), posicao + 300);
        expect(janela).toMatch(/errad/);
        posicao = texto.indexOf("30.271", posicao + 1);
      }
    }
  });

  it("a documentação já não descreve a C1 a cada 2 minutos nem a retenção a cada 10", () => {
    const todos = [runbook(), checklist(), doc("docs/decisoes/c1-automacoes-minimas.md")].join("\n");
    expect(todos).not.toContain("uma a cada 2 minutos");
    expect(todos).not.toContain("rodada seguinte (2 minutos)");
    expect(todos).toContain("`*/10 * * * *` (a cada 10 minutos; era `*/2`");
    expect(runbook()).toContain("`a11-retention-scheduler` ← `/api/cron/retention`, **uma vez por hora, no minuto 23**");
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("4. a C1 continua sendo pedida na hora, e a recuperação do banco não mudou", () => {
  it("criar lead e mover etapa pedem a rodada logo depois do sucesso (o relógio é só recuperação)", () => {
    const leads = lerArquivo("src/modules/leads/actions.ts");
    expect(leads).toContain('import { scheduleAutomationRun } from "@/modules/automations/run";');
    const criou = leads.indexOf('revalidatePath("/leads");');
    const pediu = leads.indexOf("scheduleAutomationRun(ctx.workspaceId);");
    const redirecionou = leads.indexOf("redirect(`/leads/${data}`);");
    expect(criou).toBeGreaterThan(-1);
    expect(pediu).toBeGreaterThan(criou);
    expect(redirecionou).toBeGreaterThan(pediu);

    const oportunidades = lerArquivo("src/modules/opportunities/actions.ts");
    expect(oportunidades).toContain('import { scheduleAutomationRun } from "@/modules/automations/run";');
    const moveu = oportunidades.indexOf('revalidatePath("/pipeline");');
    const pediuMover = oportunidades.indexOf("scheduleAutomationRun(guard.ctx.workspaceId);");
    const devolveu = oportunidades.indexOf("return { ok: true, opportunityId: parsed.data.opportunityId };", pediuMover);
    expect(moveu).toBeGreaterThan(-1);
    expect(pediuMover).toBeGreaterThan(moveu);
    expect(devolveu).toBeGreaterThan(pediuMover);
  });

  it("o pedido imediato roda depois da resposta (`after`) e chama só a RPC idempotente do workspace", () => {
    const run = semComentarios(lerArquivo("src/modules/automations/run.ts"));
    expect(run).toContain("after(async () => {");
    expect(run).toContain('supabase.rpc("process_automation_events", { p_workspace_id: workspaceId, p_limit: 20 })');
  });

  it("botão manual (\"Processar agora\") e rota de contingência da C1 preservados", () => {
    const botao = lerArquivo("src/components/automations/process-now-button.tsx");
    expect(botao).toContain("processAutomationsAction");
    expect(botao).toContain("Processar agora");
    const acoes = semComentarios(lerArquivo("src/modules/automations/actions.ts"));
    expect(acoes).toContain("export async function processAutomationsAction()");
    expect(acoes).toContain('supabase.rpc("process_automation_events", {');

    const rota = lerArquivo("src/app/api/cron/automations/route.ts");
    expect(rota).toContain('supabase.rpc("process_automation_events_system", { p_limit: 100 })');
    expect(rota).toContain("CRON_SECRET");
    expect(rota).toContain("export const GET = POST;");
  });

  it("retries e dead-letter do banco: 4 tentativas, esperas de 1, 5 e 30 minutos, depois dead_letter (migration da C1 intacta)", () => {
    const sql = lerArquivo("supabase/migrations/20261110120000_c1_automacoes_minimas.sql");
    expect(sql).toContain("c_max_attempts constant integer := 4;");
    expect(sql).toContain("when 1 then interval '1 minute'");
    expect(sql).toContain("when 2 then interval '5 minutes'");
    expect(sql).toContain("else interval '30 minutes'");
    expect(sql).toContain("then 'dead_letter' else 'pending' end");
    expect(sql).toContain("'pending', 'succeeded', 'cancelled', 'dead_letter'");
  });
});
