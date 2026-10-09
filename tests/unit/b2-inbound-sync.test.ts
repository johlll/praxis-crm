/**
 * @vitest-environment node
 *
 * B2, etapa 3 — sincronização Google → CRM (docs/decisoes/b2-google-agenda.md
 * §6.2–6.4, §10 itens 6–11, 14). Orquestrador REAL, provedor SIMULADO e dados
 * fictícios; persistência em memória com a mesma semântica das RPCs (o
 * banco real é coberto pelo pgTAP `24_b2_google_to_crm_sync`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAppointment, rescheduleAppointment } from "@/server/calendar/sync/appointments";
import { syncCalendar } from "@/server/calendar/sync/inbound";
import type { InboundConnection, InboundDeps } from "@/server/calendar/sync/inbound-types";

import { ACTIVITY_ID, CALENDAR_ID, activity, countCalls, makeFixture } from "../support/calendar-fixture";
import { InboundMemoryStore } from "../support/calendar-inbound-store";

let f: Awaited<ReturnType<typeof makeFixture>>;
let clock: { t: number };
let inbound: InboundMemoryStore;
let deps: InboundDeps;
let conn: InboundConnection;
let eventId: string;

const linkOf = () => [...f.store.links.values()].find((l) => l.activityId === ACTIVITY_ID)!;
const crm = () => f.store.activities.get(ACTIVITY_ID)!;
const stateOf = () => inbound.states.get(`conn-1|${CALENDAR_ID}`);
const getsOf = (id: string) => f.provider.calls.filter((c) => c.operation === "get" && c.eventId === id).length;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(async () => {
  f = await makeFixture();
  clock = { t: Date.parse("2026-11-01T12:00:00.000Z") };
  const now = () => new Date(clock.t);
  f.provider.now = () => clock.t;
  inbound = new InboundMemoryStore(f.store, now);
  deps = { api: f.provider, store: inbound, environment: "preview", now };
  conn = { connectionId: "conn-1", userId: "user-1", calendarId: CALENDAR_ID, environment: "preview", accessToken: f.conn.accessToken };

  f.store.setActivity(activity());
  const created = await createAppointment(f.deps, f.conn, activity());
  if (created.status !== "created") throw new Error("setup");
  eventId = created.eventId;

  // Primeira sincronização: listagem completa, só para ter o token.
  expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", full: true, applied: 0 });
  f.provider.calls.length = 0;
  inbound.applyCalls.length = 0;
});

describe("só eventos vinculados", () => {
  it("evento externo criado e alterado: nada é buscado, aplicado, gravado ou logado", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ext = f.provider.addExternalEvent(CALENDAR_ID, "2026-11-10T10:00:00.000Z", "2026-11-10T11:00:00.000Z", "Consulta médica (pessoal)");
    f.provider.externalEdit(CALENDAR_ID, ext, { summary: "Exame (pessoal)" });

    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", applied: 0 });

    expect(getsOf(ext)).toBe(0); // nem o detalhe é lido
    expect(inbound.applyCalls).toEqual([]);
    const persisted = JSON.stringify({ links: [...f.store.links.values()], audit: inbound.audit, states: [...inbound.states.values()], conflicts: f.store.conflicts });
    expect(persisted).not.toMatch(/médica|Exame|pessoal/);
    expect(persisted).not.toContain(ext);
    const logged = JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]);
    expect(logged).not.toMatch(/médica|Exame|pessoal/);
    expect(logged).not.toContain(ext);
  });

  it("a listagem nunca traz título (fields mínimo)", async () => {
    const page = await f.provider.listEvents(f.conn.accessToken, CALENDAR_ID, {});
    for (const item of page.items) expect(item).not.toHaveProperty("summary");
  });
});

describe("regra por campo contra a base", () => {
  it("título alterado só no Google: aplicado no CRM, base avança, sem conflito", async () => {
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Reunião remarcada pelo cliente" });

    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", applied: 1, conflicts: 0 });

    expect(crm().title).toBe("Reunião remarcada pelo cliente");
    expect(crm().lockVersion).toBe(4);
    expect(linkOf()).toMatchObject({ baseTitle: "Reunião remarcada pelo cliente", baseEtag: f.provider.peek(CALENDAR_ID, eventId)!.etag });
    expect(f.store.conflicts).toEqual([]);
    expect(inbound.audit.find((a) => a.action === "calendar.inbound.applied")?.metadata).toEqual({ changed: ["title"], linkStatus: "linked" });
  });

  it("horário movido no Google: início aplicado e duração REAL guardada, mesmo fora de 15–480", async () => {
    f.provider.externalEdit(CALENDAR_ID, eventId, {
      start: { dateTime: "2026-11-11T09:00:00.000Z" },
      end: { dateTime: "2026-11-11T19:00:00.000Z" }, // 600 min
    });

    await syncCalendar(deps, conn);

    expect(crm().dueAt).toBe("2026-11-11T09:00:00.000Z");
    expect(linkOf()).toMatchObject({ durationMinutes: 600, baseStart: "2026-11-11T09:00:00.000Z", baseEnd: "2026-11-11T19:00:00.000Z" });
  });

  it("só a duração mudou no Google: o CRM (que só tem o início) não muda", async () => {
    f.provider.externalEdit(CALENDAR_ID, eventId, { end: { dateTime: "2026-11-10T16:00:00.000Z" } });
    await syncCalendar(deps, conn);
    expect(crm()).toMatchObject({ dueAt: "2026-11-10T14:00:00.000Z", lockVersion: 3 });
    expect(linkOf().durationMinutes).toBe(120);
  });

  it("conflito (os dois mudaram o título): o Google prevalece e o valor do CRM fica GRAVADO", async () => {
    crm().title = "Título editado no CRM";
    crm().lockVersion = 4;
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Título editado no Google" });

    expect(await syncCalendar(deps, conn)).toMatchObject({ applied: 1, conflicts: 1 });

    expect(crm().title).toBe("Título editado no Google");
    expect(f.store.conflicts).toEqual([
      { linkId: linkOf().id, field: "title", crmValue: "Título editado no CRM", googleValue: "Título editado no Google", resolution: "google_prevails" },
    ]);
  });

  it("conflito de horário: Google prevalece, o horário do CRM (início e fim) fica gravado", async () => {
    crm().dueAt = "2026-11-12T13:00:00.000Z";
    crm().lockVersion = 4;
    f.provider.externalEdit(CALENDAR_ID, eventId, { start: { dateTime: "2026-11-13T09:00:00.000Z" }, end: { dateTime: "2026-11-13T10:00:00.000Z" } });

    await syncCalendar(deps, conn);

    expect(crm().dueAt).toBe("2026-11-13T09:00:00.000Z");
    expect(f.store.conflicts[0]).toMatchObject({
      field: "schedule",
      crmValue: { start: "2026-11-12T13:00:00.000Z", end: "2026-11-12T14:00:00.000Z" },
      googleValue: { start: "2026-11-13T09:00:00.000Z", end: "2026-11-13T10:00:00.000Z" },
    });
  });

  it("mudou só no CRM (ainda não enviado): o CRM NÃO é sobrescrito e a base desse campo não avança", async () => {
    crm().title = "Título novo do CRM, pendente";
    crm().lockVersion = 4;
    f.provider.externalEdit(CALENDAR_ID, eventId, { attendees: [{ email: "x@exemplo.test" }] }); // outra coisa mudou no Google

    await syncCalendar(deps, conn);

    expect(crm().title).toBe("Título novo do CRM, pendente");
    expect(linkOf().baseTitle).toBe("Reunião com cliente fictício");
    expect(f.store.conflicts).toEqual([]);
  });

  it("cancelado no Google: vínculo 'cancelado no Google', a atividade continua; edição do CRM vira conflito", async () => {
    crm().title = "Editado no CRM antes do cancelamento";
    crm().lockVersion = 4;
    f.provider.externalEdit(CALENDAR_ID, eventId, { status: "cancelled" });

    await syncCalendar(deps, conn);

    expect(linkOf()).toMatchObject({ status: "cancelled_in_google", baseCancelled: true });
    expect(f.store.activities.has(ACTIVITY_ID)).toBe(true);
    expect(crm().title).toBe("Editado no CRM antes do cancelamento");
    expect(f.store.conflicts).toEqual([
      expect.objectContaining({ field: "cancellation", googleValue: { cancelled: true } }),
    ]);
    expect(getsOf(eventId)).toBe(0); // o cancelamento vem na própria listagem
  });

  it("Meet adicionado e depois removido no Google: o vínculo acompanha, nada é recriado", async () => {
    f.provider.externalEdit(CALENDAR_ID, eventId, {
      conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.simulated/externo" }] },
    });
    await syncCalendar(deps, conn);
    expect(linkOf()).toMatchObject({ baseHasMeet: true, meetStatus: "success", meetUrl: "https://meet.simulated/externo" });

    f.provider.externalEdit(CALENDAR_ID, eventId, { conferenceData: undefined });
    await syncCalendar(deps, conn);
    expect(linkOf()).toMatchObject({ baseHasMeet: false, meetStatus: null, meetUrl: null });
    expect(countCalls(f.provider, "patch")).toBe(0);
  });

  it("série (evento recorrente): vínculo para atenção, CRM intocado", async () => {
    f.provider.makeRecurring(CALENDAR_ID, eventId);
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Virou série" });
    await syncCalendar(deps, conn);
    expect(linkOf().status).toBe("needs_attention");
    expect(crm().title).toBe("Reunião com cliente fictício");
  });

  it("marca de OUTRO compromisso/ambiente no evento vinculado: atenção, nada aplicado", async () => {
    f.provider.externalEdit(CALENDAR_ID, eventId, {
      summary: "Trocado",
      extendedProperties: { private: { crmAppointment: "outra-atividade", crmEnv: "production" } },
    });
    await syncCalendar(deps, conn);
    expect(linkOf().status).toBe("needs_attention");
    expect(crm().title).toBe("Reunião com cliente fictício");
  });
});

describe("sem laço: o eco das escritas do CRM", () => {
  it("reagendar pelo CRM e depois sincronizar: nada é aplicado nem relido", async () => {
    crm().dueAt = "2026-11-12T16:00:00.000Z";
    await rescheduleAppointment(f.deps, f.conn, { ...crm() });
    f.provider.calls.length = 0;

    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", applied: 0 });
    expect(getsOf(eventId)).toBe(0);
    expect(inbound.applyCalls).toEqual([]);
  });

  it("Google muda o título, CRM muda só o horário, a saída termina e depois roda a entrada: o título chega e o horário fica", async () => {
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Título novo do Google" });
    crm().dueAt = "2026-11-12T16:00:00.000Z";
    crm().lockVersion = 4;

    expect(await rescheduleAppointment(f.deps, f.conn, { ...crm() })).toMatchObject({ status: "updated" });
    const google = f.provider.peek(CALENDAR_ID, eventId)!;
    expect(google).toMatchObject({ summary: "Título novo do Google", start: { dateTime: "2026-11-12T16:00:00.000Z" } });
    expect(crm().title).toBe("Reunião com cliente fictício"); // a saída não trouxe o título

    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", applied: 1, conflicts: 0 });

    expect(crm()).toMatchObject({ title: "Título novo do Google", dueAt: "2026-11-12T16:00:00.000Z" });
    expect(f.store.conflicts).toEqual([]);
    expect(linkOf()).toMatchObject({
      baseTitle: "Título novo do Google",
      baseStart: "2026-11-12T16:00:00.000Z",
      baseEnd: "2026-11-12T17:00:00.000Z",
      baseEtag: google.etag,
    });
    expect(countCalls(f.provider, "patch")).toBe(1); // nada volta ao Google
    // A seguinte é eco puro.
    inbound.applyCalls.length = 0;
    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", applied: 0 });
    expect(inbound.applyCalls).toEqual([]);
  });

  it("etag igual ao da base, mas horário listado diferente: o etag sozinho não basta, o detalhe é lido", async () => {
    linkOf().baseStart = "2026-11-09T08:00:00.000Z"; // base parcial (gravada por versão anterior)
    f.provider.calls.length = 0;

    expect(await syncCalendar(deps, conn, { forceFull: true })).toMatchObject({ status: "synced", applied: 1, conflicts: 0 });

    expect(getsOf(eventId)).toBe(1);
    expect(linkOf().baseStart).toBe("2026-11-10T14:00:00.000Z");
    expect(crm().dueAt).toBe("2026-11-10T14:00:00.000Z");
  });

  it("sincronizar de novo sem mudanças: nenhuma aplicação", async () => {
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Uma vez" });
    await syncCalendar(deps, conn);
    inbound.applyCalls.length = 0;
    await syncCalendar(deps, conn);
    expect(inbound.applyCalls).toEqual([]);
  });
});

describe("paginação e syncToken", () => {
  it("o token só avança depois da ÚLTIMA página; falha no meio mantém o anterior e a execução é refeita", async () => {
    f.provider.listPageSize = 2;
    const tokenAntes = stateOf()!.syncToken;
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Mudou no Google" }); // 1ª página
    for (let i = 0; i < 3; i++) f.provider.addExternalEvent(CALENDAR_ID, "2026-11-20T10:00:00.000Z", "2026-11-20T11:00:00.000Z");
    // A 2ª chamada de listagem (2ª página) falha.
    f.provider.onBefore("list", () => f.provider.onBefore("list", () => f.provider.injectFault({ operation: "list", kind: "status", status: 503 })));

    expect(await syncCalendar(deps, conn)).toEqual({ status: "failed", code: "provider_503" });
    expect(stateOf()!.syncToken).toBe(tokenAntes);
    expect(crm().title).toBe("Mudou no Google"); // a 1ª página foi aplicada...

    // ...e refazer é idempotente: nada é reaplicado, nenhum conflito duplicado.
    inbound.applyCalls.length = 0;
    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", pages: 2, applied: 0 });
    expect(stateOf()!.syncToken).not.toBe(tokenAntes);
    expect(f.store.conflicts).toEqual([]);
  });

  it("410: descarta o token, refaz a listagem completa e NÃO apaga nada do CRM", async () => {
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Depois do 410" });
    f.provider.invalidateSyncTokens(CALENDAR_ID);

    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", full: true, applied: 1 });

    expect(inbound.audit.map((a) => a.action)).toContain("calendar.sync.token_reset");
    expect(crm().title).toBe("Depois do 410");
    expect(f.store.activities.size).toBe(1);
    expect(linkOf().status).toBe("linked");
    // O token novo funciona.
    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", full: false });
  });

  it("toda página repete o syncToken e os demais parâmetros da consulta inicial; só o pageToken muda", async () => {
    f.provider.listPageSize = 2;
    for (let i = 0; i < 4; i++) f.provider.addExternalEvent(CALENDAR_ID, "2026-11-20T10:00:00.000Z", "2026-11-20T11:00:00.000Z");
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Na última página" });
    const token = stateOf()!.syncToken;
    f.provider.listQueries.length = 0;

    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", full: false, pages: 3, applied: 1 });

    const [first, ...rest] = f.provider.listQueries;
    expect(first).toMatchObject({ syncToken: token });
    expect(first).not.toHaveProperty("pageToken");
    expect(rest).toHaveLength(2);
    for (const query of rest) {
      const { pageToken, ...same } = query;
      expect(pageToken).toEqual(expect.any(String));
      expect(same).toEqual(first);
    }
    expect(crm().title).toBe("Na última página");
  });

  it("o simulador recusa a página pedida com consulta diferente da que abriu a listagem", async () => {
    f.provider.listPageSize = 1;
    f.provider.addExternalEvent(CALENDAR_ID, "2026-11-20T10:00:00.000Z", "2026-11-20T11:00:00.000Z");
    f.provider.addExternalEvent(CALENDAR_ID, "2026-11-21T10:00:00.000Z", "2026-11-21T11:00:00.000Z");
    const query = { syncToken: stateOf()!.syncToken!, showDeleted: true, singleEvents: false, maxResults: 250 } as const;
    const list = (opts: Parameters<typeof f.provider.listEvents>[2]) => f.provider.listEvents(f.conn.accessToken, CALENDAR_ID, opts);

    const sem = await list(query);
    await expect(list({ pageToken: sem.nextPageToken })).rejects.toMatchObject({ status: 400 }); // sem o syncToken
    const outra = await list(query);
    await expect(list({ ...query, maxResults: 10, pageToken: outra.nextPageToken })).rejects.toMatchObject({ status: 400 });
    const certa = await list(query);
    await expect(list({ ...query, pageToken: certa.nextPageToken })).resolves.toMatchObject({ items: [expect.anything()] });
  });

  it("410 numa página POSTERIOR: descarta o token, refaz a completa e não apaga nem duplica nada do CRM", async () => {
    f.provider.listPageSize = 2;
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Aplicado na 1ª página" });
    for (let i = 0; i < 3; i++) f.provider.addExternalEvent(CALENDAR_ID, "2026-11-20T10:00:00.000Z", "2026-11-20T11:00:00.000Z");
    // O Google invalida os tokens entre a 1ª e a 2ª página.
    f.provider.onBefore("list", () => f.provider.onBefore("list", () => f.provider.invalidateSyncTokens(CALENDAR_ID)));
    f.provider.listQueries.length = 0;

    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", full: true, applied: 1, conflicts: 0 });

    expect(inbound.audit.map((a) => a.action)).toContain("calendar.sync.token_reset");
    expect(f.provider.listQueries.filter((q) => q.syncToken === undefined && q.pageToken === undefined)).toHaveLength(1); // uma completa
    expect(crm().title).toBe("Aplicado na 1ª página");
    expect(f.store.activities.size).toBe(1);
    expect(linkOf().status).toBe("linked");
    expect(f.store.conflicts).toEqual([]);
    expect(inbound.applyCalls.filter((c) => c.status === "applied")).toHaveLength(1);
    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", full: false, applied: 0 });
  });

  it("falha na listagem completa depois do 410: o token inválido não volta a ser usado", async () => {
    f.provider.invalidateSyncTokens(CALENDAR_ID);
    f.provider.onBefore("list", () => f.provider.onBefore("list", () => f.provider.injectFault({ operation: "list", kind: "status", status: 500 })));

    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "failed" });
    expect(stateOf()!.syncToken).toBeNull();
    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", full: true });
  });
});

describe("reconciliação e perda de acesso", () => {
  it("vínculo ausente na listagem completa: confirmado com get e marcado 'ausente', atividade intacta", async () => {
    f.provider.removeEventPermanently(CALENDAR_ID, eventId);

    expect(await syncCalendar(deps, conn, { forceFull: true })).toMatchObject({ status: "synced", full: true });

    expect(getsOf(eventId)).toBe(1);
    expect(linkOf().status).toBe("missing_in_google");
    expect(f.store.activities.has(ACTIVITY_ID)).toBe(true);
  });

  it.each([403, 404] as const)("acesso perdido (%s): pendência explícita, token mantido — nunca 'apagado'", async (status) => {
    const tokenAntes = stateOf()!.syncToken;
    f.provider.revokeCalendarAccess(CALENDAR_ID, status);

    expect(await syncCalendar(deps, conn, { forceFull: true })).toEqual({ status: "access_lost" });

    expect(linkOf()).toMatchObject({ status: "needs_attention", syncState: "pending", syncError: "calendar_access_lost" });
    expect(stateOf()!.syncToken).toBe(tokenAntes);
    expect(f.store.activities.has(ACTIVITY_ID)).toBe(true);

    // Acesso de volta: a próxima sincronização prova o acesso e devolve o vínculo.
    f.provider.restoreCalendarAccess(CALENDAR_ID);
    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced" });
    expect(linkOf().status).toBe("linked");
  });
});

describe("concorrência", () => {
  it("o CRM muda entre a leitura e a aplicação: nada é sobrescrito; relê e reavalia (vira conflito registrado)", async () => {
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Do Google" });
    inbound.onceBeforeApply(() => {
      crm().title = "Do CRM, no meio";
      crm().lockVersion += 1;
    });

    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", applied: 1, conflicts: 1 });

    expect(inbound.applyCalls.map((c) => c.status)).toEqual(["stale_activity", "applied"]);
    expect(crm().title).toBe("Do Google");
    expect(f.store.conflicts[0]).toMatchObject({ field: "title", crmValue: "Do CRM, no meio" });
  });

  it("uma sincronização por vez: com a trava tomada, a outra não roda", async () => {
    await inbound.claimSync("user-1", "conn-1", CALENDAR_ID);
    expect(await syncCalendar(deps, conn)).toEqual({ status: "busy" });
    expect(countCalls(f.provider, "list")).toBe(0);
  });

  it("execuções intercaladas: A perde a trava antes de aplicar, B assume; A não altera atividade, vínculo, conflitos nem token", async () => {
    crm().title = "Editado no CRM";
    crm().lockVersion = 4;
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Editado no Google" });
    const tokenAntes = stateOf()!.syncToken;
    const linkAntes = structuredClone(linkOf());

    // B: outra execução, que pega a trava e fica parada antes de listar.
    const bHoldsLease = deferred();
    const releaseB = deferred();
    const apiB = new Proxy(f.provider, {
      get(target, prop) {
        if (prop === "listEvents") {
          return async (...args: Parameters<typeof target.listEvents>) => {
            bHoldsLease.resolve();
            await releaseB.promise;
            return target.listEvents(...args);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let runB: Promise<unknown> | undefined;
    inbound.onceBeforeApply(async () => {
      clock.t += 200_000; // a trava de A (120 s) venceu
      runB = syncCalendar({ ...deps, api: apiB }, conn);
      await bHoldsLease.promise;
    });

    const runA = await syncCalendar(deps, conn);

    expect(runA).toEqual({ status: "failed", code: "lease_lost" });
    expect(crm()).toMatchObject({ title: "Editado no CRM", lockVersion: 4 });
    expect(linkOf()).toEqual(linkAntes);
    expect(f.store.conflicts).toEqual([]);
    expect(stateOf()!.syncToken).toBe(tokenAntes);

    // B continua e aplica uma única vez, com o conflito gravado uma vez.
    releaseB.resolve();
    expect(await runB).toMatchObject({ status: "synced", applied: 1, conflicts: 1 });
    expect(crm().title).toBe("Editado no Google");
    expect(f.store.conflicts).toEqual([expect.objectContaining({ field: "title", crmValue: "Editado no CRM" })]);
    expect(stateOf()!.syncToken).not.toBe(tokenAntes);
  });

  it("410 depois de perder a trava: A não descarta o token, não relista e não aplica", async () => {
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Não deve chegar por A" });
    f.provider.invalidateSyncTokens(CALENDAR_ID);
    const tokenAntes = stateOf()!.syncToken;
    f.provider.onBefore("list", () => {
      clock.t += 200_000;
      void inbound.claimSync("user-1", "conn-1", CALENDAR_ID); // B assume
    });

    expect(await syncCalendar(deps, conn)).toEqual({ status: "failed", code: "lease_lost" });

    expect(countCalls(f.provider, "list")).toBe(1);
    expect(stateOf()!.syncToken).toBe(tokenAntes);
    expect(crm().title).toBe("Reunião com cliente fictício");
    expect(inbound.applyCalls).toEqual([]);
  });

  it("trava vencida e tomada por outra execução: a primeira NÃO grava o token", async () => {
    f.provider.onBefore("list", () => {
      clock.t += 200_000; // a trava (120 s) venceu
      void inbound.claimSync("user-1", "conn-1", CALENDAR_ID); // outra execução a tomou
    });
    const tokenAntes = stateOf()!.syncToken;

    expect(await syncCalendar(deps, conn)).toEqual({ status: "failed", code: "lease_lost" });
    expect(stateOf()!.syncToken).toBe(tokenAntes);
  });
});

describe("autorização e isolamento", () => {
  it("o dono da conexão perdeu o alcance à atividade: nada aplicado, vínculo para atenção", async () => {
    inbound.noAccess.add(ACTIVITY_ID);
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Não deve chegar" });

    expect(await syncCalendar(deps, conn)).toMatchObject({ status: "synced", notAuthorized: 1, applied: 0 });

    expect(crm().title).toBe("Reunião com cliente fictício");
    expect(linkOf()).toMatchObject({ status: "needs_attention", syncError: "owner_lost_access" });
  });

  it("conexão de outro ambiente: recusada antes de qualquer chamada", async () => {
    await expect(syncCalendar(deps, { ...conn, environment: "production" })).rejects.toMatchObject({ code: "calendar_environment_mismatch" });
    expect(f.provider.calls).toEqual([]);
    expect(inbound.applyCalls).toEqual([]);
  });

  it("vínculo de OUTRO ambiente na mesma agenda não é processado", async () => {
    const outro = f.provider.addExternalEvent(CALENDAR_ID, "2026-11-15T10:00:00.000Z", "2026-11-15T11:00:00.000Z");
    f.store.seedLink({ activityId: "a1b2c3d4-0000-4000-8000-00000000a0ff", eventId: outro, environment: "production" });
    f.provider.externalEdit(CALENDAR_ID, outro, { summary: "Mudou em production" });

    await syncCalendar(deps, conn);

    expect(getsOf(outro)).toBe(0);
    expect(inbound.applyCalls).toEqual([]);
  });

  it("só o dono da conexão sincroniza (outro usuário é recusado pelo store)", async () => {
    await expect(syncCalendar(deps, { ...conn, userId: "user-2" })).rejects.toThrow("connection_not_found");
    expect(countCalls(f.provider, "list")).toBe(0);
  });
});
