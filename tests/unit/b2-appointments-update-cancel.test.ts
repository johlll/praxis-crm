/**
 * @vitest-environment node
 *
 * B2, etapa 2 — reagendar, adicionar Meet e cancelar com base de
 * sincronização, If-Match/412 com releitura, conflito sem perda silenciosa
 * e recuperação de resultado incerto (provedor SIMULADO, dados fictícios).
 */
import { describe, expect, it } from "vitest";

import {
  addMeetToAppointment,
  cancelAppointment,
  createAppointment,
  rescheduleAppointment,
} from "@/server/calendar/sync/appointments";
import { deterministicEventId } from "@/server/calendar/sync/ids";

import { ACTIVITY_ID, CALENDAR_ID, activity, countCalls, makeFixture } from "../support/calendar-fixture";

const EVENT_ID = deterministicEventId("preview", ACTIVITY_ID, 1);
const REMARCADO = activity({ dueAt: "2026-11-12T16:00:00.000Z", lockVersion: 4 });

async function comEventoCriado(withMeet = false) {
  const f = await makeFixture();
  await createAppointment(f.deps, f.conn, activity(), { withMeet });
  return f;
}

describe("reagendar", () => {
  it("mudança só do CRM: PATCH com If-Match e a base avança", async () => {
    const { provider, store, deps, conn } = await comEventoCriado();
    const antes = provider.peek(CALENDAR_ID, EVENT_ID)!.etag;

    const result = await rescheduleAppointment(deps, conn, REMARCADO);

    expect(result.status).toBe("updated");
    const event = provider.peek(CALENDAR_ID, EVENT_ID)!;
    expect(event.start?.dateTime).toBe("2026-11-12T16:00:00.000Z");
    expect(event.end?.dateTime).toBe("2026-11-12T17:00:00.000Z");
    expect(event.etag).not.toBe(antes);

    const link = await store.getLink(ACTIVITY_ID);
    expect(link).toMatchObject({ baseStart: "2026-11-12T16:00:00.000Z", baseEnd: "2026-11-12T17:00:00.000Z", baseEtag: event.etag, baseCrmVersion: 4 });
    expect(store.conflicts).toEqual([]);
  });

  it("nada mudou: não chama PATCH", async () => {
    const { provider, deps, conn } = await comEventoCriado();
    const result = await rescheduleAppointment(deps, conn, activity());
    expect(result.status).toBe("unchanged");
    expect(countCalls(provider, "patch")).toBe(0);
  });

  it("título novo no CRM vai ao Google junto com o horário", async () => {
    const { provider, deps, conn } = await comEventoCriado();
    await rescheduleAppointment(deps, conn, { ...REMARCADO, title: "Reunião de alinhamento" });
    expect(provider.peek(CALENDAR_ID, EVENT_ID)?.summary).toBe("Reunião de alinhamento");
  });

  it("edição concorrente de OUTRO campo no Google: 412, relê, aplica o horário e preserva o título do Google", async () => {
    const { provider, store, deps, conn } = await comEventoCriado();
    // Entre a leitura e a escrita do CRM, o Google renomeia o evento.
    provider.onBefore("patch", () => provider.externalEdit(CALENDAR_ID, EVENT_ID, { summary: "Renomeado direto no Google" }));

    const result = await rescheduleAppointment(deps, conn, REMARCADO);

    expect(result.status).toBe("updated");
    expect(countCalls(provider, "patch")).toBe(2); // 412 e depois sucesso
    const event = provider.peek(CALENDAR_ID, EVENT_ID)!;
    expect(event.start?.dateTime).toBe("2026-11-12T16:00:00.000Z");
    expect(event.summary).toBe("Renomeado direto no Google"); // nada foi sobrescrito
    expect(store.conflicts).toEqual([]);
    // A mudança só do Google fica para a sincronização de entrada: a base do título NÃO avançou.
    expect((await store.getLink(ACTIVITY_ID))?.baseTitle).toBe("Reunião com cliente fictício");
  });

  it("MESMO campo editado nos dois lados com valores diferentes: Google prevalece e o valor do CRM fica REGISTRADO", async () => {
    const { provider, store, deps, conn } = await comEventoCriado();
    provider.externalEdit(CALENDAR_ID, EVENT_ID, {
      start: { dateTime: "2026-11-13T09:00:00.000Z" },
      end: { dateTime: "2026-11-13T10:00:00.000Z" },
    });

    const result = await rescheduleAppointment(deps, conn, REMARCADO);

    expect(result).toMatchObject({ status: "conflict_resolved", conflicts: [{ field: "schedule" }] });
    // O CRM converge para o Google...
    expect(store.appliedToActivity).toEqual([{ activityId: ACTIVITY_ID, dueAt: "2026-11-13T09:00:00.000Z", title: undefined }]);
    // ...e o Google não foi tocado.
    expect(countCalls(provider, "patch")).toBe(0);
    expect(provider.peek(CALENDAR_ID, EVENT_ID)?.start?.dateTime).toBe("2026-11-13T09:00:00.000Z");
    // A edição do CRM NÃO foi descartada em silêncio.
    expect(store.conflicts).toEqual([
      {
        linkId: expect.any(String),
        field: "schedule",
        crmValue: { start: "2026-11-12T16:00:00.000Z", end: "2026-11-12T17:00:00.000Z" },
        googleValue: { start: "2026-11-13T09:00:00.000Z", end: "2026-11-13T10:00:00.000Z" },
        resolution: "google_prevails",
      },
    ]);
  });

  it("conflito de título: idem — Google vence, valor do CRM guardado", async () => {
    const { provider, store, deps, conn } = await comEventoCriado();
    provider.externalEdit(CALENDAR_ID, EVENT_ID, { summary: "Título do Google" });

    const result = await rescheduleAppointment(deps, conn, { ...activity(), title: "Título do CRM" });

    expect(result.status).toBe("conflict_resolved");
    expect(store.appliedToActivity).toEqual([{ activityId: ACTIVITY_ID, title: "Título do Google", dueAt: undefined }]);
    expect(store.conflicts).toMatchObject([{ field: "title", crmValue: "Título do CRM", googleValue: "Título do Google", resolution: "google_prevails" }]);
  });

  it("os dois mudaram para o MESMO valor: sem conflito", async () => {
    const { provider, store, deps, conn } = await comEventoCriado();
    provider.externalEdit(CALENDAR_ID, EVENT_ID, {
      start: { dateTime: "2026-11-12T16:00:00.000Z" },
      end: { dateTime: "2026-11-12T17:00:00.000Z" },
    });
    const result = await rescheduleAppointment(deps, conn, REMARCADO);
    expect(result.status).toBe("unchanged");
    expect(store.conflicts).toEqual([]);
    expect(countCalls(provider, "patch")).toBe(0);
  });

  it("evento cancelado no Google + edição no CRM: vínculo vira cancelled_in_google e a edição fica registrada", async () => {
    const { provider, store, deps, conn } = await comEventoCriado();
    provider.externalEdit(CALENDAR_ID, EVENT_ID, { status: "cancelled" });

    const result = await rescheduleAppointment(deps, conn, REMARCADO);

    expect(result).toEqual({ status: "cancelled_in_google" });
    expect(countCalls(provider, "patch")).toBe(0);
    expect(store.conflicts).toMatchObject([
      { field: "cancellation", resolution: "google_prevails", crmValue: { schedule: { start: "2026-11-12T16:00:00.000Z" } } },
    ]);
    expect([...store.links.values()][0]).toMatchObject({ status: "cancelled_in_google", baseCancelled: true });
    // Depois disso, novas tentativas não chamam o Google.
    const chamadas = provider.calls.length;
    expect(await rescheduleAppointment(deps, conn, REMARCADO)).toEqual({ status: "cancelled_in_google" });
    expect(provider.calls.length).toBe(chamadas);
  });

  it("412 em todas as tentativas: para, sinaliza atenção e registra", async () => {
    const { provider, store, deps, conn } = await comEventoCriado();
    for (let i = 0; i < 3; i++) {
      provider.onBefore("patch", () => provider.externalEdit(CALENDAR_ID, EVENT_ID, { attendees: [{ email: `x${i}@exemplo.test` }] }));
    }

    const result = await rescheduleAppointment(deps, conn, REMARCADO);

    expect(result).toEqual({ status: "needs_attention" });
    expect(countCalls(provider, "patch")).toBe(3);
    expect(store.conflicts).toMatchObject([{ resolution: "needs_attention" }]);
    expect(store.intents.at(-1)).toMatchObject({ status: "failed", errorCode: "precondition_failed_exhausted" });
  });

  describe("resultado incerto", () => {
    it("timeout DEPOIS de aplicar: relê, vê que reflete o pretendido e NÃO repete o PATCH", async () => {
      const { provider, deps, conn } = await comEventoCriado();
      provider.injectFault({ operation: "patch", kind: "timeout_after_apply" });

      const result = await rescheduleAppointment(deps, conn, REMARCADO);

      expect(result.status).toBe("updated");
      expect(countCalls(provider, "patch")).toBe(1);
      expect(provider.peek(CALENDAR_ID, EVENT_ID)?.start?.dateTime).toBe("2026-11-12T16:00:00.000Z");
    });

    it("timeout ANTES de aplicar: relê, vê o etag intacto e tenta UMA vez mais", async () => {
      const { provider, deps, conn } = await comEventoCriado();
      provider.injectFault({ operation: "patch", kind: "timeout_before_apply" });

      const result = await rescheduleAppointment(deps, conn, REMARCADO);

      expect(result.status).toBe("updated");
      expect(countCalls(provider, "patch")).toBe(2);
    });

    it("incerto também na releitura: fica incerto, sem terceira escrita", async () => {
      const { provider, store, deps, conn } = await comEventoCriado();
      provider.injectFault({ operation: "patch", kind: "timeout_before_apply" });
      provider.injectFault({ operation: "patch", kind: "timeout_before_apply" });

      const result = await rescheduleAppointment(deps, conn, REMARCADO);

      expect(result).toMatchObject({ status: "uncertain" });
      expect(countCalls(provider, "patch")).toBe(2);
      expect(store.intents.at(-1)).toMatchObject({ status: "uncertain" });
    });

    it("erro TEMPORÁRIO do Google (500) vira pendência gravada no vínculo", async () => {
      const { provider, store, deps, conn } = await comEventoCriado();
      provider.injectFault({ operation: "patch", kind: "status", status: 500 });
      expect(await rescheduleAppointment(deps, conn, REMARCADO)).toEqual({ status: "pending", code: "provider_500" });
      expect(store.intents.at(-1)).toMatchObject({ status: "failed", errorCode: "provider_500" });
      expect([...store.links.values()][0]).toMatchObject({ syncState: "pending", syncOperation: "update" });
    });

    it("recusa DEFINITIVA do Google (400) vira falha gravada no vínculo", async () => {
      const { provider, store, deps, conn } = await comEventoCriado();
      provider.injectFault({ operation: "patch", kind: "status", status: 400 });
      expect(await rescheduleAppointment(deps, conn, REMARCADO)).toEqual({ status: "failed", code: "provider_400" });
      expect([...store.links.values()][0]).toMatchObject({ syncState: "failed", syncError: "provider_400" });
    });
  });

  it("vínculo de OUTRO ambiente: recusa antes de qualquer chamada ao Google", async () => {
    const { provider, store, deps, conn } = await makeFixture("preview");
    store.seedLink({ activityId: ACTIVITY_ID, eventId: EVENT_ID, environment: "production" });
    await expect(rescheduleAppointment(deps, conn, REMARCADO)).rejects.toMatchObject({ code: "calendar_environment_mismatch" });
    expect(provider.calls).toEqual([]);
  });

  it("sem vínculo: recusa, sem chamar o Google", async () => {
    const { provider, deps, conn } = await makeFixture();
    await expect(rescheduleAppointment(deps, conn, REMARCADO)).rejects.toMatchObject({ code: "not_linked" });
    expect(provider.calls).toEqual([]);
  });
});

describe("Meet em compromisso existente", () => {
  it("adiciona o Meet pedido, com If-Match, e acompanha até success", async () => {
    const { provider, store, deps, conn } = await comEventoCriado();
    const result = await addMeetToAppointment(deps, conn, activity());

    expect(result).toMatchObject({ status: "updated", meet: { status: "success" } });
    expect(await store.getLink(ACTIVITY_ID)).toMatchObject({ baseHasMeet: true, meetStatus: "success" });
    expect(provider.peek(CALENDAR_ID, EVENT_ID)?.conferenceData?.entryPoints?.length).toBe(1);
  });

  it("o Google já tem conferência: adota, sem PATCH nem Meet duplicado", async () => {
    const { provider, deps, conn } = await comEventoCriado();
    provider.externalEdit(CALENDAR_ID, EVENT_ID, {
      conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.simulated/ja-existia" }] },
    });

    const result = await addMeetToAppointment(deps, conn, activity());

    expect(result).toMatchObject({ status: "unchanged", meet: { status: "success", url: "https://meet.simulated/ja-existia" } });
    expect(countCalls(provider, "patch")).toBe(0);
  });

  it("Meet removido no Google NÃO é recriado por um reagendamento", async () => {
    const { provider, deps, conn } = await comEventoCriado(true);
    provider.externalEdit(CALENDAR_ID, EVENT_ID, { conferenceData: undefined });

    await rescheduleAppointment(deps, conn, REMARCADO);

    expect(provider.peek(CALENDAR_ID, EVENT_ID)?.conferenceData).toBeUndefined();
  });
});

describe("cancelar", () => {
  it("evento como o CRM deixou: apagado com If-Match, vínculo desfeito, sem e-mail", async () => {
    const { provider, store, deps, conn } = await comEventoCriado();

    const result = await cancelAppointment(deps, conn, activity());

    expect(result).toEqual({ status: "cancelled" });
    expect(provider.peek(CALENDAR_ID, EVENT_ID)?.status).toBe("cancelled");
    expect(provider.eventCount(CALENDAR_ID)).toBe(0);
    expect(await store.getLink(ACTIVITY_ID)).toBeNull(); // unlinked
    expect([...store.links.values()][0]).toMatchObject({ status: "unlinked", baseCancelled: true });
    expect(provider.notificationsSent).toEqual([]);
  });

  it("evento editado no Google desde a base: NÃO apaga, mantém o evento E o vínculo, e registra", async () => {
    const { provider, store, deps, conn } = await comEventoCriado();
    provider.externalEdit(CALENDAR_ID, EVENT_ID, { summary: "Agora é outra coisa" });

    const result = await cancelAppointment(deps, conn, activity());

    expect(result).toEqual({ status: "kept_google_event" });
    expect(countCalls(provider, "delete")).toBe(0);
    expect(provider.peek(CALENDAR_ID, EVENT_ID)?.status).toBe("confirmed");
    expect(store.conflicts).toMatchObject([{ field: "cancellation", resolution: "kept_google_event", crmValue: { cancelled: true } }]);
    // Nada fica abandonado no Google: o vínculo continua, com a falha a resolver gravada.
    expect([...store.links.values()][0]).toMatchObject({ status: "linked", syncState: "failed", syncOperation: "delete" });
  });

  it("edição que chega ENTRE a leitura e o DELETE: 412, relê e mantém o evento", async () => {
    const { provider, store, deps, conn } = await comEventoCriado();
    provider.onBefore("delete", () => provider.externalEdit(CALENDAR_ID, EVENT_ID, { summary: "Editado na hora H" }));

    const result = await cancelAppointment(deps, conn, activity());

    expect(result).toEqual({ status: "kept_google_event" });
    expect(provider.peek(CALENDAR_ID, EVENT_ID)?.status).toBe("confirmed");
    expect(store.conflicts).toHaveLength(1);
  });

  it("já apagado no Google: sucesso sem nova escrita", async () => {
    const { provider, deps, conn } = await comEventoCriado();
    provider.externalEdit(CALENDAR_ID, EVENT_ID, { status: "cancelled" });
    expect(await cancelAppointment(deps, conn, activity())).toEqual({ status: "already_gone" });
    expect(countCalls(provider, "delete")).toBe(0);
  });

  describe("resultado incerto", () => {
    it("timeout DEPOIS de apagar: consulta, vê cancelado e NÃO repete o DELETE", async () => {
      const { provider, deps, conn } = await comEventoCriado();
      provider.injectFault({ operation: "delete", kind: "timeout_after_apply" });
      expect(await cancelAppointment(deps, conn, activity())).toEqual({ status: "cancelled" });
      expect(countCalls(provider, "delete")).toBe(1);
    });

    it("timeout ANTES de apagar: consulta, vê o etag intacto e tenta UMA vez mais", async () => {
      const { provider, deps, conn } = await comEventoCriado();
      provider.injectFault({ operation: "delete", kind: "timeout_before_apply" });
      expect(await cancelAppointment(deps, conn, activity())).toEqual({ status: "cancelled" });
      expect(countCalls(provider, "delete")).toBe(2);
    });

    it("incerto também ao reler: fica incerto, sem repetir às cegas", async () => {
      const { provider, store, deps, conn } = await comEventoCriado();
      provider.injectFault({ operation: "delete", kind: "timeout_before_apply" });
      // O primeiro get (antes do delete) passa; o segundo (reconciliação) falha.
      provider.onBefore("delete", () => provider.injectFault({ operation: "get", kind: "timeout_before_apply" }));

      const result = await cancelAppointment(deps, conn, activity());
      expect(["uncertain"]).toContain(result.status);
      expect(countCalls(provider, "delete")).toBeLessThanOrEqual(1);
      expect(store.intents.at(-1)!.status).toBe("uncertain");
    });
  });

  it("vínculo de OUTRO ambiente: recusa sem chamar o Google", async () => {
    const { provider, store, deps, conn } = await makeFixture("preview");
    store.seedLink({ activityId: ACTIVITY_ID, eventId: EVENT_ID, environment: "production" });
    await expect(cancelAppointment(deps, conn, activity())).rejects.toMatchObject({ code: "calendar_environment_mismatch" });
    expect(provider.calls).toEqual([]);
  });

  it("depois de cancelar, o compromisso pode ser criado de novo (id novo só por ação explícita)", async () => {
    const { deps, conn } = await comEventoCriado();
    await cancelAppointment(deps, conn, activity());
    // O id determinístico (geração 1) já foi usado por um evento cancelado: não é recriado em silêncio.
    expect(await createAppointment(deps, conn, activity())).toEqual({ status: "failed", code: "event_cancelled_exists" });
  });
});
