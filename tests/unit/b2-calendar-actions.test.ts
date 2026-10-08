/**
 * @vitest-environment node
 *
 * B2, fundação — ações de conexão: permissão, provedor ausente, agenda
 * conferida contra o provedor, nenhum dado de identidade vindo do cliente.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { connectMock, tokensMock, setCalendarMock, disconnectMock, providerMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  tokensMock: vi.fn(),
  setCalendarMock: vi.fn(),
  disconnectMock: vi.fn(),
  providerMock: vi.fn(),
}));
let permission: { ctx: { userId: string; workspaceId: string } } | { error: string };

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/authz/safe", () => ({ requirePermissionSafe: async () => permission }));
vi.mock("@/server/calendar/provider", () => ({ getCalendarProvider: () => providerMock() }));
vi.mock("@/server/calendar/admin/connections", () => ({
  adminConnectCalendar: connectMock,
  adminGetConnectionTokens: tokensMock,
  adminSetConnectionCalendar: setCalendarMock,
  adminDisconnectCalendar: disconnectMock,
}));

import { connectCalendarAction, disconnectCalendarAction, selectCalendarAction } from "@/modules/calendar/actions";

const CTX = {
  ctx: { userId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" },
};
const CONN = "33333333-3333-4333-8333-333333333333";

function form(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  permission = CTX;
});

describe("connectCalendarAction", () => {
  it("sem permissão: recusa e não toca em nada", async () => {
    permission = { error: "Você não tem permissão para fazer isso." };
    const r = await connectCalendarAction({ ok: false }, form({ authorization: "a@b.co" }));
    expect(r.ok).toBe(false);
    expect(providerMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("sem provedor configurado: recusa com mensagem clara, sem gravar", async () => {
    providerMock.mockResolvedValue(null);
    const r = await connectCalendarAction({ ok: false }, form({ authorization: "a@b.co" }));
    expect(r).toEqual({ ok: false, error: expect.stringContaining("não está configurada") });
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("conecta usando o usuário e o workspace da SESSÃO, nunca do formulário", async () => {
    const tokens = {
      accessToken: "a",
      refreshToken: "r",
      accessTokenExpiresAt: new Date(),
      scopes: ["s"],
      accountEmail: "a@b.co",
    };
    providerMock.mockResolvedValue({ exchangeAuthorization: vi.fn().mockResolvedValue(tokens) });
    connectMock.mockResolvedValue("id");
    const r = await connectCalendarAction(
      { ok: false },
      form({ authorization: "a@b.co", workspaceId: "ataque", userId: "ataque" }),
    );
    expect(r.ok).toBe(true);
    expect(connectMock).toHaveBeenCalledWith({
      workspaceId: CTX.ctx.workspaceId,
      actorUserId: CTX.ctx.userId,
      tokens,
    });
  });
});

describe("selectCalendarAction", () => {
  it("só aceita agenda que o provedor devolve para o token da conexão", async () => {
    tokensMock.mockResolvedValue({ accessToken: "tok", refreshToken: "r" });
    providerMock.mockResolvedValue({
      listCalendars: vi.fn().mockResolvedValue([{ id: "ok@cal", summary: "Principal", owned: true }]),
    });

    const recusada = await selectCalendarAction({ ok: false }, form({ connectionId: CONN, calendarId: "outra@cal" }));
    expect(recusada.ok).toBe(false);
    expect(setCalendarMock).not.toHaveBeenCalled();

    const aceita = await selectCalendarAction({ ok: false }, form({ connectionId: CONN, calendarId: "ok@cal" }));
    expect(aceita.ok).toBe(true);
    expect(setCalendarMock).toHaveBeenCalledWith({
      connectionId: CONN,
      actorUserId: CTX.ctx.userId,
      calendarId: "ok@cal",
      calendarSummary: "Principal",
    });
  });

  it("conexão de outro ambiente: o erro do banco vira mensagem amigável", async () => {
    tokensMock.mockRejectedValue(new Error("calendar_environment_mismatch"));
    providerMock.mockResolvedValue({ listCalendars: vi.fn() });
    const r = await selectCalendarAction({ ok: false }, form({ connectionId: CONN, calendarId: "x" }));
    expect(r).toEqual({ ok: false, error: expect.stringContaining("outro ambiente") });
    expect(setCalendarMock).not.toHaveBeenCalled();
  });
});

describe("disconnectCalendarAction", () => {
  it("revoga no provedor (melhor esforço) e desconecta; falha da revogação não impede", async () => {
    const revoke = vi.fn().mockRejectedValue(new Error("rede"));
    providerMock.mockResolvedValue({ revoke });
    tokensMock.mockResolvedValue({ accessToken: "a", refreshToken: "r" });
    const r = await disconnectCalendarAction({ ok: false }, form({ connectionId: CONN }));
    expect(r.ok).toBe(true);
    expect(revoke).toHaveBeenCalledWith("r");
    expect(disconnectMock).toHaveBeenCalledWith({ connectionId: CONN, actorUserId: CTX.ctx.userId });
  });

  it("conexão de outro usuário: não lê token alheio, só desconecta localmente", async () => {
    providerMock.mockResolvedValue({ revoke: vi.fn() });
    tokensMock.mockRejectedValue(new Error("connection_not_found"));
    const r = await disconnectCalendarAction({ ok: false }, form({ connectionId: CONN }));
    expect(r.ok).toBe(true);
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });

  it("recusa do banco (ambiente diferente) não é engolida", async () => {
    providerMock.mockResolvedValue(null);
    disconnectMock.mockRejectedValue(new Error("calendar_environment_mismatch"));
    const r = await disconnectCalendarAction({ ok: false }, form({ connectionId: CONN }));
    expect(r.ok).toBe(false);
  });
});
