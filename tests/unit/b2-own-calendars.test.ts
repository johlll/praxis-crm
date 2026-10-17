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
vi.mock("@/server/calendar/provider", () => ({ getCalendarProvider: () => providerMock() }));
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

describe("reprodução — propriedade inferida só pelo accessRole", () => {
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
        { id: OWN_SECONDARY.id, summary: OWN_SECONDARY.summary, owned: true, primary: false, dataOwner: ACCOUNT },
        { id: SHARED_OWNER_ROLE.id, summary: SHARED_OWNER_ROLE.summary, owned: true, primary: false, dataOwner: SHARED_OWNER_ROLE.dataOwner },
      ]),
    });
    const r = await selectCalendarAction({ ok: false }, form({ connectionId: CONN, calendarId: SHARED_OWNER_ROLE.id }));
    expect(r.ok).toBe(false);
    expect(setCalendarMock).not.toHaveBeenCalled();
  });

  it("a tela não oferece agenda de outra conta para seleção", async () => {
    providerMock.mockResolvedValue({
      listCalendars: vi.fn().mockResolvedValue([
        { id: OWN_SECONDARY.id, summary: OWN_SECONDARY.summary, owned: true, primary: false, dataOwner: ACCOUNT },
        { id: SHARED_OWNER_ROLE.id, summary: SHARED_OWNER_ROLE.summary, owned: true, primary: false, dataOwner: SHARED_OWNER_ROLE.dataOwner },
        { id: SHARED_WRITER.id, summary: SHARED_WRITER.summary, owned: false, primary: false, dataOwner: SHARED_WRITER.dataOwner },
      ]),
    });
    const offered = await listChoosableCalendars({ connectionId: CONN, workspaceId: CTX.ctx.workspaceId, actorUserId: CTX.ctx.userId, accountEmail: ACCOUNT } as never);
    expect(offered.map((c) => c.id)).toEqual([OWN_SECONDARY.id]);
  });
});

