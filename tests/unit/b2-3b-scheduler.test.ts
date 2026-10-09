/**
 * @vitest-environment node
 *
 * B2, etapa 3b — agendador principal, batimento, recuperação adicional e
 * alertas (docs/decisoes/b2-google-agenda.md §9.2, §9.3). Tudo DESLIGADO por
 * padrão. Manutenção real com provedor simulado; dados fictícios.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { Inngest } from "inngest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { calendarAlertsEnabled, calendarSchedulerEnabled } from "@/server/calendar/automation-flags";
import { CALENDAR_SCHEDULE_CRON, calendarInngestFunctions } from "@/server/calendar/inngest";
import { createAppointment } from "@/server/calendar/sync/appointments";
import { runCalendarMaintenance } from "@/server/calendar/sync/maintenance";
import { runScheduledMaintenance, type AlertMessage, type ScheduledDeps } from "@/server/calendar/sync/scheduled";

import { ACTIVITY_ID, CALENDAR_ID, activity, makeFixture } from "../support/calendar-fixture";
import { InboundMemoryStore } from "../support/calendar-inbound-store";
import { MemorySchedulerStore } from "../support/calendar-scheduler-store";

const MIN = 60_000;
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
    ...extra,
  };
}

beforeEach(() => {
  clock = { t: Date.parse("2026-11-01T12:00:00.000Z") };
  store = new MemorySchedulerStore(now);
  sent = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("desligado por padrão", () => {
  it("só o valor exato \"true\" liga o agendador e os alertas", () => {
    for (const value of [undefined, "", "1", "TRUE", "yes", "true "]) {
      vi.stubEnv("CALENDAR_SCHEDULER_ENABLED", value as string);
      vi.stubEnv("CALENDAR_ALERTS_ENABLED", value as string);
      expect(calendarSchedulerEnabled()).toBe(false);
      expect(calendarAlertsEnabled()).toBe(false);
    }
    vi.stubEnv("CALENDAR_SCHEDULER_ENABLED", "true");
    vi.stubEnv("CALENDAR_ALERTS_ENABLED", "true");
    expect(calendarSchedulerEnabled()).toBe(true);
    expect(calendarAlertsEnabled()).toBe(true);
  });

  it("sem a chave, nenhuma função agendada é oferecida ao Inngest", () => {
    const client = new Inngest({ id: "teste" });
    expect(calendarInngestFunctions(client)).toEqual([]);
    vi.stubEnv("CALENDAR_SCHEDULER_ENABLED", "false");
    expect(calendarInngestFunctions(client)).toEqual([]);
  });

  it("com a chave: uma função, a cada 15 min, sem novas tentativas em laço", () => {
    vi.stubEnv("CALENDAR_SCHEDULER_ENABLED", "true");
    const fns = calendarInngestFunctions(new Inngest({ id: "teste" }));
    expect(fns).toHaveLength(1);
    expect(CALENDAR_SCHEDULE_CRON).toBe("TZ=UTC */15 * * * *");
    expect(fns[0]!.opts).toMatchObject({
      id: "b2-calendar-maintenance",
      retries: 0,
      concurrency: { limit: 1 },
      triggers: [{ cron: CALENDAR_SCHEDULE_CRON }],
    });
  });

  it("o workflow da recuperação adicional só roda à mão: sem agendamento, sem endereço padrão, com segredo próprio", () => {
    const yml = readFileSync(join(process.cwd(), ".github/workflows/b2-calendar-recovery.yml"), "utf8");
    const active = yml
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(active).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(active).not.toMatch(/schedule:/);
    expect(active).not.toMatch(/push:|pull_request:|workflow_run:/);
    expect(active).not.toMatch(/default:/);
    expect(active).not.toMatch(/praxis-crm-eight|vercel\.app/);
    expect(active).toContain("secrets.B2_CALENDAR_CRON_SECRET");
    expect(active).toContain("source=github");
  });

  it("nenhum cron da Vercel foi registrado", () => {
    const path = join(process.cwd(), "vercel.json");
    if (!existsSync(path)) return;
    expect(JSON.parse(readFileSync(path, "utf8")).crons ?? []).toEqual([]);
  });
});

describe("batimento", () => {
  it("grava quem rodou e só contagens", async () => {
    const result = await runScheduledMaintenance(deps(), "inngest");
    expect(result).toEqual({ outcome: "ok", report: okReport, detector: null });
    expect(store.heartbeats.get("inngest")).toMatchObject({ lastOutcome: "ok", lastRunAt: now().toISOString(), report: okReport });
  });

  it("rodada que falha também grava o batimento (\"rodou e falhou\" ≠ \"não rodou\")", async () => {
    const result = await runScheduledMaintenance(deps({ maintenance: async () => Promise.reject(new Error("Título sigiloso")) }), "manual");
    expect(result.outcome).toBe("failed");
    expect(store.heartbeats.get("manual")).toMatchObject({ lastOutcome: "failed", report: {} });
    expect(JSON.stringify([...store.heartbeats.values()])).not.toContain("sigiloso");
  });

  it("integrado: a manutenção real (provedor simulado) roda e o batimento leva as contagens", async () => {
    const f = await makeFixture();
    f.store.setActivity(activity());
    const created = await createAppointment(f.deps, f.conn, activity());
    if (created.status !== "created") throw new Error("setup");
    f.provider.externalEdit(CALENDAR_ID, created.eventId, { summary: "Mudou no Google" });
    const inbound = new InboundMemoryStore(f.store, now);
    f.provider.now = () => clock.t;

    await runScheduledMaintenance(
      deps({
        maintenance: () =>
          runCalendarMaintenance({
            api: f.provider,
            store: inbound,
            environment: "preview",
            now,
            openConnection: async () => ({ accessToken: f.conn.accessToken }),
            webhookAddress: null,
          }),
      }),
      "inngest",
    );

    expect(store.heartbeats.get("inngest")!.report).toMatchObject({ targets: 1, synced: 1 });
    expect(f.store.activities.get(ACTIVITY_ID)!.title).toBe("Mudou no Google");
    expect(JSON.stringify(store.heartbeats.get("inngest"))).not.toContain("Mudou no Google");
  });
});

describe("Detector 1: a recuperação adicional confere o agendador principal", () => {
  it("só a recuperação adicional confere (o próprio Inngest e a chamada manual, não)", async () => {
    expect((await runScheduledMaintenance(deps(), "inngest")).detector).toBeNull();
    expect((await runScheduledMaintenance(deps(), "manual")).detector).toBeNull();
    expect(store.alerts).toEqual([]);
  });

  it("agendador principal desligado por configuração: nada a vigiar, nenhum alerta", async () => {
    expect((await runScheduledMaintenance(deps({ schedulerEnabled: false }), "github")).detector).toBe("scheduler_disabled");
    expect(store.alerts).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("principal em dia: saudável", async () => {
    await runScheduledMaintenance(deps(), "inngest");
    clock.t += 59 * MIN;
    expect((await runScheduledMaintenance(deps(), "github")).detector).toBe("healthy");
    expect(sent).toEqual([]);
  });

  it("atrasado com os alertas DESLIGADOS (padrão): apurado e respondido, mas nenhum e-mail e nenhuma reserva", async () => {
    await runScheduledMaintenance(deps(), "inngest");
    clock.t += 61 * MIN;
    expect((await runScheduledMaintenance(deps({ alertsEnabled: false }), "github")).detector).toBe("stale_alerts_disabled");
    expect(store.alerts).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("atrasado com os alertas ligados: um e-mail por destinatário, sem conteúdo de evento, e no máximo um alerta a cada 6 h", async () => {
    await runScheduledMaintenance(deps(), "inngest");
    clock.t += 61 * MIN;

    expect((await runScheduledMaintenance(deps(), "github")).detector).toBe("stale_alert_sent");
    expect(sent.map((m) => m.to)).toEqual(["dona@exemplo.test", "admin@exemplo.test"]);
    expect(new Set(sent.map((m) => m.idempotencyKey)).size).toBe(2);
    expect(sent[0]!.text).toContain("não roda desde 2026-11-01T12:00:00.000Z");
    expect(store.alerts).toEqual([expect.objectContaining({ status: "sent", error: null })]);

    clock.t += 5 * 3600_000;
    expect((await runScheduledMaintenance(deps(), "github")).detector).toBe("stale_cooldown");
    expect(sent).toHaveLength(2);

    clock.t += 2 * 3600_000;
    expect((await runScheduledMaintenance(deps(), "github")).detector).toBe("stale_alert_sent");
    expect(sent).toHaveLength(4);
  });

  it("nunca rodou, com o principal ligado: atrasado", async () => {
    expect((await runScheduledMaintenance(deps(), "github")).detector).toBe("stale_alert_sent");
    expect(sent[0]!.text).toContain("nenhuma execução registrada");
  });

  it("sem e-mail configurado, sem destinatários ou com falha no envio: registrado como falha (e não conta para o intervalo)", async () => {
    expect((await runScheduledMaintenance(deps({ sendAlert: null }), "github")).detector).toBe("stale_alert_failed");
    expect(store.alerts.at(-1)).toMatchObject({ status: "failed", error: "email_not_configured" });

    store.recipients = [];
    expect((await runScheduledMaintenance(deps(), "github")).detector).toBe("stale_alert_failed");
    expect(store.alerts.at(-1)).toMatchObject({ status: "failed", error: "no_recipients" });

    store.recipients = [{ email: "a@exemplo.test" }, { email: "b@exemplo.test" }];
    const flaky = deps({
      sendAlert: async (m) => {
        if (m.to === "a@exemplo.test") throw new Error("resend_http_500");
        sent.push(m);
      },
    });
    expect((await runScheduledMaintenance(flaky, "github")).detector).toBe("stale_alert_sent");
    expect(store.alerts.at(-1)).toMatchObject({ status: "sent", error: "partial_1" });
  });
});
