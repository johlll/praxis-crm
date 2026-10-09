/**
 * @vitest-environment node
 *
 * B2, etapa 3 — canais de notificação, webhook e rodada de manutenção
 * (docs/decisoes/b2-google-agenda.md §9.2, §9.4; §10 itens 13 e 16).
 * Orquestrador REAL, provedor SIMULADO, relógio controlado, dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { cancelAppointment, createAppointment } from "@/server/calendar/sync/appointments";
import { channelSchedule, hashChannelToken } from "@/server/calendar/sync/channels";
import type { InboundDeps } from "@/server/calendar/sync/inbound-types";
import { runCalendarMaintenance, type MaintenanceDeps, type OpenedConnection } from "@/server/calendar/sync/maintenance";
import { handleCalendarNotification } from "@/server/calendar/sync/webhook";
import type { SimulatedNotification } from "@/server/calendar/simulated-provider";

import { ACTIVITY_ID, CALENDAR_ID, activity, countCalls, makeFixture } from "../support/calendar-fixture";
import { InboundMemoryStore } from "../support/calendar-inbound-store";

const HOUR = 3600_000;
const MIN = 60_000;
const WEBHOOK = "https://crm.exemplo.test/api/calendar/webhook";

let f: Awaited<ReturnType<typeof makeFixture>>;
let clock: { t: number };
let inbound: InboundMemoryStore;
let deps: InboundDeps;
let eventId: string;
let opened: OpenedConnection;

const maintain = (extra: Partial<MaintenanceDeps> = {}) =>
  runCalendarMaintenance({ ...deps, openConnection: async () => opened, webhookAddress: WEBHOOK, ...extra });

const headersOf = (n: SimulatedNotification, override: Record<string, string> = {}) =>
  new Headers({
    "x-goog-channel-id": n.channelId,
    "x-goog-channel-token": n.token,
    "x-goog-resource-id": n.resourceId,
    "x-goog-resource-state": n.resourceState,
    "x-goog-message-number": String(n.messageNumber),
    "x-goog-channel-expiration": new Date(n.expiration).toUTCString(),
    ...override,
  });

/** Entrega ao webhook o que o Google teria enviado. */
const deliver = async () => Promise.all(f.provider.drainNotifications().map((n) => handleCalendarNotification(headersOf(n), inbound)));

const channels = () => [...inbound.channels.values()];
const live = () => channels().filter((c) => c.status === "active");

beforeEach(async () => {
  f = await makeFixture();
  clock = { t: Date.parse("2026-11-01T12:00:00.000Z") };
  const now = () => new Date(clock.t);
  f.provider.now = () => clock.t;
  inbound = new InboundMemoryStore(f.store, now);
  deps = { api: f.provider, store: inbound, environment: "preview", now };
  opened = { accessToken: f.conn.accessToken };
  f.store.setActivity(activity());
  const created = await createAppointment(f.deps, f.conn, activity());
  if (created.status !== "created") throw new Error("setup");
  eventId = created.eventId;
  f.provider.drainNotifications();
  f.provider.calls.length = 0;
});

describe("cronograma de renovação pela vida EFETIVA", () => {
  it("7 dias: renova com 70% da vida", () => {
    expect(channelSchedule(0, 7 * 24 * HOUR)).toEqual({ viable: true, renewAtMs: 0.7 * 7 * 24 * HOUR });
  });
  it("TTL curto (< 24 h, mas viável): nunca antes de metade da vida nem de 10 min", () => {
    const { renewAtMs } = channelSchedule(0, 60 * MIN);
    expect(renewAtMs).toBe(42 * MIN);
    expect(renewAtMs!).toBeGreaterThanOrEqual(30 * MIN);
  });
  it("vida menor que 3 × o intervalo do agendador (45 min): inviável — só polling", () => {
    expect(channelSchedule(0, 30 * MIN)).toEqual({ viable: false, renewAtMs: null });
  });
});

describe("rodada de manutenção", () => {
  it("cria o canal (linha ANTES da chamada, só o hash do segredo), sincroniza e grava o token", async () => {
    const report = await maintain();

    expect(report).toMatchObject({ targets: 1, synced: 1, full: 1, channelsCreated: 1 });
    expect(live()).toHaveLength(1);
    const [channel] = live();
    expect(channel!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const sent = f.provider.channels.get(channel!.channelId)!;
    expect(channel!.tokenHash).toBe(hashChannelToken(sent.token));
    expect(JSON.stringify([...inbound.channels.values()])).not.toContain(sent.token);
    expect(channel!.renewAt).toBe(new Date(clock.t + 0.7 * 7 * 24 * HOUR).toISOString());
  });

  it("notificação do Google → webhook marca a agenda → a manutenção seguinte sincroniza na hora", async () => {
    await maintain();
    expect(await deliver()).toEqual([200]); // a mensagem `sync` do canal novo
    f.provider.calls.length = 0;

    clock.t += 1 * MIN; // polling ainda não venceu
    expect((await maintain()).synced).toBe(0);
    expect(countCalls(f.provider, "list")).toBe(0);

    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Alterado no Google" });
    expect(await deliver()).toEqual([200]);
    clock.t += 1 * MIN;
    expect((await maintain()).synced).toBe(1);
    expect(f.store.activities.get(ACTIVITY_ID)!.title).toBe("Alterado no Google");
  });

  it("sem webhook (notificação perdida ou endereço não configurado): o polling de 15 min recupera", async () => {
    await maintain({ webhookAddress: null });
    expect(countCalls(f.provider, "watch")).toBe(0);
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Sem notificação" });

    clock.t += 5 * MIN;
    expect((await maintain({ webhookAddress: null })).synced).toBe(0);
    clock.t += 11 * MIN;
    expect((await maintain({ webhookAddress: null })).synced).toBe(1);
    expect(f.store.activities.get(ACTIVITY_ID)!.title).toBe("Sem notificação");
  });

  it("sync completo de segurança a cada 24 h", async () => {
    await maintain();
    clock.t += 25 * HOUR;
    expect(await maintain()).toMatchObject({ synced: 1, full: 1 });
  });

  it("refresh token inválido: conexão a reautorizar, nada é chamado no Google", async () => {
    opened = "needs_reauth";
    expect(await maintain()).toMatchObject({ needsReauth: 1, synced: 0 });
    expect(inbound.connections.get("conn-1")!.status).toBe("needs_reauth");
    expect(f.provider.calls).toEqual([]);
    // Na rodada seguinte a conexão nem é alvo: sem laço.
    expect(await maintain()).toMatchObject({ targets: 0, needsReauth: 0 });
  });
});

describe("renovação com sobreposição", () => {
  it("cria o NOVO antes de parar o velho; o velho só para depois que o novo entregar", async () => {
    await maintain();
    await deliver();
    const [old] = live();

    clock.t = Date.parse(old!.renewAt!) + MIN;
    expect(await maintain()).toMatchObject({ channelsRenewed: 1, channelsStopped: 0 });
    expect(countCalls(f.provider, "watch")).toBe(2);
    expect(inbound.channels.get(old!.channelId)!.status).toBe("retiring");
    expect(f.provider.channels.get(old!.channelId)!.stopped).toBe(false);

    // O novo entrega a primeira mensagem; na rodada seguinte o velho é parado.
    await deliver();
    expect(await maintain()).toMatchObject({ channelsStopped: 1 });
    expect(inbound.channels.get(old!.channelId)!.status).toBe("stopped");
    expect(f.provider.channels.get(old!.channelId)!.stopped).toBe(true);
    expect(live()).toHaveLength(1);
  });

  it("duas rodadas simultâneas renovam UMA vez (trava atômica)", async () => {
    await maintain();
    await deliver();
    clock.t = Date.parse(live()[0]!.renewAt!) + MIN;
    f.provider.calls.length = 0;

    const reports = await Promise.all([maintain(), maintain()]);

    expect(countCalls(f.provider, "watch")).toBe(1);
    expect(reports.reduce((n, r) => n + r.channelsRenewed, 0)).toBe(1);
    expect(reports.reduce((n, r) => n + r.synced + r.busy, 0)).toBeGreaterThanOrEqual(1);
  });

  it("TTL curto demais: só polling, canal encerrado no Google e sem tentar em laço", async () => {
    f.provider.channelTtlMs = 30 * MIN;
    expect(await maintain()).toMatchObject({ pollingOnly: 1, channelsCreated: 0 });
    expect(channels()[0]!.status).toBe("polling_only");
    expect(countCalls(f.provider, "stop")).toBe(1);

    clock.t += HOUR;
    await maintain();
    expect(countCalls(f.provider, "watch")).toBe(1);
  });

  it("canal vencido: encerrado e substituído", async () => {
    await maintain();
    const [first] = live();
    clock.t = Date.parse(first!.expiresAt!) + MIN;
    await maintain();
    expect(inbound.channels.get(first!.channelId)!.status).toBe("stopped");
    clock.t += MIN;
    await maintain();
    expect(live()).toHaveLength(1);
    expect(live()[0]!.channelId).not.toBe(first!.channelId);
  });
});

describe("resposta do watch perdida", () => {
  it("o Google criou, a resposta se perdeu: a primeira mensagem revela o canal e ele é ativado — sem criar outro", async () => {
    f.provider.injectFault({ operation: "watch", kind: "timeout_after_apply" });
    await maintain();
    expect(channels()[0]!.status).toBe("creating");

    clock.t += MIN;
    await maintain(); // ainda dentro do prazo: não cria outro
    expect(countCalls(f.provider, "watch")).toBe(1);

    await deliver(); // `sync` com recurso e validade
    clock.t += MIN;
    await maintain();
    expect(countCalls(f.provider, "watch")).toBe(1);
    expect(live()).toHaveLength(1);
    expect(live()[0]!.resourceId).toBe(`simres-${CALENDAR_ID}`);
  });

  it("a requisição não chegou: abandonado depois do prazo e criado de novo", async () => {
    f.provider.injectFault({ operation: "watch", kind: "timeout_before_apply" });
    await maintain();
    const [abandoned] = channels();
    clock.t += 11 * MIN;
    await maintain();
    expect(inbound.channels.get(abandoned!.channelId)!.status).toBe("stopped");
    clock.t += MIN;
    await maintain();
    expect(live()).toHaveLength(1);
  });
});

describe("webhook", () => {
  async function canalAtivo() {
    await maintain();
    const [n] = f.provider.drainNotifications();
    return n!;
  }

  it("canal desconhecido, segredo errado ou recurso diferente: 404, nada marcado", async () => {
    const n = await canalAtivo();
    expect(await handleCalendarNotification(headersOf(n, { "x-goog-channel-id": "canal-inventado" }), inbound)).toBe(404);
    expect(await handleCalendarNotification(headersOf(n, { "x-goog-channel-token": "segredo-errado" }), inbound)).toBe(404);
    expect(await handleCalendarNotification(headersOf(n), inbound)).toBe(200);
    expect(
      await handleCalendarNotification(headersOf(n, { "x-goog-resource-id": "outro-recurso", "x-goog-resource-state": "exists" }), inbound),
    ).toBe(404);
    expect(inbound.states.get(`conn-1|${CALENDAR_ID}`)!.dirtyAt).toBeNull();
  });

  it("notificação malformada: 400", async () => {
    const n = await canalAtivo();
    expect(await handleCalendarNotification(new Headers({ "x-goog-channel-id": n.channelId }), inbound)).toBe(400);
  });

  it("canal já encerrado: 200 (o Google não precisa repetir), mas ignorado", async () => {
    const n = await canalAtivo();
    await inbound.stopChannel("user-1", n.channelId, "teste");
    expect(await handleCalendarNotification(headersOf(n, { "x-goog-resource-state": "exists" }), inbound)).toBe(200);
    expect(inbound.states.get(`conn-1|${CALENDAR_ID}`)!.dirtyAt).toBeNull();
  });
});

describe("lotes da manutenção", () => {
  /** Agendas extras da mesma conexão, cada uma com um compromisso vinculado e já sincronizado. */
  function agendasExtras(n: number): string[] {
    const calendars: string[] = [];
    for (let i = 0; i < n; i++) {
      const calendarId = `extra-${String(i).padStart(2, "0")}@calendar.simulated`;
      const id = f.provider.addExternalEvent(calendarId, "2026-11-20T10:00:00.000Z", "2026-11-20T11:00:00.000Z", "Compromisso fictício");
      const event = f.provider.peek(calendarId, id)!;
      const activityId = `a1b2c3d4-0000-4000-8000-${String(100 + i).padStart(12, "0")}`;
      f.store.setActivity(activity({ id: activityId, title: "Compromisso fictício", dueAt: "2026-11-20T10:00:00.000Z" }));
      f.store.seedLink({
        activityId,
        eventId: id,
        calendarId,
        baseEtag: event.etag,
        baseTitle: "Compromisso fictício",
        baseStart: event.start!.dateTime,
        baseEnd: event.end!.dateTime,
      });
      calendars.push(calendarId);
    }
    return calendars;
  }
  const listed = () => new Set(f.provider.calls.filter((c) => c.operation === "list").map((c) => c.calendarId));

  it("31 agendas, lote de 25: canais fora do lote são preservados e todas são atendidas na rodada seguinte", async () => {
    agendasExtras(30); // + a principal = 31
    await maintain({ maxTargets: 100 }); // um canal por agenda
    expect(live()).toHaveLength(31);
    f.provider.calls.length = 0;

    clock.t += 16 * MIN; // polling vencido em todas
    const first = await maintain();
    expect(first).toMatchObject({ targets: 25, synced: 25, channelsStopped: 0 });
    expect(live()).toHaveLength(31);
    expect(countCalls(f.provider, "stop")).toBe(0);

    const second = await maintain();
    expect(second).toMatchObject({ synced: 6, channelsStopped: 0 });
    expect(listed().size).toBe(31); // nenhuma ficou sem atendimento
    expect(live()).toHaveLength(31);
    expect(countCalls(f.provider, "stop")).toBe(0);
  });

  it("progresso entre rodadas: com lote de 4, as 11 agendas são todas atendidas em 3 rodadas, sem repetir antes da vez", async () => {
    agendasExtras(10);
    const served: string[][] = [];
    for (let round = 0; round < 3; round++) {
      f.provider.calls.length = 0;
      await maintain({ maxTargets: 4, webhookAddress: null });
      served.push([...listed()].map(String));
    }
    expect(served.map((s) => s.length)).toEqual([4, 4, 3]);
    expect(new Set(served.flat()).size).toBe(11);
  });

  it("agenda REALMENTE sem vínculo continua tendo o canal encerrado, mesmo fora do lote", async () => {
    agendasExtras(3);
    await maintain({ maxTargets: 100 });
    await cancelAppointment(f.deps, f.conn, { ...f.store.activities.get(ACTIVITY_ID)! });
    f.provider.calls.length = 0;

    const report = await maintain({ maxTargets: 1 });

    expect(report.channelsStopped).toBe(1);
    expect(channels().filter((c) => c.status === "stopped").map((c) => c.calendarId)).toEqual([CALENDAR_ID]);
    expect(live()).toHaveLength(3);
  });
});

describe("encerramento", () => {
  it("agenda sem nenhum vínculo ativo: o canal é encerrado", async () => {
    await maintain();
    await deliver();
    await cancelAppointment(f.deps, f.conn, { ...f.store.activities.get(ACTIVITY_ID)! });
    expect(await maintain()).toMatchObject({ targets: 0, channelsStopped: 1 });
    expect(live()).toHaveLength(0);
    expect(countCalls(f.provider, "stop")).toBe(1);
  });
});
