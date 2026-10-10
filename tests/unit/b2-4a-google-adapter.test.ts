/**
 * @vitest-environment node
 *
 * B2, etapa 4a — adaptador REAL do Google contra respostas HTTP SIMULADAS
 * (nenhuma chamada de rede): formato das requisições, campos mínimos,
 * If-Match, paginação, canais, disponibilidade, renovação e revogação, e a
 * classificação de erros pelo código e pelo MOTIVO do Google (limite de
 * chamadas não é perda de acesso). Dados fictícios.
 */
import { describe, expect, it } from "vitest";

import { ProviderHttpError, ProviderUncertainError } from "@/server/calendar/events-api";
import { createGoogleCalendarApi } from "@/server/calendar/google/calendar-api";
import type { GoogleCalendarConfig } from "@/server/calendar/google/config";
import { classifyGoogleError } from "@/server/calendar/google/http";
import { refreshAccessToken, revokeToken } from "@/server/calendar/google/oauth";
import { rescheduleAppointment } from "@/server/calendar/sync/appointments";
import type { SyncDeps } from "@/server/calendar/sync/types";

import { ACTIVITY_ID, CALENDAR_ID, activity, makeFixture } from "../support/calendar-fixture";
import { fakeGoogleHttp, googleError, type FakeReply, type RecordedRequest } from "../support/google-fake-http";

const TOKEN = "token-de-acesso-ficticio";
const CONFIG: GoogleCalendarConfig = {
  clientId: "cliente-teste.apps.googleusercontent.com",
  clientSecret: "segredo-ficticio",
  redirectUri: "https://crm.exemplo.test/api/calendar/oauth/callback",
  origin: "https://crm.exemplo.test",
};
const EVENT = {
  id: "evt0001",
  etag: '"1"',
  status: "confirmed",
  summary: "Reunião fictícia",
  start: { dateTime: "2026-11-10T11:00:00-03:00", timeZone: "America/Sao_Paulo" },
  end: { dateTime: "2026-11-10T12:00:00-03:00" },
  extendedProperties: { private: { crmAppointment: ACTIVITY_ID, crmEnv: "preview" } },
  updated: "2026-11-01T12:00:00.000Z",
};

const api = (handler: (req: RecordedRequest) => FakeReply | Promise<FakeReply>) => {
  const fake = fakeGoogleHttp(handler);
  return { api: createGoogleCalendarApi(fake.http), requests: fake.requests };
};
const rejected = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe("eventos: requisições e respostas", () => {
  it("lê um evento com os campos mínimos, o token no cabeçalho e o horário em UTC", async () => {
    const { api: g, requests } = api(() => ({ status: 200, json: EVENT }));
    const event = await g.getEvent(TOKEN, CALENDAR_ID, "evt0001");

    const req = requests[0]!;
    expect(req.method).toBe("GET");
    expect(req.url.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/evt0001`);
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.url.searchParams.get("fields")).not.toMatch(/attendees|description|location/);
    expect(event).toMatchObject({ id: "evt0001", etag: '"1"', start: { dateTime: "2026-11-10T14:00:00.000Z" } });
  });

  it("evento inexistente (404) ou apagado (410): null, como no contrato", async () => {
    expect(await api(() => ({ status: 404, json: googleError(404, "notFound") })).api.getEvent(TOKEN, CALENDAR_ID, "x")).toBeNull();
    expect(await api(() => ({ status: 410, json: googleError(410, "deleted") })).api.getEvent(TOKEN, CALENDAR_ID, "x")).toBeNull();
  });

  it("inclusão: id do cliente, Meet, sem convites por padrão; id repetido = 409", async () => {
    const { api: g, requests } = api(() => ({ status: 200, json: EVENT }));
    await g.insertEvent(
      TOKEN,
      CALENDAR_ID,
      { id: "evt0001", summary: "Reunião fictícia", start: { dateTime: "2026-11-10T14:00:00.000Z" }, end: { dateTime: "2026-11-10T15:00:00.000Z" } },
      { conferenceDataVersion: 1, sendUpdates: "none" },
    );
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(req.url.searchParams.get("sendUpdates")).toBe("none");
    expect(JSON.parse(req.body!)).toEqual({
      id: "evt0001",
      summary: "Reunião fictícia",
      start: { dateTime: "2026-11-10T14:00:00.000Z" },
      end: { dateTime: "2026-11-10T15:00:00.000Z" },
    });

    const conflict = await rejected(
      api(() => ({ status: 409, json: googleError(409, "duplicate") })).api.insertEvent(TOKEN, CALENDAR_ID, { id: "evt0001" }, { sendUpdates: "none" }),
    );
    expect(conflict).toMatchObject({ status: 409 });
  });

  it("alteração e exclusão levam If-Match; mudou no Google = 412; apagado = 404", async () => {
    const { api: g, requests } = api(() => ({ status: 200, json: EVENT }));
    await g.patchEvent(TOKEN, CALENDAR_ID, "evt0001", { summary: "Novo" }, { ifMatch: '"1"', sendUpdates: "none" });
    expect(requests[0]).toMatchObject({ method: "PATCH", headers: expect.objectContaining({ "if-match": '"1"' }) });
    expect(JSON.parse(requests[0]!.body!)).toEqual({ summary: "Novo" });

    const changed = await rejected(
      api(() => ({ status: 412, json: googleError(412, "conditionNotMet") })).api.patchEvent(TOKEN, CALENDAR_ID, "e", {}, { ifMatch: '"0"', sendUpdates: "none" }),
    );
    expect(changed).toMatchObject({ status: 412 });

    const del = api(() => ({ status: 410, json: googleError(410, "deleted") }));
    expect(await rejected(del.api.deleteEvent(TOKEN, CALENDAR_ID, "e", { ifMatch: '"1"', sendUpdates: "none" }))).toMatchObject({ status: 404 });
    expect(del.requests[0]).toMatchObject({ method: "DELETE", headers: expect.objectContaining({ "if-match": '"1"' }) });
  });
});

describe("classificação de erros pelo código e pelo motivo", () => {
  it.each([
    [403, "rateLimitExceeded", 429],
    [403, "userRateLimitExceeded", 429],
    [403, "quotaExceeded", 429],
    [403, "dailyLimitExceeded", 429],
    [429, "rateLimitExceeded", 429],
    [403, "accessNotConfigured", 503],
    [403, "forbidden", 403],
    [403, "insufficientPermissions", 403],
    [401, "authError", 401],
    [500, "backendError", 500],
  ])("%i %s → %i", (status, reason, expected) => {
    const error = classifyGoogleError(status, googleError(status, reason));
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: expected, reason });
    expect(error.message).not.toMatch(/mensagem do Google/);
  });

  it("prazo esgotado ou rede caída: resultado INCERTO (pode ter sido aplicado)", async () => {
    expect(await rejected(api(() => "timeout").api.patchEvent(TOKEN, CALENDAR_ID, "e", {}, { ifMatch: '"1"', sendUpdates: "none" }))).toBeInstanceOf(
      ProviderUncertainError,
    );
    expect(await rejected(api(() => "network").api.insertEvent(TOKEN, CALENDAR_ID, {}, { sendUpdates: "none" }))).toBeInstanceOf(ProviderUncertainError);
  });
});

describe("listagem, canais, disponibilidade e agendas", () => {
  it("listagem: campos mínimos (sem título) e os MESMOS parâmetros em todas as páginas", async () => {
    const { api: g, requests } = api((req) =>
      req.url.searchParams.get("pageToken")
        ? { status: 200, json: { items: [], nextSyncToken: "sync-2" } }
        : { status: 200, json: { items: [{ ...EVENT }], nextPageToken: "p2" } },
    );
    const query = { syncToken: "sync-1", showDeleted: true as const, singleEvents: false as const, maxResults: 250 };
    const first = await g.listEvents(TOKEN, CALENDAR_ID, query);
    const second = await g.listEvents(TOKEN, CALENDAR_ID, { ...query, pageToken: first.nextPageToken });

    expect(first.items[0]).not.toHaveProperty("summary");
    expect(requests[0]!.url.searchParams.get("fields")).not.toMatch(/summary|attendees|description/);
    const params = (r: RecordedRequest) => {
      const p = new URLSearchParams(r.url.searchParams);
      p.delete("pageToken");
      return p.toString();
    };
    expect(params(requests[1]!)).toBe(params(requests[0]!));
    expect(requests[1]!.url.searchParams.get("pageToken")).toBe("p2");
    expect(second.nextSyncToken).toBe("sync-2");
  });

  it("listagem com token vencido: 410 continua 410 (refazer a listagem completa)", async () => {
    const error = await rejected(
      api(() => ({ status: 410, json: googleError(410, "fullSyncRequired") })).api.listEvents(TOKEN, CALENDAR_ID, {
        syncToken: "velho",
        showDeleted: true,
        singleEvents: false,
        maxResults: 250,
      }),
    );
    expect(error).toMatchObject({ status: 410 });
  });

  it("canal: web_hook com segredo; vencimento EFETIVO devolvido; encerramento", async () => {
    const { api: g, requests } = api((req) =>
      req.url.pathname.endsWith("/watch")
        ? { status: 200, json: { resourceId: "res-1", expiration: String(Date.parse("2026-11-08T12:00:00.000Z")) } }
        : { status: 204 },
    );
    const channel = await g.watchEvents(TOKEN, CALENDAR_ID, { id: "canal-1", token: "segredo-do-canal", address: "https://crm.exemplo.test/api/calendar/webhook" });
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      id: "canal-1",
      type: "web_hook",
      address: "https://crm.exemplo.test/api/calendar/webhook",
      token: "segredo-do-canal",
    });
    expect(channel).toEqual({ resourceId: "res-1", expiration: "2026-11-08T12:00:00.000Z" });

    await g.stopChannel(TOKEN, { id: "canal-1", resourceId: "res-1" });
    expect(requests[1]).toMatchObject({ method: "POST", body: JSON.stringify({ id: "canal-1", resourceId: "res-1" }) });
  });

  it("disponibilidade: só intervalos; agenda com erro nunca vira \"livre\"", async () => {
    const ok = api(() => ({ status: 200, json: { calendars: { [CALENDAR_ID]: { busy: [{ start: "2026-11-10T11:00:00-03:00", end: "2026-11-10T12:00:00-03:00" }] } } } }));
    expect(await ok.api.freeBusy(TOKEN, [CALENDAR_ID], "a", "b")).toEqual([{ start: "2026-11-10T14:00:00.000Z", end: "2026-11-10T15:00:00.000Z" }]);
    const failed = api(() => ({ status: 200, json: { calendars: { [CALENDAR_ID]: { errors: [{ reason: "backendError" }] } } } }));
    expect(await rejected(failed.api.freeBusy(TOKEN, [CALENDAR_ID], "a", "b"))).toMatchObject({ status: 503 });
  });

  it("agenda acessível: 200 sim; 404/403 não; limite de chamadas ou 401 = não se sabe (sobe)", async () => {
    expect(await api(() => ({ status: 200, json: { id: CALENDAR_ID } })).api.calendarAccessible(TOKEN, CALENDAR_ID)).toBe(true);
    expect(await api(() => ({ status: 404, json: googleError(404, "notFound") })).api.calendarAccessible(TOKEN, CALENDAR_ID)).toBe(false);
    expect(await api(() => ({ status: 403, json: googleError(403, "forbidden") })).api.calendarAccessible(TOKEN, CALENDAR_ID)).toBe(false);
    expect(
      await rejected(api(() => ({ status: 403, json: googleError(403, "rateLimitExceeded") })).api.calendarAccessible(TOKEN, CALENDAR_ID)),
    ).toMatchObject({ status: 429 });
  });

  it("lista de agendas: todas as páginas; dono marcado", async () => {
    const { api: g, requests } = api((req) =>
      req.url.searchParams.get("pageToken")
        ? { status: 200, json: { items: [{ id: "compartilhada@x", summary: "Do escritório", accessRole: "reader" }] } }
        : { status: 200, json: { items: [{ id: CALENDAR_ID, summary: "Principal", accessRole: "owner" }], nextPageToken: "p2" } },
    );
    expect(await g.listCalendars(TOKEN)).toEqual([
      { id: CALENDAR_ID, summary: "Principal", owned: true },
      { id: "compartilhada@x", summary: "Do escritório", owned: false },
    ]);
    expect(requests).toHaveLength(2);
  });
});

describe("renovação e revogação", () => {
  it("renova pelo formulário (segredo no corpo, nunca na URL)", async () => {
    const { http, requests } = fakeGoogleHttp(() => ({ status: 200, json: { access_token: "novo", expires_in: 3599 } }));
    const now = new Date("2026-11-01T12:00:00.000Z");
    expect(await refreshAccessToken(http, CONFIG, "refresh-ficticio", now)).toEqual({
      accessToken: "novo",
      accessTokenExpiresAt: new Date(now.getTime() + 3599_000),
    });
    expect(requests[0]!.url.search).toBe("");
    expect(Object.fromEntries(new URLSearchParams(requests[0]!.body!))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-ficticio",
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
    });
  });

  it("invalid_grant = a reautorizar (código que a manutenção reconhece); outras falhas não", async () => {
    const revoked = fakeGoogleHttp(() => ({ status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }));
    await expect(refreshAccessToken(revoked.http, CONFIG, "r", new Date())).rejects.toThrow("refresh_token_invalid");
    const down = fakeGoogleHttp(() => ({ status: 503, json: { error: "temporarily_unavailable" } }));
    await expect(refreshAccessToken(down.http, CONFIG, "r", new Date())).rejects.toThrow(/^refresh_failed:/);
  });

  it("revogação pelo formulário; token já inválido (400) não é erro", async () => {
    const ok = fakeGoogleHttp(() => ({ status: 200, json: {} }));
    await revokeToken(ok.http, "refresh-ficticio");
    expect(ok.requests[0]).toMatchObject({ method: "POST", body: "token=refresh-ficticio" });
    await expect(revokeToken(fakeGoogleHttp(() => ({ status: 400, json: { error: "invalid_token" } })).http, "x")).resolves.toBeUndefined();
  });
});

describe("com o orquestrador real (CRM → Google)", () => {
  /** Um "Google" mínimo: um evento, If-Match de verdade, etag que muda a cada escrita. */
  function googleWithOneEvent(onPatch?: (attempt: number) => "timeout_before" | "timeout_after" | FakeReply | null) {
    const event = { ...EVENT, start: { dateTime: "2026-11-10T14:00:00.000Z" }, end: { dateTime: "2026-11-10T15:00:00.000Z" } };
    let version = 1;
    let patches = 0;
    return fakeGoogleHttp((req) => {
      if (req.method === "GET") return { status: 200, json: event };
      if (req.method === "PATCH") {
        patches += 1;
        const forced = onPatch?.(patches) ?? null;
        if (forced === "timeout_before") return "timeout";
        if (forced && forced !== "timeout_after") return forced;
        if (req.headers["if-match"] !== event.etag) return { status: 412, json: googleError(412, "conditionNotMet") };
        Object.assign(event, JSON.parse(req.body!));
        version += 1;
        event.etag = `"${version}"`;
        return forced === "timeout_after" ? "timeout" : { status: 200, json: event };
      }
      return { status: 404, json: googleError(404, "notFound") };
    });
  }

  async function linked(http: ReturnType<typeof googleWithOneEvent>["http"]) {
    const f = await makeFixture();
    f.store.setActivity(activity({ dueAt: "2026-11-10T16:00:00.000Z" }));
    f.store.seedLink({
      activityId: ACTIVITY_ID,
      eventId: "evt0001",
      baseEtag: '"1"',
      baseTitle: "Reunião fictícia",
      baseStart: "2026-11-10T14:00:00.000Z",
      baseEnd: "2026-11-10T15:00:00.000Z",
    });
    const deps: SyncDeps = { ...f.deps, api: createGoogleCalendarApi(http) };
    return { f, deps };
  }

  const methods = (requests: RecordedRequest[]) => requests.map((r) => r.method);

  it("limite de chamadas (403 rateLimitExceeded) na escrita: PENDENTE, nunca \"acesso perdido\"", async () => {
    const google = googleWithOneEvent(() => ({ status: 403, json: googleError(403, "rateLimitExceeded") }));
    const { f, deps } = await linked(google.http);
    const result = await rescheduleAppointment(deps, f.conn, { ...f.store.activities.get(ACTIVITY_ID)! });
    expect(result).toEqual({ status: "pending", code: "provider_429" });
    expect([...f.store.links.values()][0]).toMatchObject({ status: "linked", syncState: "pending" });
  });

  it("403 de permissão de verdade na escrita: acesso perdido (para comparar)", async () => {
    const google = googleWithOneEvent(() => ({ status: 403, json: googleError(403, "forbidden") }));
    const { f, deps } = await linked(google.http);
    expect(await rescheduleAppointment(deps, f.conn, { ...f.store.activities.get(ACTIVITY_ID)! })).toEqual({ status: "access_lost" });
  });

  it("escrita com resultado incerto que NÃO chegou: consulta antes e repete uma vez", async () => {
    const google = googleWithOneEvent((n) => (n === 1 ? "timeout_before" : null));
    const { f, deps } = await linked(google.http);
    const result = await rescheduleAppointment(deps, f.conn, { ...f.store.activities.get(ACTIVITY_ID)! });
    expect(result.status).toBe("updated");
    expect(methods(google.requests)).toEqual(["GET", "PATCH", "GET", "PATCH"]);
  });

  it("escrita com resultado incerto que CHEGOU: a consulta mostra aplicada e não repete", async () => {
    const google = googleWithOneEvent((n) => (n === 1 ? "timeout_after" : null));
    const { f, deps } = await linked(google.http);
    const result = await rescheduleAppointment(deps, f.conn, { ...f.store.activities.get(ACTIVITY_ID)! });
    expect(result.status).toBe("updated");
    expect(methods(google.requests)).toEqual(["GET", "PATCH", "GET"]);
  });

  it("falha temporária do Google (503) na escrita: pendente, para tentar de novo", async () => {
    const google = googleWithOneEvent(() => ({ status: 503, json: googleError(503, "backendError") }));
    const { f, deps } = await linked(google.http);
    expect(await rescheduleAppointment(deps, f.conn, { ...f.store.activities.get(ACTIVITY_ID)! })).toEqual({ status: "pending", code: "provider_503" });
  });
});
