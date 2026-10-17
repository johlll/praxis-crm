/**
 * @vitest-environment node
 *
 * B2 — preparação da validação de recuperação e alertas (§9.2, §9.3):
 *  A. destinatário de teste do alerta, só em Preview;
 *  B. recuperação adicional só para destinos aprovados, com bypass próprio;
 *  C. saúde: a recuperação aparece à parte e não apaga o atraso do principal.
 * Nada aqui chama a rede, o Resend ou o banco: portas em memória.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { syncHealthNotices, type CalendarSyncHealth } from "@/modules/calendar/health";
import { calendarAlertTestRecipient } from "@/server/calendar/automation-flags";
import { ON_DEMAND_MIN_INTERVAL_MS } from "@/server/calendar/sync/on-demand";
import { runScheduledMaintenance, type AlertMessage, type ScheduledDeps } from "@/server/calendar/sync/scheduled";

import { APPROVED_TARGETS, approvedTarget, runRecovery } from "../../scripts/b2-calendar-recovery";
import { MemorySchedulerStore } from "../support/calendar-scheduler-store";

const MIN = 60_000;
const APPROVED = "https://praxis-crm-git-validacao-b2-johllls-projects.vercel.app";

afterEach(() => vi.unstubAllEnvs());

// ---------------------------------------------------------------------------
// A. Destinatário de teste
// ---------------------------------------------------------------------------

describe("A. CALENDAR_ALERTS_TEST_RECIPIENT: só em Preview", () => {
  it("Preview com um endereço válido: modo de teste", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("CALENDAR_ALERTS_TEST_RECIPIENT", " qa@exemplo.test ");
    expect(calendarAlertTestRecipient()).toEqual({ mode: "test", email: "qa@exemplo.test" });
  });

  it("Production (ou fora da Vercel): a variável é ignorada", () => {
    vi.stubEnv("CALENDAR_ALERTS_TEST_RECIPIENT", "qa@exemplo.test");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(calendarAlertTestRecipient()).toEqual({ mode: "off" });
    vi.stubEnv("VERCEL_ENV", "development");
    expect(calendarAlertTestRecipient()).toEqual({ mode: "off" });
    vi.stubEnv("VERCEL_ENV", "");
    expect(calendarAlertTestRecipient()).toEqual({ mode: "off" });
  });

  it("Preview sem a variável: destinatários reais (comportamento de hoje)", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("CALENDAR_ALERTS_TEST_RECIPIENT", "");
    expect(calendarAlertTestRecipient()).toEqual({ mode: "off" });
  });

  it.each([
    ["dois endereços", "a@exemplo.test, b@exemplo.test"],
    ["separados por ponto e vírgula", "a@exemplo.test;b@exemplo.test"],
    ["com nome", "QA <qa@exemplo.test>"],
    ["sem domínio", "qa@exemplo"],
    ["sem arroba", "qa.exemplo.test"],
    ["com espaço no meio", "q a@exemplo.test"],
    ["só espaços", "   "],
    ["quebra de linha", "qa@exemplo.test\nBcc: x@exemplo.test"],
  ])("Preview com configuração inválida (%s): inválida", (_label, value) => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("CALENDAR_ALERTS_TEST_RECIPIENT", value);
    expect(calendarAlertTestRecipient()).toEqual({ mode: "invalid" });
  });
});

describe("A. alerta com destinatário de teste (Detector 1)", () => {
  let clock: { t: number };
  let store: MemorySchedulerStore;
  let sent: AlertMessage[];
  const now = () => new Date(clock.t);
  const okReport = { targets: 1, synced: 1, full: 0, busy: 0, accessLost: 0, failed: 0, needsReauth: 0, conflicts: 0, channelsCreated: 0, channelsRenewed: 0, channelsStopped: 0, pollingOnly: 0 };

  function deps(extra: Partial<ScheduledDeps> = {}): ScheduledDeps {
    return {
      maintenance: async () => okReport,
      store,
      now,
      schedulerEnabled: true,
      alertsEnabled: true,
      sendAlert: async (m) => {
        sent.push(m);
      },
      testRecipient: calendarAlertTestRecipient(),
      ...extra,
    };
  }

  beforeEach(() => {
    clock = { t: Date.parse("2026-11-01T12:00:00.000Z") };
    store = new MemorySchedulerStore(now);
    // A consulta real devolveria vários owner/admin.
    store.recipients = [{ email: "dona@exemplo.test" }, { email: "admin@exemplo.test" }, { email: "outro-admin@exemplo.test" }];
    sent = [];
  });

  async function staleRound(d: ScheduledDeps) {
    return (await runScheduledMaintenance(d, "github")).detector;
  }

  it("Preview em teste: um único destinatário e um único envio, mesmo com vários administradores", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("CALENDAR_ALERTS_TEST_RECIPIENT", "qa@exemplo.test");
    expect(await staleRound(deps())).toBe("stale_alert_sent");
    expect(sent.map((m) => m.to)).toEqual(["qa@exemplo.test"]);
    expect(sent[0]!.idempotencyKey).toBe("alerta-1:qa@exemplo.test");
    // O registro diz que foi só ao endereço de teste (a reserva conta os reais).
    expect(store.alerts).toEqual([expect.objectContaining({ status: "sent", error: "test_recipient", recipients: 3 })]);
  });

  it("Preview em teste: o intervalo de 6 h entre alertas continua valendo", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("CALENDAR_ALERTS_TEST_RECIPIENT", "qa@exemplo.test");
    expect(await staleRound(deps())).toBe("stale_alert_sent");
    clock.t += 5 * 60 * MIN;
    expect(await staleRound(deps())).toBe("stale_cooldown");
    expect(sent).toHaveLength(1);
    clock.t += 2 * 60 * MIN;
    expect(await staleRound(deps())).toBe("stale_alert_sent");
    expect(sent.map((m) => m.to)).toEqual(["qa@exemplo.test", "qa@exemplo.test"]);
    expect(new Set(sent.map((m) => m.idempotencyKey)).size).toBe(2);
  });

  it("Production com a variável definida: ignorada, os destinatários reais recebem", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("CALENDAR_ALERTS_TEST_RECIPIENT", "qa@exemplo.test");
    expect(await staleRound(deps())).toBe("stale_alert_sent");
    expect(sent.map((m) => m.to)).toEqual(["dona@exemplo.test", "admin@exemplo.test", "outro-admin@exemplo.test"]);
    expect(store.alerts.at(-1)).toMatchObject({ status: "sent", error: null });
  });

  it("Preview com configuração inválida: falha SEM enviar a ninguém, e a falha não conta para o intervalo", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("CALENDAR_ALERTS_TEST_RECIPIENT", "a@exemplo.test, b@exemplo.test");
    expect(await staleRound(deps())).toBe("stale_alert_failed");
    expect(sent).toEqual([]);
    expect(store.alerts).toEqual([expect.objectContaining({ status: "failed", error: "test_recipient_invalid" })]);

    // Corrigida a configuração, o próximo alerta sai (a falha não reservou o intervalo).
    vi.stubEnv("CALENDAR_ALERTS_TEST_RECIPIENT", "qa@exemplo.test");
    expect(await staleRound(deps())).toBe("stale_alert_sent");
    expect(sent.map((m) => m.to)).toEqual(["qa@exemplo.test"]);
  });

  it("alertas desligados: nem o modo de teste envia", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("CALENDAR_ALERTS_TEST_RECIPIENT", "qa@exemplo.test");
    expect(await staleRound(deps({ alertsEnabled: false }))).toBe("stale_alerts_disabled");
    expect(sent).toEqual([]);
    expect(store.alerts).toEqual([]);
  });

  it("envio ao endereço de teste falhou: registrado como falha", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("CALENDAR_ALERTS_TEST_RECIPIENT", "qa@exemplo.test");
    const failing = deps({
      sendAlert: async () => {
        throw new Error("resend_http_500");
      },
    });
    expect(await staleRound(failing)).toBe("stale_alert_failed");
    expect(store.alerts.at(-1)).toMatchObject({ status: "failed", error: "send_failed" });
  });

  it("o texto do e-mail não promete atualização imediata ao abrir a agenda", async () => {
    expect(await staleRound(deps())).toBe("stale_alert_sent");
    expect(sent[0]!.text).not.toMatch(/força/);
    expect(sent[0]!.text).toContain("pode disparar a atualização da sua agenda conectada, no máximo uma vez a cada 5 minutos");
  });
});

// ---------------------------------------------------------------------------
// B. Recuperação adicional isolada
// ---------------------------------------------------------------------------

describe("B. destino da recuperação adicional: só os aprovados, por comparação exata", () => {
  it("lista aprovada desta validação: só o Preview da validacao-b2", () => {
    expect(APPROVED_TARGETS).toEqual([APPROVED]);
    expect(approvedTarget(APPROVED)).toBe(APPROVED);
  });

  it.each([
    ["ausente", undefined],
    ["vazio", ""],
    ["barra no fim", `${APPROVED}/`],
    ["http", APPROVED.replace("https://", "http://")],
    ["maiúsculas", APPROVED.toUpperCase()],
    ["espaço antes", ` ${APPROVED}`],
    ["espaço depois", `${APPROVED} `],
    ["credenciais embutidas", APPROVED.replace("https://", "https://user:senha@")],
    ["caminho", `${APPROVED}/api/cron/calendar`],
    ["parâmetro", `${APPROVED}?x-vercel-protection-bypass=abc`],
    ["fragmento", `${APPROVED}#x`],
    ["porta explícita", `${APPROVED}:443`],
    ["domínio semelhante (sufixo)", `${APPROVED}.evil.example`],
    ["domínio semelhante (letra trocada)", APPROVED.replace("validacao", "validacao0")],
    ["outro Preview do mesmo projeto", "https://praxis-crm-git-main-johllls-projects.vercel.app"],
    ["Production", "https://praxis-crm-eight.vercel.app"],
    ["destino com o aprovado como usuário", `https://${APPROVED.slice(8)}@evil.example`],
    ["destino com o aprovado no caminho", `https://evil.example/${APPROVED}`],
  ])("recusado: %s", (_label, raw) => {
    expect(approvedTarget(raw)).toBeNull();
  });
});

describe("B. chamada da recuperação adicional", () => {
  const secrets = { CRON_SECRET: "c".repeat(32), BYPASS_SECRET: "b".repeat(32) };

  function spyFetch(status = 200, body = '{"enabled":true,"outcome":"ok"}') {
    return vi.fn(async (_url: string, _init: { method: string; redirect: "manual"; headers: Record<string, string> }) => ({
      status,
      text: async () => body,
    }));
  }

  it.each([
    ["destino fora da lista", { TARGET_URL: "https://evil.example", ...secrets }, "target_not_approved"],
    ["domínio semelhante", { TARGET_URL: `${APPROVED}.evil.example`, ...secrets }, "target_not_approved"],
    ["credenciais embutidas", { TARGET_URL: APPROVED.replace("https://", "https://u:p@"), ...secrets }, "target_not_approved"],
    ["sem segredo do cron", { TARGET_URL: APPROVED, BYPASS_SECRET: secrets.BYPASS_SECRET }, "missing_cron_secret"],
    ["sem bypass próprio", { TARGET_URL: APPROVED, CRON_SECRET: secrets.CRON_SECRET }, "missing_bypass_secret"],
  ] as const)("%s: nenhuma requisição", async (_label, env, reason) => {
    const fetchImpl = spyFetch();
    expect(await runRecovery(env, fetchImpl)).toEqual({ ok: false, reason });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("destino aprovado: uma requisição, bypass e segredo só em cabeçalho, sem seguir redirecionamento", async () => {
    const fetchImpl = spyFetch();
    expect(await runRecovery({ TARGET_URL: APPROVED, ...secrets }, fetchImpl)).toMatchObject({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${APPROVED}/api/cron/calendar?source=github`);
    expect(url).not.toContain(secrets.BYPASS_SECRET);
    expect(url).not.toContain(secrets.CRON_SECRET);
    expect(init).toEqual({
      method: "POST",
      redirect: "manual",
      headers: { Authorization: `Bearer ${secrets.CRON_SECRET}`, "x-vercel-protection-bypass": secrets.BYPASS_SECRET },
    });
  });

  it.each([301, 302, 307, 308, 0])("resposta de redirecionamento (%i): recusada, sem segunda requisição", async (status) => {
    const fetchImpl = spyFetch(status, "");
    expect(await runRecovery({ TARGET_URL: APPROVED, ...secrets }, fetchImpl)).toMatchObject({ ok: false, reason: "redirect_refused" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rodada que falhou (503): falha com o corpo de contagens", async () => {
    const fetchImpl = spyFetch(503, '{"enabled":true,"outcome":"failed"}');
    expect(await runRecovery({ TARGET_URL: APPROVED, ...secrets }, fetchImpl)).toEqual({
      ok: false,
      reason: "http_error",
      status: 503,
      body: '{"enabled":true,"outcome":"failed"}',
    });
  });

  it("executado direto pelo Node (como no workflow): destino recusado sai com erro, sem imprimir segredos", () => {
    const run = spawnSync(process.execPath, [join(process.cwd(), "scripts/b2-calendar-recovery.ts")], {
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", TARGET_URL: "https://evil.example", ...secrets },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("recuperação não executada: target_not_approved");
    expect(run.stderr).not.toContain(secrets.CRON_SECRET);
    expect(run.stderr).not.toContain(secrets.BYPASS_SECRET);
  });
});

describe("B. workflows", () => {
  const active = (path: string) =>
    readFileSync(join(process.cwd(), path), "utf8")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

  it("B2: só à mão, bypass próprio por variável de ambiente, destino nunca interpolado no comando", () => {
    const yml = active(".github/workflows/b2-calendar-recovery.yml");
    expect(yml).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(yml).not.toMatch(/schedule:|cron:/);
    expect(yml).toContain("secrets.B2_CALENDAR_BYPASS_SECRET");
    expect(yml).toContain("secrets.B2_CALENDAR_CRON_SECRET");
    expect(yml).not.toContain("VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(yml).not.toContain("x-vercel-protection-bypass=");
    expect(yml).not.toMatch(/\bcurl\b/);
    expect(yml).toContain("run: node scripts/b2-calendar-recovery.ts");
    // O destino entra só pelo ambiente do passo, nunca dentro do `run`.
    const runLines = yml.split("\n").filter((line) => line.includes("run:"));
    expect(runLines.join("\n")).not.toContain("${{");
  });

  it("A11 intocada: continua com o seu próprio bypass", () => {
    expect(active(".github/workflows/a11-reconcile.yml")).toContain("secrets.VERCEL_AUTOMATION_BYPASS_SECRET");
  });
});

// ---------------------------------------------------------------------------
// C. Saúde do agendador (Detector 2)
// ---------------------------------------------------------------------------

describe("C. saúde: a recuperação aparece à parte e não apaga o atraso do principal", () => {
  const now = new Date("2026-11-01T12:00:00.000Z");
  const at = (minutes: number) => new Date(now.getTime() - minutes * MIN).toISOString();
  type Beat = CalendarSyncHealth["schedulers"][number];
  const beat = (scheduler: Beat["scheduler"], minutes: number, lastOutcome: Beat["lastOutcome"] = "ok", successMinutes: number | null = minutes): Beat => ({
    scheduler,
    lastRunAt: at(minutes),
    lastOutcome,
    lastSuccessAt: successMinutes === null ? null : at(successMinutes),
  });
  const notices = (schedulers: Beat[]) => syncHealthNotices({ schedulers, activeLinks: 1, channelsLowLife: 0 }, { now, schedulerEnabled: true });

  it("reprodução: Inngest atrasado e GitHub com sucesso recente — o aviso do principal continua", () => {
    const result = notices([beat("inngest", 410), beat("github", 4)]);
    expect(result).toEqual([
      {
        level: "warning",
        message: "Sincronização automática atrasada: a última execução do agendador principal foi há 6 horas. Alterações feitas no Google podem demorar a aparecer.",
      },
      {
        level: "info",
        message:
          "Recuperação adicional: última execução há 4 minutos, sem falhas. Ela roda por outro caminho e não comprova que o agendador principal esteja funcionando.",
      },
    ]);
  });

  it("principal sem nenhuma execução e GitHub recente: continua atrasado", () => {
    const [primary, recovery] = notices([beat("github", 10)]);
    expect(primary).toMatchObject({ level: "warning", message: expect.stringMatching(/agendador principal não tem nenhuma execução registrada/) });
    expect(recovery).toMatchObject({ level: "info", message: expect.stringMatching(/^Recuperação adicional: última execução há 10 minutos, sem falhas\./) });
  });

  it("nenhum texto afirma que o principal voltou ou está em dia por causa da recuperação", () => {
    for (const result of [notices([beat("inngest", 75), beat("github", 1)]), notices([beat("github", 1)])]) {
      const text = result.map((n) => n.message).join(" ");
      expect(text).not.toMatch(/voltou a funcionar|em dia|normalizad/);
      expect(result[0]!.level).toBe("warning");
    }
  });

  it("falha e falha parcial do principal continuam distintas, com a recuperação ao lado", () => {
    const failed = notices([beat("inngest", 10, "failed", 200), beat("github", 2)]);
    expect(failed[0]).toMatchObject({ level: "warning", message: expect.stringMatching(/última execução falhou\. A última execução sem falhas foi há 3 horas\./) });
    expect(failed[1]).toMatchObject({ level: "info" });

    const partial = notices([beat("inngest", 10, "partial"), beat("github", 2)]);
    expect(partial[0]).toMatchObject({ level: "warning", message: expect.stringMatching(/não conseguiu atualizar parte das agendas/) });

    const late = notices([beat("inngest", 61, "failed", null), beat("github", 2)]);
    expect(late[0]).toMatchObject({ message: expect.stringMatching(/^Sincronização automática atrasada: a última execução do agendador principal foi há 61 minutos/) });
  });

  it("resultado da recuperação aparece como foi: sem falhas, parcial ou com falha", () => {
    expect(notices([beat("inngest", 5), beat("github", 3, "partial")])[0]!.message).toMatch(/há 3 minutos, com falha em parte das agendas\./);
    expect(notices([beat("inngest", 5), beat("github", 3, "failed", null)])[0]!.message).toMatch(/há 3 minutos, com falha\./);
    // Principal em dia: nenhum aviso dele, só a informação da recuperação.
    expect(notices([beat("inngest", 5), beat("github", 3)])).toEqual([expect.objectContaining({ level: "info" })]);
  });

  it("chamada manual não comprova saúde automática nem aparece como recuperação", () => {
    const result = notices([beat("inngest", 90), beat("manual", 1)]);
    expect(result).toEqual([expect.objectContaining({ level: "warning", message: expect.stringMatching(/há 90 minutos/) })]);
    expect(notices([beat("manual", 1)])).toEqual([expect.objectContaining({ level: "warning", message: expect.stringMatching(/nenhuma execução registrada/) })]);
  });

  it("agendador desligado: diz que abrir a página Agenda pode disparar a sincronização, respeitando o intervalo", () => {
    const [notice] = syncHealthNotices({ schedulers: [beat("github", 3)], activeLinks: 1, channelsLowLife: 0 }, { now, schedulerEnabled: false });
    expect(notice!.message).not.toContain("quando você abre esta tela");
    expect(notice!.message).toContain("Abrir a página Agenda pode disparar a atualização da sua agenda conectada, no máximo uma vez a cada 5 minutos");
    // O intervalo do texto é o da regra (não muda a regra; só a descreve).
    expect(ON_DEMAND_MIN_INTERVAL_MS).toBe(5 * MIN);
  });
});
