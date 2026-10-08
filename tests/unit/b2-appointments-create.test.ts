/**
 * @vitest-environment node
 *
 * B2, etapa 2 — criar compromisso no Google (provedor SIMULADO, dados
 * fictícios): evento único, idempotência por id determinístico com
 * conferência de 409, resultado incerto, Meet opcional, convidados só com
 * confirmação, disponibilidade e isolamento de ambiente.
 */
import { describe, expect, it } from "vitest";

import { CalendarSyncError } from "@/server/calendar/sync/types";
import { createAppointment, getAvailability, isSlotFree } from "@/server/calendar/sync/appointments";
import { deterministicEventId } from "@/server/calendar/sync/ids";

import { ACTIVITY_ID, CALENDAR_ID, activity, countCalls, makeFixture } from "../support/calendar-fixture";

const EVENT_ID = deterministicEventId("preview", ACTIVITY_ID, 1);

describe("criar", () => {
  it("cria UM evento marcado, de 60 min, sem convidados e sem e-mail do Google", async () => {
    const { provider, store, deps, conn } = await makeFixture();
    const result = await createAppointment(deps, conn, activity());

    expect(result).toMatchObject({ status: "created", eventId: EVENT_ID, adopted: false });
    expect(provider.eventCount(CALENDAR_ID)).toBe(1);

    const event = provider.peek(CALENDAR_ID, EVENT_ID)!;
    expect(event.summary).toBe("Reunião com cliente fictício");
    expect(event.start?.dateTime).toBe("2026-11-10T14:00:00.000Z");
    expect(event.end?.dateTime).toBe("2026-11-10T15:00:00.000Z");
    expect(event.extendedProperties?.private).toEqual({ crmAppointment: ACTIVITY_ID, crmEnv: "preview" });
    expect(event.attendees).toBeUndefined();
    expect(event.conferenceData).toBeUndefined();
    expect(provider.notificationsSent).toEqual([]);

    const link = await store.getLink(ACTIVITY_ID);
    expect(link).toMatchObject({ eventId: EVENT_ID, status: "linked", durationMinutes: 60, baseTitle: "Reunião com cliente fictício" });
    expect(link?.baseEtag).toBe(event.etag);
    expect(store.intents).toMatchObject([{ operation: "create", status: "succeeded" }]);
  });

  it("repetir (duplo clique) não cria outro evento nem chama o Google de novo", async () => {
    const { provider, deps, conn } = await makeFixture();
    await createAppointment(deps, conn, activity());
    const chamadas = provider.calls.length;

    const again = await createAppointment(deps, conn, activity());
    expect(again.status).toBe("already_linked");
    expect(provider.calls.length).toBe(chamadas);
    expect(provider.eventCount(CALENDAR_ID)).toBe(1);
  });

  it("vínculo perdido no CRM mas evento já existente: o 409 é CONFERIDO e o evento certo é adotado", async () => {
    const { provider, store, deps, conn } = await makeFixture();
    await createAppointment(deps, conn, activity());

    store.links.clear(); // o CRM não lembra do vínculo; o Google já tem o evento
    const result = await createAppointment(deps, conn, activity());

    expect(result).toMatchObject({ status: "created", adopted: true, eventId: EVENT_ID });
    expect(provider.eventCount(CALENDAR_ID)).toBe(1);
    expect(await store.getLink(ACTIVITY_ID)).toMatchObject({ eventId: EVENT_ID });
  });

  it("409 com evento de OUTRO compromisso (marca diferente): não adota, falha e registra", async () => {
    const { provider, store, deps, conn } = await makeFixture();
    // Alguém ocupou o id com um evento que NÃO é deste compromisso.
    await provider.insertEvent(conn.accessToken, CALENDAR_ID, {
      id: EVENT_ID,
      summary: "Outro assunto",
      start: { dateTime: "2026-11-10T14:00:00.000Z" },
      end: { dateTime: "2026-11-10T15:00:00.000Z" },
      extendedProperties: { private: { crmAppointment: "outro-compromisso", crmEnv: "preview" } },
    }, { sendUpdates: "none" });

    const result = await createAppointment(deps, conn, activity());

    expect(result).toEqual({ status: "failed", code: "id_conflict" });
    expect(await store.getLink(ACTIVITY_ID)).toBeNull();
    expect(store.intents[0]).toMatchObject({ status: "failed", errorCode: "id_conflict" });
  });

  it("409 com marca de outro AMBIENTE também não é adotado", async () => {
    const { provider, deps, conn } = await makeFixture();
    await provider.insertEvent(conn.accessToken, CALENDAR_ID, {
      id: EVENT_ID,
      extendedProperties: { private: { crmAppointment: ACTIVITY_ID, crmEnv: "production" } },
    }, { sendUpdates: "none" });

    expect(await createAppointment(deps, conn, activity())).toEqual({ status: "failed", code: "id_conflict" });
  });

  it("409 com evento já cancelado no Google: não recria, falha com código próprio", async () => {
    const { provider, deps, conn } = await makeFixture();
    await createAppointment(deps, conn, activity());
    provider.externalEdit(CALENDAR_ID, EVENT_ID, { status: "cancelled" });
    // Outro vínculo local (o primeiro foi perdido), mesmo compromisso.
    deps.store = (await makeFixture()).store;

    expect(await createAppointment(deps, conn, activity())).toEqual({ status: "failed", code: "event_cancelled_exists" });
  });

  it("erro HTTP do Google vira falha registrada, sem vínculo", async () => {
    const { provider, store, deps, conn } = await makeFixture();
    provider.injectFault({ operation: "insert", kind: "status", status: 403 });
    expect(await createAppointment(deps, conn, activity())).toEqual({ status: "failed", code: "provider_403" });
    expect(await store.getLink(ACTIVITY_ID)).toBeNull();
    expect(store.intents[0]).toMatchObject({ status: "failed", errorCode: "provider_403" });
  });
});

describe("resultado incerto: consulta o estado antes de repetir", () => {
  it("timeout DEPOIS de aplicar: acha o evento, adota e NÃO insere de novo", async () => {
    const { provider, store, deps, conn } = await makeFixture();
    provider.injectFault({ operation: "insert", kind: "timeout_after_apply" });

    const result = await createAppointment(deps, conn, activity());

    expect(result).toMatchObject({ status: "created", adopted: true });
    expect(countCalls(provider, "insert")).toBe(1);
    expect(provider.eventCount(CALENDAR_ID)).toBe(1);
    expect(await store.getLink(ACTIVITY_ID)).not.toBeNull();
  });

  it("timeout ANTES de aplicar: comprova que não existe e tenta UMA vez mais", async () => {
    const { provider, deps, conn } = await makeFixture();
    provider.injectFault({ operation: "insert", kind: "timeout_before_apply" });

    const result = await createAppointment(deps, conn, activity());

    expect(result).toMatchObject({ status: "created", adopted: false });
    expect(countCalls(provider, "insert")).toBe(2);
    expect(provider.eventCount(CALENDAR_ID)).toBe(1);
  });

  it("incerto de novo na segunda tentativa: para, deixa a intenção incerta e não cria vínculo", async () => {
    const { provider, store, deps, conn } = await makeFixture();
    provider.injectFault({ operation: "insert", kind: "timeout_before_apply" });
    provider.injectFault({ operation: "insert", kind: "timeout_before_apply" });

    const result = await createAppointment(deps, conn, activity());

    expect(result).toMatchObject({ status: "uncertain" });
    expect(countCalls(provider, "insert")).toBe(2);
    expect(await store.getLink(ACTIVITY_ID)).toBeNull();
    expect(store.intents[0]).toMatchObject({ status: "uncertain", errorCode: "result_uncertain" });
  });

  it("a própria consulta de recuperação falha: segue incerto, sem repetir a escrita", async () => {
    const { provider, store, deps, conn } = await makeFixture();
    provider.injectFault({ operation: "insert", kind: "timeout_after_apply" });
    provider.injectFault({ operation: "get", kind: "timeout_before_apply" });

    const result = await createAppointment(deps, conn, activity());

    expect(result).toMatchObject({ status: "uncertain" });
    expect(countCalls(provider, "insert")).toBe(1);
    expect(store.intents[0]!.status).toBe("uncertain");
    expect(await store.getLink(ACTIVITY_ID)).toBeNull();
  });

  it("depois de incerto, uma nova tentativa explícita adota o evento que existe (sem duplicar)", async () => {
    const { provider, store, deps, conn } = await makeFixture();
    provider.injectFault({ operation: "insert", kind: "timeout_after_apply" });
    provider.injectFault({ operation: "get", kind: "timeout_before_apply" });
    await createAppointment(deps, conn, activity()); // incerto

    const again = await createAppointment(deps, conn, activity());
    expect(again).toMatchObject({ status: "created", adopted: true });
    expect(provider.eventCount(CALENDAR_ID)).toBe(1);
    expect(await store.getLink(ACTIVITY_ID)).not.toBeNull();
  });
});

describe("Meet opcional", () => {
  it("com Meet: o pedido é acompanhado até success e o link fica guardado", async () => {
    const { provider, store, deps, conn } = await makeFixture();
    const result = await createAppointment(deps, conn, activity(), { withMeet: true });

    expect(result).toMatchObject({ status: "created", meet: { status: "success", url: `https://meet.simulated/${EVENT_ID}` } });
    expect(provider.peek(CALENDAR_ID, EVENT_ID)?.conferenceData?.createRequest?.requestId).toMatch(/^praxis-meet-/);
    expect(await store.getLink(ACTIVITY_ID)).toMatchObject({ meetStatus: "success", baseHasMeet: true });
  });

  it("Meet ainda pendente depois das consultas: fica pending, visível, sem inventar link", async () => {
    const { provider, store, deps, conn } = await makeFixture();
    provider.meetReadyAfterReads = 50;
    const result = await createAppointment(deps, conn, activity(), { withMeet: true });

    expect(result).toMatchObject({ status: "created", meet: { status: "pending", url: null } });
    expect(await store.getLink(ACTIVITY_ID)).toMatchObject({ meetStatus: "pending", meetUrl: null });
  });

  it("sem pedir Meet, nenhum Meet é criado", async () => {
    const { provider, deps, conn } = await makeFixture();
    const result = await createAppointment(deps, conn, activity());
    expect(result).toMatchObject({ meet: { status: null, url: null } });
    expect(provider.peek(CALENDAR_ID, EVENT_ID)?.conferenceData).toBeUndefined();
  });
});

describe("convidados: desativados por padrão", () => {
  it("convidar sem confirmação explícita é recusado antes de qualquer efeito", async () => {
    const { provider, store, deps, conn } = await makeFixture();
    await expect(
      createAppointment(deps, conn, activity(), { invite: { emails: ["cliente@exemplo.test"], confirmed: false } }),
    ).rejects.toMatchObject({ code: "invites_require_confirmation" });
    expect(provider.calls).toEqual([]);
    expect(store.intents).toEqual([]);
  });

  it("com confirmação explícita, convida e só então o Google envia e-mail", async () => {
    const { provider, deps, conn } = await makeFixture();
    await createAppointment(deps, conn, activity(), { invite: { emails: ["cliente@exemplo.test"], confirmed: true } });

    expect(provider.peek(CALENDAR_ID, EVENT_ID)?.attendees).toEqual([{ email: "cliente@exemplo.test" }]);
    expect(provider.notificationsSent).toEqual([{ eventId: EVENT_ID, to: ["cliente@exemplo.test"] }]);
  });
});

describe("validações, ambiente e disponibilidade", () => {
  it("só compromisso (reunião com horário) vira evento, duração dentro dos limites", async () => {
    const { provider, store, deps, conn } = await makeFixture();
    await expect(createAppointment(deps, conn, activity({ type: "task" }))).rejects.toMatchObject({ code: "activity_not_appointment" });
    await expect(createAppointment(deps, conn, activity({ hasTime: false }))).rejects.toMatchObject({ code: "activity_not_appointment" });
    await expect(createAppointment(deps, conn, activity(), { durationMinutes: 5 })).rejects.toMatchObject({ code: "invalid_duration" });
    await expect(createAppointment(deps, conn, activity(), { durationMinutes: 600 })).rejects.toMatchObject({ code: "invalid_duration" });
    expect(provider.calls).toEqual([]);
    expect(store.intents).toEqual([]);
  });

  it("conexão de OUTRO ambiente é recusada antes de qualquer chamada ao Google", async () => {
    const { provider, store, deps, conn } = await makeFixture("preview");
    await expect(createAppointment(deps, { ...conn, environment: "production" }, activity())).rejects.toBeInstanceOf(CalendarSyncError);
    expect(provider.calls).toEqual([]);
    expect(store.intents).toEqual([]);
  });

  it("atividade já vinculada a OUTRO ambiente é recusada, sem chamar o Google", async () => {
    const { provider, store, deps, conn } = await makeFixture("preview");
    store.seedLink({ activityId: ACTIVITY_ID, eventId: "evento-de-producao", environment: "production" });
    await expect(createAppointment(deps, conn, activity())).rejects.toMatchObject({ code: "calendar_environment_mismatch" });
    expect(provider.calls).toEqual([]);
  });

  it("freebusy: só intervalos, inclusive de evento pessoal, sem título nem persistência", async () => {
    const { provider, store, deps, conn } = await makeFixture();
    provider.addExternalEvent(CALENDAR_ID, "2026-11-10T14:30:00.000Z", "2026-11-10T15:30:00.000Z", "Consulta médica (pessoal)");

    const busy = await getAvailability(deps, conn, { from: "2026-11-10T00:00:00.000Z", to: "2026-11-11T00:00:00.000Z" });

    expect(busy).toEqual([{ start: "2026-11-10T14:30:00.000Z", end: "2026-11-10T15:30:00.000Z" }]);
    expect(JSON.stringify(busy)).not.toContain("médica");
    expect(isSlotFree(busy, "2026-11-10T14:00:00.000Z", "2026-11-10T15:00:00.000Z")).toBe(false);
    expect(isSlotFree(busy, "2026-11-10T15:30:00.000Z", "2026-11-10T16:30:00.000Z")).toBe(true);
    expect(JSON.stringify([...store.links.values(), ...store.intents, ...store.conflicts])).not.toContain("médica");
  });

  it("requireFree: horário ocupado não cria evento", async () => {
    const { provider, store, deps, conn } = await makeFixture();
    provider.addExternalEvent(CALENDAR_ID, "2026-11-10T13:30:00.000Z", "2026-11-10T14:30:00.000Z");

    const result = await createAppointment(deps, conn, activity(), { requireFree: true });

    expect(result).toMatchObject({ status: "busy" });
    expect(countCalls(provider, "insert")).toBe(0);
    expect(store.intents).toEqual([]);
  });

  it("requireFree com horário livre cria normalmente", async () => {
    const { provider, deps, conn } = await makeFixture();
    expect(await createAppointment(deps, conn, activity(), { requireFree: true })).toMatchObject({ status: "created" });
    expect(provider.eventCount(CALENDAR_ID)).toBe(1);
  });

  it("freebusy de conexão de outro ambiente é recusado sem chamar o Google", async () => {
    const { provider, deps, conn } = await makeFixture("preview");
    await expect(getAvailability(deps, { ...conn, environment: "production" }, { from: "a", to: "b" })).rejects.toMatchObject({
      code: "calendar_environment_mismatch",
    });
    expect(provider.calls).toEqual([]);
  });
});
