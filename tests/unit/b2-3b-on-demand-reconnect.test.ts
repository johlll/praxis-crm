/**
 * @vitest-environment node
 *
 * B2, etapa 3b — sincronização sob demanda (§9.2, item 3) e reconexão que
 * reencontra os vínculos (§6.5, critério 12). Orquestradores REAIS, provedor
 * SIMULADO, dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createAppointment } from "@/server/calendar/sync/appointments";
import { syncCalendar } from "@/server/calendar/sync/inbound";
import type { InboundDeps } from "@/server/calendar/sync/inbound-types";
import { ON_DEMAND_MIN_INTERVAL_MS, syncOwnCalendarsOnDemand } from "@/server/calendar/sync/on-demand";
import { recoverLinksAfterReconnect } from "@/server/calendar/sync/reconnect";
import type { ConnectionContext } from "@/server/calendar/sync/types";

import { ACTIVITY_ID, CALENDAR_ID, activity, countCalls, makeFixture } from "../support/calendar-fixture";
import { InboundMemoryStore } from "../support/calendar-inbound-store";

let f: Awaited<ReturnType<typeof makeFixture>>;
let clock: { t: number };
let inbound: InboundMemoryStore;
let deps: InboundDeps;
let eventId: string;

const crm = () => f.store.activities.get(ACTIVITY_ID)!;
const linkOf = () => [...f.store.links.values()].find((l) => l.activityId === ACTIVITY_ID)!;
const own = () => ({ connectionId: "conn-1", userId: "user-1", accessToken: f.conn.accessToken });

beforeEach(async () => {
  f = await makeFixture();
  clock = { t: Date.parse("2026-11-01T12:00:00.000Z") };
  const now = () => new Date(clock.t);
  f.provider.now = () => clock.t;
  inbound = new InboundMemoryStore(f.store, now);
  deps = { api: f.provider, store: inbound, environment: "preview", now };
  f.store.setActivity(activity());
  const created = await createAppointment(f.deps, f.conn, activity());
  if (created.status !== "created") throw new Error("setup");
  eventId = created.eventId;
  f.provider.calls.length = 0;
});

describe("sob demanda", () => {
  it("nunca sincronizada: sincroniza na hora e traz o que mudou no Google", async () => {
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Mudou no Google" });
    expect(await syncOwnCalendarsOnDemand(deps, own())).toMatchObject({ calendars: 1, synced: 1 });
    expect(crm().title).toBe("Mudou no Google");
  });

  it("sincronizada há menos de 5 min: não chama o Google; depois de 5 min, chama", async () => {
    await syncOwnCalendarsOnDemand(deps, own());
    f.provider.calls.length = 0;

    clock.t += ON_DEMAND_MIN_INTERVAL_MS - 1000;
    expect(await syncOwnCalendarsOnDemand(deps, own())).toMatchObject({ synced: 0, skippedRecent: 1 });
    expect(f.provider.calls).toEqual([]);

    clock.t += 2000;
    expect(await syncOwnCalendarsOnDemand(deps, own())).toMatchObject({ synced: 1 });
  });

  it("outra execução com a trava: não dispara uma segunda", async () => {
    await inbound.claimSync("user-1", "conn-1", CALENDAR_ID);
    expect(await syncOwnCalendarsOnDemand(deps, own())).toMatchObject({ synced: 0, skippedRecent: 1 });
    expect(countCalls(f.provider, "list")).toBe(0);
  });

  it("só a PRÓPRIA conexão: outro usuário é recusado antes de qualquer chamada", async () => {
    await expect(syncOwnCalendarsOnDemand(deps, { ...own(), userId: "user-2" })).rejects.toThrow("connection_not_found");
    expect(f.provider.calls).toEqual([]);
  });
});

describe("reconexão reencontra os vínculos", () => {
  const conn2: ConnectionContext = { connectionId: "conn-2", calendarId: CALENDAR_ID, environment: "preview", accessToken: "" };

  /** Desconectar (como `disconnect_calendar_connection`) e reconectar a mesma conta (conexão nova). */
  async function disconnectAndReconnect() {
    await syncCalendar(deps, { ...own(), calendarId: CALENDAR_ID, environment: "preview" }); // base e token antes
    inbound.connections.get("conn-1")!.status = "disconnected";
    for (const l of f.store.links.values()) if (l.connectionId === "conn-1") l.status = "unlinked";
    inbound.connections.set("conn-2", { id: "conn-2", userId: "user-1", workspaceId: "ws-1", status: "active" });
    conn2.accessToken = f.conn.accessToken;
    f.provider.calls.length = 0;
  }

  const recover = () =>
    recoverLinksAfterReconnect({ inbound: deps, outbound: f.deps }, { connectionId: "conn-2", userId: "user-1", accessToken: f.conn.accessToken });

  it("Google mudou o título e o CRM mudou o horário enquanto desconectado: os dois chegam, sem conflito", async () => {
    await disconnectAndReconnect();
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Título mudado no Google" });
    crm().dueAt = "2026-11-12T16:00:00.000Z";
    crm().lockVersion += 1;

    expect(await recover()).toMatchObject({ candidates: 1, relinked: 1, pushed: 1, refused: 0 });

    expect(linkOf()).toMatchObject({ connectionId: "conn-2", status: "linked" });
    expect(crm()).toMatchObject({ title: "Título mudado no Google", dueAt: "2026-11-12T16:00:00.000Z" });
    expect(f.provider.peek(CALENDAR_ID, eventId)).toMatchObject({
      summary: "Título mudado no Google",
      start: { dateTime: "2026-11-12T16:00:00.000Z" },
    });
    expect(f.store.conflicts).toEqual([]);
    expect(countCalls(f.provider, "insert")).toBe(0); // reencontrado, nunca recriado
  });

  it("os dois mudaram o título: o Google prevalece e o valor do CRM fica gravado", async () => {
    await disconnectAndReconnect();
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Do Google" });
    crm().title = "Do CRM";
    crm().lockVersion += 1;

    await recover();

    expect(crm().title).toBe("Do Google");
    expect(f.store.conflicts).toEqual([expect.objectContaining({ field: "title", crmValue: "Do CRM", googleValue: "Do Google" })]);
  });

  it("evento apagado no Google enquanto desconectado: não é recriado; a atividade fica, sem vínculo", async () => {
    await disconnectAndReconnect();
    f.provider.externalEdit(CALENDAR_ID, eventId, { status: "cancelled" });

    expect(await recover()).toMatchObject({ candidates: 1, relinked: 0, gone: 1 });
    expect(linkOf().status).toBe("unlinked");
    expect(f.store.activities.has(ACTIVITY_ID)).toBe(true);
    expect(countCalls(f.provider, "insert")).toBe(0);
  });

  it("evento com a marca de OUTRO compromisso ou ambiente: nunca adotado", async () => {
    await disconnectAndReconnect();
    f.provider.externalEdit(CALENDAR_ID, eventId, { extendedProperties: { private: { crmAppointment: "outra", crmEnv: "preview" } } });
    expect(await recover()).toMatchObject({ relinked: 0, refused: 1 });

    f.provider.externalEdit(CALENDAR_ID, eventId, { extendedProperties: { private: { crmAppointment: ACTIVITY_ID, crmEnv: "production" } } });
    expect(await recover()).toMatchObject({ relinked: 0, refused: 1 });
    expect(linkOf().status).toBe("unlinked");
  });

  it("agenda que a conta reconectada não alcança: fica sem vínculo, nada é alterado", async () => {
    await disconnectAndReconnect();
    f.provider.revokeCalendarAccess(CALENDAR_ID, 403);
    expect(await recover()).toMatchObject({ relinked: 0, unreachable: 1 });
    f.provider.revokeCalendarAccess(CALENDAR_ID, 404);
    expect(await recover()).toMatchObject({ relinked: 0, unreachable: 1 });
  });

  it("falha temporária do Google: fica para depois; repetir conclui, e o que já voltou não é listado de novo", async () => {
    await disconnectAndReconnect();
    f.provider.injectFault({ operation: "get", kind: "status", status: 503 });
    expect(await recover()).toMatchObject({ relinked: 0, failed: 1 });
    expect(await recover()).toMatchObject({ relinked: 1 });
    expect(await recover()).toMatchObject({ candidates: 0 });
  });

  it("atividade que deixou de ser reunião com horário: não é revinculada", async () => {
    await disconnectAndReconnect();
    crm().type = "task";
    expect(await recover()).toMatchObject({ relinked: 0, notAppointment: 1 });
  });

  it("só vínculos do MESMO usuário, de conexão desconectada, cuja atividade não tem outro vínculo ativo", async () => {
    await disconnectAndReconnect();
    // Conexão de outro usuário, desconectada: os vínculos dela não aparecem.
    inbound.connections.set("conn-x", { id: "conn-x", userId: "user-2", workspaceId: "ws-1", status: "disconnected" });
    f.store.seedLink({ activityId: "a1b2c3d4-0000-4000-8000-00000000a0aa", eventId: "evt-x", connectionId: "conn-x", status: "unlinked" });
    f.store.setActivity(activity({ id: "a1b2c3d4-0000-4000-8000-00000000a0aa" }));
    expect((await inbound.listRecoverableLinks("user-1", "conn-2")).map((l) => l.activityId)).toEqual([ACTIVITY_ID]);

    // A atividade ganhou outro vínculo ativo depois de desconectar: o antigo não volta.
    f.store.seedLink({ activityId: ACTIVITY_ID, eventId: "evt-novo", connectionId: "conn-2" });
    expect(await inbound.listRecoverableLinks("user-1", "conn-2")).toEqual([]);
    expect(await inbound.relinkRecovered("user-1", linkOf().id, "conn-2")).toBe("not_recoverable");
  });

  it("outro usuário não usa a conexão nova para recuperar", async () => {
    await disconnectAndReconnect();
    await expect(
      recoverLinksAfterReconnect({ inbound: deps, outbound: f.deps }, { connectionId: "conn-2", userId: "user-2", accessToken: "x" }),
    ).rejects.toThrow("connection_not_found");
    expect(f.provider.calls).toEqual([]);
  });
});
