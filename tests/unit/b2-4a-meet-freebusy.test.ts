/**
 * @vitest-environment node
 *
 * B2, etapa 4a (revisão) — adaptador REAL do Google contra respostas HTTP no
 * formato OFICIAL da Calendar API v3 (nenhuma chamada de rede):
 *  - Meet: o Google devolve `createRequest.status.statusCode` (objeto), e não
 *    a string do contrato interno; `entryPoints` pode trazer telefone antes do
 *    vídeo; a escrita leva só `requestId` e `conferenceSolutionKey`;
 *  - disponibilidade: resposta malformada, agenda ausente ou erro por agenda
 *    nunca vira "livre"; `busy: []` com a agenda presente continua livre.
 * Exercita também o orquestrador real (`createAppointment`). Dados fictícios.
 */
import { describe, expect, it } from "vitest";

import { createGoogleCalendarApi } from "@/server/calendar/google/calendar-api";
import { createAppointment } from "@/server/calendar/sync/appointments";
import type { SyncDeps } from "@/server/calendar/sync/types";

import { CALENDAR_ID, activity, makeFixture } from "../support/calendar-fixture";
import { fakeGoogleHttp, type FakeReply, type RecordedRequest } from "../support/google-fake-http";

const TOKEN = "token-de-acesso-ficticio";
const MEET_URI = "https://meet.google.com/abc-defg-hij";
const PHONE = { entryPointType: "phone", uri: "tel:+55-11-0000-0000", label: "+55 11 0000-0000", pin: "123456" };
const VIDEO = { entryPointType: "video", uri: MEET_URI, label: "meet.google.com/abc-defg-hij" };
const MORE = { entryPointType: "more", uri: "https://tel.meet/abc-defg-hij?pin=123456" };

const baseEvent = {
  id: "evt0001",
  etag: '"1"',
  status: "confirmed",
  summary: "Reunião fictícia",
  start: { dateTime: "2026-11-10T14:00:00Z" },
  end: { dateTime: "2026-11-10T15:00:00Z" },
  updated: "2026-11-01T12:00:00.000Z",
};

/** `conferenceData` exatamente como o Google devolve. */
function conference(statusCode: "pending" | "success" | "failure", entryPoints?: unknown[]) {
  return {
    createRequest: { requestId: "req-1", conferenceSolutionKey: { type: "hangoutsMeet" }, status: { statusCode } },
    ...(entryPoints ? { entryPoints, conferenceId: "abc-defg-hij", conferenceSolution: { key: { type: "hangoutsMeet" }, name: "Google Meet" } } : {}),
  };
}

const api = (handler: (req: RecordedRequest) => FakeReply) => {
  const fake = fakeGoogleHttp(handler);
  return { api: createGoogleCalendarApi(fake.http), requests: fake.requests };
};
const rejected = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe("Meet: tradução do formato real do Google", () => {
  it("pending: status lido de statusCode", async () => {
    const { api: g } = api(() => ({ status: 200, json: { ...baseEvent, conferenceData: conference("pending") } }));
    const event = await g.getEvent(TOKEN, CALENDAR_ID, "evt0001");
    expect(event?.conferenceData).toEqual({ createRequest: { requestId: "req-1", status: "pending" } });
  });

  it("success: só o entryPoint de vídeo, mesmo com telefone antes", async () => {
    const { api: g } = api(() => ({ status: 200, json: { ...baseEvent, conferenceData: conference("success", [PHONE, MORE, VIDEO]) } }));
    const event = await g.getEvent(TOKEN, CALENDAR_ID, "evt0001");
    expect(event?.conferenceData).toEqual({
      createRequest: { requestId: "req-1", status: "success" },
      entryPoints: [{ entryPointType: "video", uri: MEET_URI }],
    });
  });

  it("failure: status falho, sem endereço", async () => {
    const { api: g } = api(() => ({ status: 200, json: { ...baseEvent, conferenceData: conference("failure") } }));
    const event = await g.getEvent(TOKEN, CALENDAR_ID, "evt0001");
    expect(event?.conferenceData).toEqual({ createRequest: { requestId: "req-1", status: "failure" } });
  });

  it("só telefone (sem vídeo): nenhum endereço de Meet é inventado", async () => {
    const { api: g } = api(() => ({ status: 200, json: { ...baseEvent, conferenceData: conference("success", [PHONE]) } }));
    const event = await g.getEvent(TOKEN, CALENDAR_ID, "evt0001");
    expect(event?.conferenceData?.entryPoints).toBeUndefined();
  });

  it("escrita: createRequest com requestId e conferenceSolutionKey, sem status (somente leitura)", async () => {
    const { api: g, requests } = api(() => ({ status: 200, json: { ...baseEvent, conferenceData: conference("pending") } }));
    await g.insertEvent(
      TOKEN,
      CALENDAR_ID,
      { id: "evt0001", conferenceData: { createRequest: { requestId: "req-1", status: "pending" } } },
      { conferenceDataVersion: 1, sendUpdates: "none" },
    );
    await g.patchEvent(
      TOKEN,
      CALENDAR_ID,
      "evt0001",
      { conferenceData: { createRequest: { requestId: "req-2", status: "pending" } } },
      { ifMatch: '"1"', conferenceDataVersion: 1, sendUpdates: "none" },
    );
    expect(JSON.parse(requests[0]!.body!).conferenceData).toEqual({
      createRequest: { requestId: "req-1", conferenceSolutionKey: { type: "hangoutsMeet" } },
    });
    expect(JSON.parse(requests[1]!.body!).conferenceData).toEqual({
      createRequest: { requestId: "req-2", conferenceSolutionKey: { type: "hangoutsMeet" } },
    });
  });
});

describe("Meet com o orquestrador real", () => {
  /** Google mínimo: a inclusão volta pendente; as consultas seguintes seguem `sequence`. */
  function googleMeet(sequence: Array<"pending" | "success" | "failure">) {
    let gets = 0;
    let created: Record<string, unknown> = {};
    return fakeGoogleHttp((req) => {
      if (req.method === "POST") {
        created = { ...baseEvent, ...JSON.parse(req.body!), etag: '"1"' };
        return { status: 200, json: { ...created, conferenceData: conference("pending") } };
      }
      if (req.method === "GET") {
        const code = sequence[Math.min(gets++, sequence.length - 1)]!;
        return {
          status: 200,
          json: { ...created, etag: `"${gets + 1}"`, conferenceData: conference(code, code === "success" ? [PHONE, VIDEO] : undefined) },
        };
      }
      return { status: 404, json: {} };
    });
  }

  async function create(http: ReturnType<typeof googleMeet>["http"]) {
    const f = await makeFixture();
    const deps: SyncDeps = { ...f.deps, api: createGoogleCalendarApi(http) };
    const result = await createAppointment(deps, f.conn, activity({ dueAt: "2026-11-10T14:00:00.000Z" }), { withMeet: true });
    return { f, result };
  }

  it("reconhece o pedido pendente, acompanha e grava o endereço do vídeo (não o telefone)", async () => {
    const google = googleMeet(["pending", "success"]);
    const { f, result } = await create(google.http);
    expect(result).toMatchObject({ status: "created", meet: { status: "success", url: MEET_URI } });
    expect(google.requests.map((r) => r.method)).toEqual(["POST", "GET", "GET"]);
    expect([...f.store.links.values()][0]).toMatchObject({ meetStatus: "success", meetUrl: MEET_URI });
  });

  it("pedido que continua pendente fica PENDENTE (não some)", async () => {
    const google = googleMeet(["pending"]);
    const { f, result } = await create(google.http);
    expect(result).toMatchObject({ status: "created", meet: { status: "pending", url: null } });
    expect([...f.store.links.values()][0]).toMatchObject({ meetStatus: "pending" });
  });

  it("pedido recusado pelo Google fica FALHO", async () => {
    const google = googleMeet(["failure"]);
    const { result } = await create(google.http);
    expect(result).toMatchObject({ status: "created", meet: { status: "failed", url: null } });
  });
});

describe("disponibilidade desconhecida não é livre", () => {
  const from = "2026-11-10T14:00:00.000Z";
  const to = "2026-11-10T15:00:00.000Z";

  it("agenda presente com busy: [] = livre (caso legítimo)", async () => {
    const { api: g } = api(() => ({ status: 200, json: { kind: "calendar#freeBusy", calendars: { [CALENDAR_ID]: { busy: [] } } } }));
    expect(await g.freeBusy(TOKEN, [CALENDAR_ID], from, to)).toEqual([]);
  });

  const unknown: Array<[string, unknown]> = [
    ["corpo vazio", null],
    ["sem calendars", { kind: "calendar#freeBusy" }],
    ["calendars não é objeto", { calendars: [] }],
    ["agenda ausente", { calendars: { "outra@exemplo.test": { busy: [] } } }],
    ["agenda sem busy", { calendars: { [CALENDAR_ID]: {} } }],
    ["busy não é lista", { calendars: { [CALENDAR_ID]: { busy: "x" } } }],
    ["intervalo com data inválida", { calendars: { [CALENDAR_ID]: { busy: [{ start: "nada", end: "x" }] } } }],
    ["erro por agenda sem motivo", { calendars: { [CALENDAR_ID]: { busy: [], errors: [{ domain: "global" }] } } }],
    ["erro por agenda com motivo", { calendars: { [CALENDAR_ID]: { busy: [], errors: [{ domain: "global", reason: "backendError" }] } } }],
  ];
  for (const [name, json] of unknown) {
    it(`${name}: erro, nunca lista vazia`, async () => {
      const { api: g } = api(() => (json === null ? { status: 200, text: "" } : { status: 200, json }));
      expect(await rejected(g.freeBusy(TOKEN, [CALENDAR_ID], from, to))).toMatchObject({ status: expect.any(Number) });
    });
  }

  it("com requireFree, disponibilidade não confirmada: ZERO chamadas de criação de evento", async () => {
    for (const [, json] of unknown) {
      const google = fakeGoogleHttp((req) => {
        if (req.url.pathname.endsWith("/freeBusy")) return json === null ? { status: 200, text: "" } : { status: 200, json };
        return { status: 200, json: baseEvent };
      });
      const f = await makeFixture();
      const deps: SyncDeps = { ...f.deps, api: createGoogleCalendarApi(google.http) };
      const outcome = await createAppointment(deps, f.conn, activity({ dueAt: from }), { requireFree: true }).then(
        (r) => r,
        (e: unknown) => e,
      );
      expect(outcome).not.toMatchObject({ status: "created" });
      expect(google.requests.filter((r) => r.url.pathname.endsWith("/events"))).toHaveLength(0);
      expect(f.store.links.size).toBe(0);
    }
  });
});
