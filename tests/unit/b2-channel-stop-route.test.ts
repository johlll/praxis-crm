/**
 * @vitest-environment node
 *
 * B2 — encerramento controlado de UM canal (`/api/cron/calendar/stop-channel`,
 * §9.5). Rota real; banco (consulta do canal, encerramento local), renovação
 * de token e provedor simulados. Nenhum serviço externo. Dados fictícios.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderHttpError, ProviderUncertainError } from "@/server/calendar/events-api";
import type { ChannelForStop } from "@/server/calendar/sync/channel-stop";

const SECRET = "segredo-do-cron-b2-0123";
const CHANNEL_ID = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const ACCESS_TOKEN = "ya29.token-de-acesso-ficticio";

const m = vi.hoisted(() => ({
  provider: { value: null as unknown },
  channels: new Map<string, ChannelForStop | Error>(),
  lookup: vi.fn(),
  loadFreshTokens: vi.fn(),
  stopRemote: vi.fn(),
  stopLocal: vi.fn(),
  storeCreated: vi.fn(),
}));

vi.mock("@/server/calendar/provider", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCalendarProvider: async () => m.provider.value,
}));
vi.mock("@/server/calendar/admin/inbound-store", () => ({
  adminGetChannelForStop: async (channelId: string) => {
    m.lookup(channelId);
    const found = m.channels.get(channelId);
    if (!found) throw new Error("channel_not_found");
    if (found instanceof Error) throw found;
    return { ...found };
  },
  createSupabaseInboundStore: () => {
    m.storeCreated();
    return { stopChannel: (userId: string, channelId: string, reason: string) => m.stopLocal(userId, channelId, reason) };
  },
}));
vi.mock("@/server/calendar/connection-context", () => ({
  loadFreshTokens: (params: unknown) => m.loadFreshTokens(params),
}));

import { POST } from "@/app/api/cron/calendar/stop-channel/route";

const channel = (over: Partial<ChannelForStop> = {}): ChannelForStop => ({
  channelId: CHANNEL_ID,
  status: "active",
  resourceId: "recurso-gravado",
  calendarId: "agenda@exemplo.test",
  connectionId: "c0000000-0000-4000-8000-000000000001",
  connectionStatus: "active",
  userId: "u0000000-0000-4000-8000-000000000001",
  workspaceId: "w0000000-0000-4000-8000-000000000001",
  ...over,
});

const req = (body: unknown, auth: string | null = `Bearer ${SECRET}`, query = "") =>
  new Request(`https://crm.exemplo.test/api/cron/calendar/stop-channel${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const noEffects = () => {
  expect(m.lookup).not.toHaveBeenCalled();
  expect(m.loadFreshTokens).not.toHaveBeenCalled();
  expect(m.stopRemote).not.toHaveBeenCalled();
  expect(m.stopLocal).not.toHaveBeenCalled();
};

let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("CRON_SECRET", SECRET);
  m.provider.value = { kind: "google", stopChannel: (token: string, ch: unknown) => m.stopRemote(token, ch) };
  m.channels.clear();
  m.channels.set(CHANNEL_ID, channel());
  for (const fn of [m.lookup, m.loadFreshTokens, m.stopRemote, m.stopLocal, m.storeCreated]) fn.mockReset();
  m.loadFreshTokens.mockResolvedValue({ accessToken: ACCESS_TOKEN, refreshToken: "1//refresh-ficticio" });
  m.stopRemote.mockResolvedValue(undefined);
  m.stopLocal.mockResolvedValue(undefined);
  logs = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "log").mockImplementation(() => {})];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("proteção: zero efeitos", () => {
  it.each([["production"], [""], ["development"]])("VERCEL_ENV=%s: 404 antes de qualquer consulta", async (env) => {
    vi.stubEnv("VERCEL_ENV", env);
    const res = await POST(req({ channelId: CHANNEL_ID }));
    expect(res.status).toBe(404);
    expect(m.storeCreated).not.toHaveBeenCalled();
    noEffects();
  });

  it("VERCEL_ENV ausente: 404", async () => {
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    expect((await POST(req({ channelId: CHANNEL_ID }))).status).toBe(404);
    noEffects();
  });

  it.each([
    ["sem Authorization", null],
    ["segredo errado", "Bearer segredo-errado-0123456789"],
    ["Bearer vazio", "Bearer "],
  ])("%s: 401", async (_label, auth) => {
    const res = await POST(req({ channelId: CHANNEL_ID }, auth));
    expect(res.status).toBe(401);
    noEffects();
  });

  it("segredo só na URL: 401", async () => {
    expect((await POST(req({ channelId: CHANNEL_ID }, null, `?secret=${SECRET}`))).status).toBe(401);
    noEffects();
  });

  it.each([
    ["JSON inválido", "{"],
    ["sem channelId", {}],
    ["channelId fora do formato", { channelId: "canal-qualquer" }],
    ["campos extras (resourceId, dono, token)", { channelId: CHANNEL_ID, resourceId: "outro", userId: "outro", accessToken: "x" }],
  ])("corpo %s: 400", async (_label, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    noEffects();
  });

  it("integração desligada (sem provedor): 404, sem consulta", async () => {
    m.provider.value = null;
    expect((await POST(req({ channelId: CHANNEL_ID }))).status).toBe(404);
    noEffects();
  });

  it.each([["channel_not_found"], ["calendar_environment_mismatch"], ["channel_inconsistent"]])(
    "canal recusado pelo banco (%s): 404 genérico, sem Google nem alteração",
    async (code) => {
      m.channels.set(CHANNEL_ID, new Error(code));
      const res = await POST(req({ channelId: CHANNEL_ID }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "channel_not_found" });
      expect(m.loadFreshTokens).not.toHaveBeenCalled();
      expect(m.stopRemote).not.toHaveBeenCalled();
      expect(m.stopLocal).not.toHaveBeenCalled();
    },
  );
});

describe("execução", () => {
  it("alvo resolvido pelo registro: conexão, dono, workspace e recurso gravados", async () => {
    const res = await POST(req({ channelId: CHANNEL_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ remote: "stopped", local: "stopped" });
    const c = channel();
    expect(m.loadFreshTokens).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: c.connectionId, workspaceId: c.workspaceId, actorUserId: c.userId }),
    );
    expect(m.stopRemote).toHaveBeenCalledWith(ACCESS_TOKEN, { id: CHANNEL_ID, resourceId: "recurso-gravado" });
    expect(m.stopLocal).toHaveBeenCalledWith(c.userId, CHANNEL_ID, "operator_stop");
    // Ordem: remoto antes do local.
    expect(m.stopRemote.mock.invocationCallOrder[0]).toBeLessThan(m.stopLocal.mock.invocationCallOrder[0] ?? 0);
  });

  it("404 do provedor: registrado como tal, local encerrado (200)", async () => {
    m.stopRemote.mockRejectedValueOnce(new ProviderHttpError(404, "Not Found: corpo bruto do Google"));
    const res = await POST(req({ channelId: CHANNEL_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ remote: "provider_404", local: "stopped" });
  });

  it("erro HTTP: não confirmado no Google (202), local encerrado", async () => {
    m.stopRemote.mockRejectedValueOnce(new ProviderHttpError(403, "forbidden: detalhe bruto"));
    const res = await POST(req({ channelId: CHANNEL_ID }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ remote: "http_403", local: "stopped" });
  });

  it.each([
    ["timeout (incerto)", new ProviderUncertainError()],
    ["falha de rede", new TypeError("fetch failed")],
  ])("%s: resultado remoto INDETERMINADO (202), sem afirmar que continua ativo", async (_label, error) => {
    m.stopRemote.mockRejectedValueOnce(error);
    const res = await POST(req({ channelId: CHANNEL_ID }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ remote: "indeterminate", local: "stopped" });
    expect(m.stopRemote).toHaveBeenCalledTimes(1); // sem repetição automática
  });

  it("falha ao encerrar no banco depois do sucesso remoto: 500, nunca sucesso completo", async () => {
    m.stopLocal.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(req({ channelId: CHANNEL_ID }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ remote: "stopped", local: "failed" });
  });

  it("conexão sem token agora: nada encerrado (409), para poder tentar de novo", async () => {
    m.loadFreshTokens.mockRejectedValueOnce(new Error("calendar_reauth_required"));
    const res = await POST(req({ channelId: CHANNEL_ID }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ remote: "not_attempted", local: "unchanged", reason: "connection_unavailable" });
    expect(m.stopRemote).not.toHaveBeenCalled();
    expect(m.stopLocal).not.toHaveBeenCalled();
  });

  it("repetição em canal já encerrado: idempotente, sem chamada ao Google nem confirmação inventada", async () => {
    m.channels.set(CHANNEL_ID, channel({ status: "stopped" }));
    const res = await POST(req({ channelId: CHANNEL_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ remote: "not_attempted", local: "already_stopped", reason: "already_stopped" });
    expect(m.loadFreshTokens).not.toHaveBeenCalled();
    expect(m.stopRemote).not.toHaveBeenCalled();
    expect(m.stopLocal).not.toHaveBeenCalled();
  });

  it("canal sem recurso (criação sem resposta): só o registro local", async () => {
    m.channels.set(CHANNEL_ID, channel({ status: "creating", resourceId: null }));
    const res = await POST(req({ channelId: CHANNEL_ID }));
    expect(await res.json()).toEqual({ remote: "not_attempted", local: "stopped", reason: "no_resource" });
    expect(m.stopRemote).not.toHaveBeenCalled();
  });

  it("falha inesperada na consulta: 503 só com código", async () => {
    m.channels.set(CHANNEL_ID, new Error("connection refused 10.0.0.1 com detalhe"));
    const res = await POST(req({ channelId: CHANNEL_ID }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "lookup_failed" });
    expect(m.stopRemote).not.toHaveBeenCalled();
  });

  it("nenhum segredo nas respostas nem nos logs", async () => {
    const bodies: string[] = [];
    m.stopRemote.mockRejectedValueOnce(new ProviderHttpError(400, `bad request token=${ACCESS_TOKEN}`));
    bodies.push(await (await POST(req({ channelId: CHANNEL_ID }))).text());
    m.channels.set(CHANNEL_ID, new Error(`falha ${ACCESS_TOKEN}`));
    bodies.push(await (await POST(req({ channelId: CHANNEL_ID }))).text());
    bodies.push(await (await POST(req({ channelId: CHANNEL_ID }, "Bearer segredo-errado-0123456789"))).text());
    const printed = logs.flatMap((spy) => spy.mock.calls.flat()).map(String).join("\n");
    for (const text of [...bodies, printed]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(ACCESS_TOKEN);
      expect(text).not.toContain("refresh-ficticio");
      expect(text).not.toContain("recurso-gravado");
      expect(text).not.toContain("segredo-errado");
      expect(text.toLowerCase()).not.toContain("bearer");
    }
  });
});
