/**
 * @vitest-environment node
 *
 * B2, etapa 3 — rotas de manutenção (`/api/cron/calendar`) e webhook
 * (`/api/calendar/webhook`). Com a integração desligada (sem provedor —
 * hoje, em Preview e Production) nenhuma das duas toca no banco nem no
 * Google. Dados fictícios.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIVITY_ID, CALENDAR_ID, activity, makeFixture } from "../support/calendar-fixture";
import { InboundMemoryStore } from "../support/calendar-inbound-store";
import { MemorySchedulerStore } from "../support/calendar-scheduler-store";

const m = vi.hoisted(() => ({
  provider: { value: null as unknown },
  store: { value: null as unknown },
  storeCreated: vi.fn(),
  scheduler: { value: null as unknown },
  schedulerCreated: vi.fn(),
  accessToken: { value: "" },
}));

vi.mock("@/server/ingest/config", () => ({
  IngestConfigError: class extends Error {},
  getIngestConfig: () => ({ CRON_SECRET: "segredo-de-teste" }),
}));
vi.mock("@/server/calendar/provider", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCalendarProvider: async () => m.provider.value,
}));
vi.mock("@/server/calendar/admin/inbound-store", () => ({
  createSupabaseInboundStore: () => {
    m.storeCreated();
    return m.store.value;
  },
}));
vi.mock("@/server/calendar/admin/scheduler-store", () => ({
  createSupabaseSchedulerStore: () => {
    m.schedulerCreated();
    return m.scheduler.value;
  },
  createResendAlertSender: () => null,
}));
vi.mock("@/server/calendar/connection-context", () => ({
  loadConnectionContext: async () => ({ accessToken: m.accessToken.value }),
}));

import { POST as cron } from "@/app/api/cron/calendar/route";
import { POST as webhook } from "@/app/api/calendar/webhook/route";
import { createAppointment } from "@/server/calendar/sync/appointments";
import { isPublicPath } from "@/proxy";

const cronRequest = (auth?: string, query = "") =>
  new Request(`https://crm.exemplo.test/api/cron/calendar${query}`, { method: "POST", headers: auth ? { authorization: auth } : {} });

beforeEach(() => {
  m.provider.value = null;
  m.store.value = null;
  m.storeCreated.mockClear();
  m.scheduler.value = null;
  m.schedulerCreated.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/api/cron/calendar", () => {
  it("sem o segredo: 401", async () => {
    expect((await cron(cronRequest())).status).toBe(401);
    expect((await cron(cronRequest("Bearer outro"))).status).toBe(401);
    expect(m.storeCreated).not.toHaveBeenCalled();
  });

  it("integração desligada: não toca em nada", async () => {
    const res = await cron(cronRequest("Bearer segredo-de-teste"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
    expect(m.storeCreated).not.toHaveBeenCalled();
    expect(m.schedulerCreated).not.toHaveBeenCalled(); // nem o batimento
  });

  it("ligada (simulado): roda a manutenção e devolve só contagens, nunca conteúdo de evento", async () => {
    const f = await makeFixture();
    f.store.setActivity(activity());
    const created = await createAppointment(f.deps, f.conn, activity());
    if (created.status !== "created") throw new Error("setup");
    f.provider.externalEdit(CALENDAR_ID, created.eventId, { summary: "Título sigiloso do Google" });
    m.provider.value = f.provider;
    m.store.value = new InboundMemoryStore(f.store, () => new Date());
    const scheduler = new MemorySchedulerStore(() => new Date());
    m.scheduler.value = scheduler;
    m.accessToken.value = f.conn.accessToken;

    const res = await cron(cronRequest("Bearer segredo-de-teste"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ enabled: true, outcome: "ok", detector: null, targets: 1, synced: 1 });
    expect(JSON.stringify(body)).not.toMatch(/sigiloso|Reunião/);
    expect(f.store.activities.get(ACTIVITY_ID)!.title).toBe("Título sigiloso do Google");
    // Chamada avulsa: batimento "manual", que não conta como agendador automático.
    expect([...scheduler.heartbeats.keys()]).toEqual(["manual"]);
  });

  it("source=github: batimento da recuperação adicional e Detector 1 (principal desligado por padrão: nada a vigiar)", async () => {
    const f = await makeFixture();
    m.provider.value = f.provider;
    m.store.value = new InboundMemoryStore(f.store, () => new Date());
    const scheduler = new MemorySchedulerStore(() => new Date());
    m.scheduler.value = scheduler;

    const body = await (await cron(cronRequest("Bearer segredo-de-teste", "?source=github"))).json();

    expect(body).toMatchObject({ enabled: true, detector: "scheduler_disabled" });
    expect([...scheduler.heartbeats.keys()]).toEqual(["github"]);
    expect(scheduler.alerts).toEqual([]);
  });
});

describe("/api/calendar/webhook", () => {
  const notification = () =>
    new Request("https://crm.exemplo.test/api/calendar/webhook", {
      method: "POST",
      headers: { "x-goog-channel-id": "canal-x", "x-goog-channel-token": "t", "x-goog-resource-state": "exists" },
    });

  it("integração desligada: 404, sem tocar no banco", async () => {
    expect((await webhook(notification())).status).toBe(404);
    expect(m.storeCreated).not.toHaveBeenCalled();
  });

  it("ligada: canal desconhecido 404; malformada 400", async () => {
    const f = await makeFixture();
    m.provider.value = f.provider;
    m.store.value = new InboundMemoryStore(f.store, () => new Date());
    expect((await webhook(notification())).status).toBe(404);
    expect((await webhook(new Request("https://crm.exemplo.test/api/calendar/webhook", { method: "POST" }))).status).toBe(400);
  });

  it("é rota pública no proxy (o Google chega sem sessão); o resto da API de agenda não", () => {
    expect(isPublicPath("/api/calendar/webhook")).toBe(true);
    expect(isPublicPath("/api/calendar")).toBe(false);
    expect(isPublicPath("/api/calendar/outra")).toBe(false);
  });
});
