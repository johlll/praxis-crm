/**
 * @vitest-environment node
 *
 * B2 — só agendas da PRÓPRIA conta conectada (decisão da primeira versão):
 * a principal (`primary`) e as secundárias cujo `dataOwner` é o e-mail da
 * conta. `accessRole: "owner"` NÃO prova propriedade: o Google o dá também a
 * quem recebeu uma agenda de outra conta com "fazer alterações e gerenciar
 * compartilhamento" — e o escopo `calendar.events.owned` não a alcança.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createGoogleCalendarApi } from "@/server/calendar/google/calendar-api";
import { isOwnCalendar, type ProviderCalendar } from "@/server/calendar/provider";
import { SimulatedCalendarProvider } from "@/server/calendar/simulated-provider";

import { fakeGoogleHttp } from "../support/google-fake-http";

const { tokensMock, setCalendarMock, providerMock, connectionsMock, storeAccessMock } = vi.hoisted(() => ({
  tokensMock: vi.fn(),
  setCalendarMock: vi.fn(),
  providerMock: vi.fn(),
  connectionsMock: vi.fn(),
  storeAccessMock: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/authz/safe", () => ({ requirePermissionSafe: async () => CTX }));
vi.mock("@/server/calendar/provider", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCalendarProvider: () => providerMock(),
}));
vi.mock("@/server/calendar/admin/connections", () => ({
  adminConnectCalendar: vi.fn(),
  adminGetConnectionTokens: tokensMock,
  adminSetConnectionCalendar: setCalendarMock,
  adminDisconnectCalendar: vi.fn(),
  adminStoreAccessToken: storeAccessMock,
}));
vi.mock("@/server/calendar/admin/inbound-store", () => ({ adminListOwnChannels: vi.fn().mockResolvedValue([]) }));
vi.mock("@/modules/calendar/automation", () => ({
  recoverOwnCalendarLinks: vi.fn().mockResolvedValue(null),
  describeRecovery: () => undefined,
}));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: (...args: unknown[]) => connectionsMock(...args) }),
}));

import { selectCalendarAction } from "@/modules/calendar/actions";
import { listChoosableCalendars } from "@/modules/calendar/queries";

const CTX = {
  ctx: { userId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" },
};
const CONN = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "teste@exemplo.com";

/** Formato real da CalendarList do Google (campos pedidos em `fields`). */
const PRIMARY = { id: ACCOUNT, summary: ACCOUNT, accessRole: "owner", primary: true };
const OWN_SECONDARY = { id: "abc@group.calendar.google.com", summary: "Praxis — Testes B2.", accessRole: "owner", dataOwner: ACCOUNT };
const SHARED_WRITER = { id: "escritorio@group.calendar.google.com", summary: "Do escritório", accessRole: "writer", dataOwner: "outra@exemplo.com" };
/** Compartilhada com "gerenciar compartilhamento": accessRole owner, dono outro. */
const SHARED_OWNER_ROLE = { id: "socio@group.calendar.google.com", summary: "Do sócio", accessRole: "owner", dataOwner: "socio@exemplo.com" };

function googleWith(items: unknown[]) {
  const fake = fakeGoogleHttp(() => ({ status: 200, json: { items } }));
  return { api: createGoogleCalendarApi(fake.http), requests: fake.requests };
}

function form(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  tokensMock.mockResolvedValue({ accessToken: "tok", refreshToken: "r", accessTokenExpiresAt: new Date(Date.now() + 3600_000), keyVersion: "v1" });
  connectionsMock.mockResolvedValue({
    data: [{ id: CONN, userId: CTX.ctx.userId, isMine: true, googleAccountEmail: ACCOUNT, calendarId: null, calendarSummary: null, status: "active", createdAt: "" }],
    error: null,
  });
});

describe("reprodução (vermelha antes da correção)", () => {
  it("adaptador Google: agenda compartilhada com accessRole owner e dataOwner de OUTRA conta não pode sair como própria", async () => {
    const { api, requests } = googleWith([SHARED_OWNER_ROLE]);
    const [calendar] = await api.listCalendars("tok");
    // O adaptador precisa expor os campos que provam a propriedade.
    expect(calendar).toMatchObject({ id: SHARED_OWNER_ROLE.id, primary: false, dataOwner: "socio@exemplo.com" });
    expect(requests[0]!.url.searchParams.get("fields")).toContain("dataOwner");
    expect(requests[0]!.url.searchParams.get("fields")).toContain("primary");
  });

  it("selectCalendarAction recusa agenda de outra conta (forjada no formulário), sem alterar a conexão", async () => {
    providerMock.mockResolvedValue({
      listCalendars: vi.fn().mockResolvedValue([
        { id: OWN_SECONDARY.id, summary: OWN_SECONDARY.summary, primary: false, dataOwner: ACCOUNT },
        { id: SHARED_OWNER_ROLE.id, summary: SHARED_OWNER_ROLE.summary, primary: false, dataOwner: SHARED_OWNER_ROLE.dataOwner },
      ]),
    });
    const r = await selectCalendarAction({ ok: false }, form({ connectionId: CONN, calendarId: SHARED_OWNER_ROLE.id }));
    expect(r.ok).toBe(false);
    expect(setCalendarMock).not.toHaveBeenCalled();
  });

  it("a tela não oferece agenda de outra conta para seleção", async () => {
    providerMock.mockResolvedValue({
      listCalendars: vi.fn().mockResolvedValue([
        { id: OWN_SECONDARY.id, summary: OWN_SECONDARY.summary, primary: false, dataOwner: ACCOUNT },
        { id: SHARED_OWNER_ROLE.id, summary: SHARED_OWNER_ROLE.summary, primary: false, dataOwner: SHARED_OWNER_ROLE.dataOwner },
        { id: SHARED_WRITER.id, summary: SHARED_WRITER.summary, primary: false, dataOwner: SHARED_WRITER.dataOwner },
      ]),
    });
    const offered = await listChoosableCalendars({ connectionId: CONN, workspaceId: CTX.ctx.workspaceId, actorUserId: CTX.ctx.userId, accountEmail: ACCOUNT });
    expect(offered.map((c) => c.id)).toEqual([OWN_SECONDARY.id]);
  });
});


/** Mapeamento do adaptador real, como o servidor o recebe. */
async function viaGoogle(item: Record<string, unknown>): Promise<ProviderCalendar> {
  const [calendar] = await googleWith([item]).api.listCalendars("tok");
  return calendar!;
}

describe("isOwnCalendar com a resposta real do Google (fluxo OAuth real)", () => {
  it("agenda principal: própria", async () => {
    expect(isOwnCalendar(await viaGoogle(PRIMARY), ACCOUNT)).toBe(true);
  });

  it("secundária própria (dataOwner = conta): própria — caso de \"Praxis — Testes B2.\"", async () => {
    expect(isOwnCalendar(await viaGoogle(OWN_SECONDARY), ACCOUNT)).toBe(true);
  });

  it("compartilhada como writer: não própria", async () => {
    expect(isOwnCalendar(await viaGoogle(SHARED_WRITER), ACCOUNT)).toBe(false);
  });

  it("compartilhada com accessRole owner e dataOwner de outra conta: não própria", async () => {
    expect(isOwnCalendar(await viaGoogle(SHARED_OWNER_ROLE), ACCOUNT)).toBe(false);
  });

  it("resposta sem primary nem dataOwner: não própria, mesmo com accessRole owner", async () => {
    const calendar = await viaGoogle({ id: "sem-campos@group.calendar.google.com", summary: "?", accessRole: "owner" });
    expect(calendar).toMatchObject({ primary: false, dataOwner: null });
    expect(isOwnCalendar(calendar, ACCOUNT)).toBe(false);
  });

  it("o e-mail no id da agenda NÃO prova propriedade", async () => {
    const calendar = await viaGoogle({ id: ACCOUNT, summary: "Parece a principal", accessRole: "owner" });
    expect(isOwnCalendar(calendar, ACCOUNT)).toBe(false);
  });

  it("maiúsculas e espaços no e-mail: comparação normalizada nos dois lados", async () => {
    const calendar = await viaGoogle({ ...OWN_SECONDARY, dataOwner: " Teste@Exemplo.COM " });
    expect(isOwnCalendar(calendar, "TESTE@exemplo.com")).toBe(true);
  });

  it("e-mail da conta vazio: nenhuma secundária é própria", async () => {
    expect(isOwnCalendar(await viaGoogle(OWN_SECONDARY), "  ")).toBe(false);
  });
});

describe("provedor simulado", () => {
  it("principal, secundária própria, de outra conta e sem dataOwner", async () => {
    const p = new SimulatedCalendarProvider();
    const tokens = await p.exchangeAuthorization("Ana@Vizentini.test|principal,pessoal,socio=socio@vizentini.test,sem-dono=");
    const calendars = await p.listCalendars(tokens.accessToken);
    expect(calendars.map((c) => [c.summary, isOwnCalendar(c, tokens.accountEmail)])).toEqual([
      ["principal", true],
      ["pessoal", true],
      ["socio", false],
      ["sem-dono", false],
    ]);
  });
});

describe("seleção forjada direto na ação do servidor", () => {
  const listing = [
    { id: PRIMARY.id, summary: PRIMARY.summary, primary: true, dataOwner: null },
    { id: OWN_SECONDARY.id, summary: OWN_SECONDARY.summary, primary: false, dataOwner: ACCOUNT },
    { id: SHARED_WRITER.id, summary: SHARED_WRITER.summary, primary: false, dataOwner: SHARED_WRITER.dataOwner },
    { id: SHARED_OWNER_ROLE.id, summary: SHARED_OWNER_ROLE.summary, primary: false, dataOwner: SHARED_OWNER_ROLE.dataOwner },
    { id: "sem@group.calendar.google.com", summary: "Sem campos", primary: false, dataOwner: null },
  ];
  /** Provedor que registra QUALQUER chamada além da leitura da lista. */
  function recordingProvider() {
    const writes = { insert: vi.fn(), update: vi.fn(), delete: vi.fn(), watch: vi.fn(), stopChannel: vi.fn(), revoke: vi.fn() };
    return { provider: { listCalendars: vi.fn().mockResolvedValue(listing), ...writes }, writes };
  }

  it.each([
    ["writer", SHARED_WRITER.id],
    ["accessRole owner de outra conta", SHARED_OWNER_ROLE.id],
    ["sem os campos de propriedade", "sem@group.calendar.google.com"],
  ])("agenda %s: recusada, conexão intacta, nenhuma escrita no Google", async (_label, calendarId) => {
    const { provider, writes } = recordingProvider();
    providerMock.mockResolvedValue(provider);
    const r = await selectCalendarAction({ ok: false }, form({ connectionId: CONN, calendarId }));
    expect(r).toEqual({ ok: false, error: expect.stringContaining("dona") });
    expect(setCalendarMock).not.toHaveBeenCalled();
    for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["principal", PRIMARY.id, PRIMARY.summary],
    ["secundária própria", OWN_SECONDARY.id, OWN_SECONDARY.summary],
  ])("agenda %s: aceita", async (_label, calendarId, summary) => {
    providerMock.mockResolvedValue(recordingProvider().provider);
    expect((await selectCalendarAction({ ok: false }, form({ connectionId: CONN, calendarId }))).ok).toBe(true);
    expect(setCalendarMock).toHaveBeenCalledWith({ connectionId: CONN, actorUserId: CTX.ctx.userId, calendarId, calendarSummary: summary });
  });

  it("e-mail da conexão com outra caixa: a secundária própria continua aceita", async () => {
    connectionsMock.mockResolvedValue({
      data: [{ id: CONN, userId: CTX.ctx.userId, isMine: true, googleAccountEmail: "TESTE@Exemplo.com", calendarId: null, calendarSummary: null, status: "active", createdAt: "" }],
      error: null,
    });
    providerMock.mockResolvedValue(recordingProvider().provider);
    expect((await selectCalendarAction({ ok: false }, form({ connectionId: CONN, calendarId: OWN_SECONDARY.id }))).ok).toBe(true);
  });

  it("conexão que não é do usuário: recusada antes de listar ou gravar", async () => {
    connectionsMock.mockResolvedValue({ data: [], error: null });
    const { provider } = recordingProvider();
    providerMock.mockResolvedValue(provider);
    const r = await selectCalendarAction({ ok: false }, form({ connectionId: CONN, calendarId: OWN_SECONDARY.id }));
    expect(r.ok).toBe(false);
    expect(provider.listCalendars).not.toHaveBeenCalled();
    expect(setCalendarMock).not.toHaveBeenCalled();
  });
});
