/**
 * B2 — cadência do polling sob o agendador principal (cron a cada 15 min,
 * sem webhook). A rodada grava `last_run_at` no FIM da sincronização, que
 * acontece alguns segundos DEPOIS do horário nominal do cron. Se a regra
 * fosse "venceu quando `agora - última >= 15 min`", a rodada nominal
 * seguinte (exatamente 15 min depois do nominal anterior) acharia só
 * 14 min 57 s e pularia a agenda — a mudança no Google ficaria para a
 * outra, ~30 min depois. Código real da manutenção; provedor e banco
 * simulados, relógio controlado.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createAppointment } from "@/server/calendar/sync/appointments";
import { pollDue, runCalendarMaintenance } from "@/server/calendar/sync/maintenance";

import { ACTIVITY_ID, CALENDAR_ID, activity, makeFixture } from "../support/calendar-fixture";
import { InboundMemoryStore } from "../support/calendar-inbound-store";

const MIN = 60_000;
let clock: { t: number };
const now = () => new Date(clock.t);
const at = (iso: string) => {
  clock.t = Date.parse(iso);
};

async function setup() {
  const f = await makeFixture();
  f.provider.now = () => clock.t;
  f.store.setActivity(activity());
  const created = await createAppointment(f.deps, f.conn, activity());
  if (created.status !== "created") throw new Error("setup");
  const inbound = new InboundMemoryStore(f.store, now);
  const run = () =>
    runCalendarMaintenance({
      api: f.provider,
      store: inbound,
      environment: "preview",
      now,
      openConnection: async () => ({ accessToken: f.conn.accessToken }),
      webhookAddress: null,
    });
  return { f, created, run };
}

beforeEach(() => {
  clock = { t: Date.parse("2026-11-02T12:00:00.000Z") };
});

describe("cadência do agendador principal sem webhook", () => {
  it("rodada nominal seguinte sincroniza mesmo que a anterior tenha terminado segundos depois do horário", async () => {
    const { f, created, run } = await setup();

    // Rodada das 12:00, que só grava `last_run_at` às 12:00:03 (início
    // atrasado + duração). Sincronização completa: grava o token.
    at("2026-11-02T12:00:03.000Z");
    expect(await run()).toMatchObject({ targets: 1, synced: 1 });

    // Mudança no Google entre as rodadas.
    at("2026-11-02T12:07:00.000Z");
    f.provider.externalEdit(CALENDAR_ID, created.eventId, { summary: "Mudou no Google" });

    // Rodada nominal das 12:15, no horário: precisa sincronizar já.
    at("2026-11-02T12:15:00.000Z");
    const second = await run();
    expect(second).toMatchObject({ targets: 1, synced: 1 });
    expect(f.store.activities.get(ACTIVITY_ID)!.title).toBe("Mudou no Google");
  });

  it("chamadas repetidas DENTRO do mesmo período continuam sem sincronizar de novo", async () => {
    const { run } = await setup();
    at("2026-11-02T12:00:03.000Z");
    expect(await run()).toMatchObject({ synced: 1 });
    // Chamada manual 4 min depois, no mesmo período de 15 min: nada a fazer.
    at("2026-11-02T12:04:00.000Z");
    expect(await run()).toMatchObject({ targets: 1, synced: 0 });
    at("2026-11-02T12:14:59.000Z");
    expect(await run()).toMatchObject({ synced: 0 });
  });
});

describe("pollDue: um polling por período de 15 min alinhado em UTC (o mesmo do cron)", () => {
  const t = (iso: string) => Date.parse(iso);
  it.each([
    ["nominal seguinte, anterior atrasada 3 s", "2026-11-02T12:00:03Z", "2026-11-02T12:15:00Z", true],
    ["nominal seguinte, anterior atrasada 10 min", "2026-11-02T12:10:00Z", "2026-11-02T12:15:00Z", true],
    ["mesmo período", "2026-11-02T12:00:03Z", "2026-11-02T12:14:59Z", false],
    ["períodos depois", "2026-11-02T12:00:03Z", "2026-11-02T13:02:00Z", true],
    ["sem rodada anterior", null, "2026-11-02T12:00:00Z", true],
  ])("%s", (_label, last, current, expected) => {
    expect(pollDue(t(current as string), last ? t(last as string) : null)).toBe(expected);
  });

  it("nunca dois pollings no mesmo período, e nunca mais de 15 min + atraso sem um", () => {
    // Para qualquer última rodada, o próximo horário nominal sempre sincroniza.
    for (let offset = 0; offset < 15 * MIN; offset += 37_000) {
      const last = t("2026-11-02T12:00:00Z") + offset;
      expect(pollDue(t("2026-11-02T12:15:00Z"), last)).toBe(true);
    }
  });
});
