/**
 * @vitest-environment node
 *
 * B2 — autorização revogada sem depender do agendador. Antes desta correção,
 * só a manutenção agendada (cron/Inngest, desligada em Preview e Production)
 * marcava a conexão "a reautorizar": a sincronização sob demanda e as ações
 * interativas engoliam o `invalid_grant` e a conexão continuava "ativa", sem
 * o botão "Autorizar novamente" na tela.
 *
 * Camada REAL (`loadConnectionContext`, `loadFreshTokens`, funções
 * administrativas e cifra dos tokens, sincronização sob demanda); só o
 * cliente do banco (as RPCs, com as mesmas regras do SQL) e o Google são
 * simulados. Dados fictícios.
 */
import { createHash, randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------
// Banco simulado: as RPCs que esta camada usa, com as regras do SQL.
// ---------------------------------------------------------------------

type Row = {
  id: string;
  workspaceId: string;
  userId: string;
  environment: "preview" | "production";
  status: "active" | "needs_reauth" | "disconnected";
  refreshCiphertext: string | null;
  accessCiphertext: string | null;
  accessExpiresAt: string | null;
  keyVersion: string | null;
};

const db = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  audit: [] as Array<{ action: string; connectionId: string; reason?: string }>,
  calls: [] as string[],
}));

const fingerprint = (ciphertext: string) => createHash("sha256").update(ciphertext, "utf8").digest("hex");

vi.mock("@/server/calendar/admin/supabase", () => ({
  createCalendarAdminSupabaseClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      db.calls.push(name);
      const env = process.env.VERCEL_ENV === "production" ? "production" : "preview";
      const row = db.rows.get(args.p_connection_id as string);
      const refuse = (message: string) => ({ data: null, error: { message } });
      if (name === "get_calendar_connection_secrets") {
        if (!row || row.userId !== args.p_actor_user_id) return refuse("connection_not_found");
        if (row.environment !== env) return refuse("calendar_environment_mismatch");
        if (row.status === "disconnected") return refuse("connection_not_found");
        return {
          data: [
            {
              refresh_token_ciphertext: row.refreshCiphertext,
              access_token_ciphertext: row.accessCiphertext,
              access_token_expires_at: row.accessExpiresAt,
              key_version: row.keyVersion,
              status: row.status,
              environment: row.environment,
            },
          ],
          error: null,
        };
      }
      if (name === "store_calendar_access_token") {
        if (!row || row.userId !== args.p_actor_user_id || row.status !== "active") return refuse("connection_not_found");
        row.accessCiphertext = args.p_access_token_ciphertext as string;
        row.accessExpiresAt = args.p_access_token_expires_at as string;
        return { data: null, error: null };
      }
      if (name === "mark_calendar_connection_needs_reauth_if_current") {
        if (!row || row.userId !== args.p_actor_user_id || row.workspaceId !== args.p_workspace_id) return refuse("connection_not_found");
        if (row.environment !== env) return refuse("calendar_environment_mismatch");
        if (row.status === "disconnected") return { data: "disconnected", error: null };
        if (!row.refreshCiphertext || fingerprint(row.refreshCiphertext) !== args.p_refresh_fingerprint) return { data: "stale", error: null };
        if (row.status === "needs_reauth") return { data: "already", error: null };
        row.status = "needs_reauth";
        db.audit.push({ action: "calendar.connection.needs_reauth", connectionId: row.id, reason: args.p_reason as string });
        return { data: "marked", error: null };
      }
      return refuse(`rpc_nao_simulada:${name}`);
    },
  }),
}));

// Sessão, provedor e lista de conexões (para os fluxos de ponta a ponta).
const session = vi.hoisted(() => ({ provider: null as unknown, listed: [] as unknown[], after: [] as Promise<void>[] }));
vi.mock("@/server/authz/safe", () => ({
  requirePermissionSafe: async () => ({
    ctx: { userId: "d10a0000-0000-4000-8000-000000000011", workspaceId: "d10a0000-0000-4000-8000-000000000001" },
  }),
}));
vi.mock("@/server/calendar/provider", () => ({ getCalendarProvider: async () => session.provider }));
vi.mock("@/modules/calendar/queries", () => ({ listCalendarConnections: async () => session.listed }));
// `after()` do Next: aqui, roda na hora (e o teste aguarda).
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => void session.after.push(fn()) }));

import { encryptCalendarToken } from "@/server/calendar/token-crypto";
import { openOwnerConnection } from "@/server/calendar/background";
import { scheduleOnDemandCalendarSync } from "@/modules/calendar/on-demand";
import { syncLinkedActivity } from "@/modules/calendar/appointment-service";
import { loadConnectionContext, loadFreshTokens } from "@/server/calendar/connection-context";
import { toUserMessage } from "@/lib/errors";

const WS = "d10a0000-0000-4000-8000-000000000001";
const USER = "d10a0000-0000-4000-8000-000000000011";
const CONN = "61af033c-0000-4000-8000-000000000001";
const PAST = "2026-10-16T00:00:00.000Z";

function seed(over: Partial<Row> = {}, refreshToken = "refresh-ficticio") {
  const ctx = { environment: "preview" as const, workspaceId: WS, userId: USER };
  const refresh = encryptCalendarToken(refreshToken, ctx);
  const access = encryptCalendarToken("access-ficticio", ctx, refresh.keyVersion);
  const row: Row = {
    id: CONN,
    workspaceId: WS,
    userId: USER,
    environment: "preview",
    status: "active",
    refreshCiphertext: refresh.ciphertextBase64,
    accessCiphertext: access.ciphertextBase64,
    accessExpiresAt: PAST, // vencido: a próxima chamada renova
    keyVersion: refresh.keyVersion,
    ...over,
  };
  db.rows.set(row.id, row);
  return row;
}

/** Google simulado: a renovação responde como `refresh`; o resto registra chamadas. */
function provider(refresh: () => Promise<{ accessToken: string; accessTokenExpiresAt: Date }>) {
  const calendarCalls: string[] = [];
  const track = (name: string) => async () => {
    calendarCalls.push(name);
    throw new Error("nao_deveria_chamar");
  };
  return {
    calendarCalls,
    impl: {
      kind: "google",
      refreshAccessToken: vi.fn(refresh),
      listEvents: track("listEvents"),
      getEvent: track("getEvent"),
      listCalendars: track("listCalendars"),
      freeBusy: track("freeBusy"),
    } as never,
  };
}

const invalidGrant = async (): Promise<never> => {
  throw new Error("refresh_token_invalid");
};

beforeEach(() => {
  db.rows.clear();
  db.audit.length = 0;
  db.calls.length = 0;
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("CALENDAR_TOKEN_KEY_VERSIONS", JSON.stringify({ t1: randomBytes(32).toString("base64") }));
  vi.stubEnv("CALENDAR_TOKEN_ACTIVE_KEY_VERSION", "t1");
});
afterEach(() => vi.unstubAllEnvs());

const open = (p: ReturnType<typeof provider>) =>
  loadConnectionContext({
    provider: p.impl,
    connection: { id: CONN, calendarId: "agenda-teste@group.calendar.google.com", status: "active" },
    workspaceId: WS,
    actorUserId: USER,
  });

describe("invalid_grant na renovação, sem agendador", () => {
  it("REPRODUÇÃO: a conexão passa a 'a reautorizar' e nenhuma chamada de calendário é feita", async () => {
    seed();
    const p = provider(invalidGrant);

    const error = await open(p).then(
      () => null,
      (e: unknown) => e,
    );

    // Antes da correção: a renovação falhava e a conexão continuava "active".
    expect(db.rows.get(CONN)!.status).toBe("needs_reauth");
    expect(db.audit).toEqual([{ action: "calendar.connection.needs_reauth", connectionId: CONN, reason: "refresh_token_invalid" }]);
    expect(p.calendarCalls).toEqual([]);
    expect(error).toMatchObject({ message: "calendar_reauth_required" });
  });

  it("mensagem para o usuário: orienta a autorizar novamente, sem dizer que algo foi apagado ou desfeito", () => {
    const message = toUserMessage(new Error("calendar_reauth_required"));
    expect(message).toMatch(/Autorizar novamente/);
    expect(message).not.toMatch(/desfeit|apagad|removid/i);
  });

  it("a mesma falha repetida não duplica a transição", async () => {
    seed();
    await expect(open(provider(invalidGrant))).rejects.toThrow("calendar_reauth_required");
    // Já a reautorizar: a leitura dos tokens ainda é do dono, a renovação falha de novo.
    db.rows.get(CONN)!.status = "needs_reauth";
    await expect(loadFreshTokens({ provider: provider(invalidGrant).impl, connectionId: CONN, workspaceId: WS, actorUserId: USER })).rejects.toThrow(
      "calendar_reauth_required",
    );
    expect(db.audit).toHaveLength(1);
  });
});

describe("falhas que NÃO são reautorização", () => {
  it.each([
    ["rede ou prazo", "refresh_failed:oauth_unavailable", "calendar_refresh_unavailable"],
    ["erro temporário do Google", "refresh_failed:oauth_http_503", "calendar_refresh_unavailable"],
    ["limite de chamadas", "refresh_failed:rateLimitExceeded", "calendar_refresh_unavailable"],
    ["cliente OAuth inválido", "refresh_failed:invalid_client", "calendar_oauth_misconfigured"],
    ["cliente OAuth não autorizado", "refresh_failed:unauthorized_client", "calendar_oauth_misconfigured"],
  ])("%s: conexão continua ativa; erro próprio", async (_caso, adapterError, domainError) => {
    seed();
    const p = provider(async () => {
      throw new Error(adapterError);
    });
    await expect(open(p)).rejects.toThrow(domainError);
    expect(db.rows.get(CONN)!.status).toBe("active");
    expect(db.audit).toEqual([]);
    expect(p.calendarCalls).toEqual([]);
  });

  it("configuração inválida não responsabiliza o usuário; falha temporária pede para tentar de novo", () => {
    expect(toUserMessage(new Error("calendar_oauth_misconfigured"))).not.toMatch(/Autorizar novamente|reautoriz/i);
    expect(toUserMessage(new Error("calendar_refresh_unavailable"))).toMatch(/tente de novo/i);
  });
});

describe("renovação bem-sucedida continua igual", () => {
  it("guarda o novo token de acesso cifrado e devolve o contexto", async () => {
    const row = seed();
    const before = row.accessCiphertext;
    const p = provider(async () => ({ accessToken: "access-novo", accessTokenExpiresAt: new Date(Date.now() + 3600_000) }));

    const ctx = await open(p);

    expect(ctx.accessToken).toBe("access-novo");
    expect(row.accessCiphertext).not.toBe(before);
    expect(row.accessCiphertext).not.toContain("access-novo");
    expect(row.status).toBe("active");
  });

  it("token de acesso ainda válido: nem tenta renovar (a revogação só aparece na próxima renovação)", async () => {
    seed({ accessExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    const p = provider(invalidGrant);
    await expect(open(p)).resolves.toMatchObject({ accessToken: "access-ficticio" });
    expect(p.impl).toBeDefined();
    expect(db.rows.get(CONN)!.status).toBe("active");
  });
});

describe("falha atrasada, com credenciais antigas", () => {
  it("reautorização concluída durante a chamada: a falha do token VELHO não invalida a conexão nova", async () => {
    const row = seed();
    const p = provider(async () => {
      // Enquanto o Google recusava o token velho, o usuário reautorizou.
      const fresh = seed({}, "refresh-novo-da-reautorizacao");
      row.refreshCiphertext = fresh.refreshCiphertext;
      throw new Error("refresh_token_invalid");
    });

    await expect(open(p)).rejects.toThrow("calendar_refresh_unavailable");

    expect(db.rows.get(CONN)!.status).toBe("active");
    expect(db.audit).toEqual([]);
  });

  it("desconectada durante a chamada: continua desconectada", async () => {
    seed();
    const p = provider(async () => {
      db.rows.get(CONN)!.status = "disconnected";
      throw new Error("refresh_token_invalid");
    });
    await expect(open(p)).rejects.toThrow("connection_not_active");
    expect(db.rows.get(CONN)!.status).toBe("disconnected");
    expect(db.audit).toEqual([]);
  });
});

describe("isolamento: outro usuário, workspace ou ambiente", () => {
  it("outro usuário não lê os tokens nem marca a conexão", async () => {
    seed();
    await expect(
      loadFreshTokens({ provider: provider(invalidGrant).impl, connectionId: CONN, workspaceId: WS, actorUserId: "outro-usuario" }),
    ).rejects.toThrow("connection_not_found");
    expect(db.rows.get(CONN)!.status).toBe("active");
  });

  it("outro workspace: não marca (e a cifra recusa o token)", async () => {
    seed();
    await expect(
      loadFreshTokens({ provider: provider(invalidGrant).impl, connectionId: CONN, workspaceId: "outro-workspace", actorUserId: USER }),
    ).rejects.toThrow();
    expect(db.rows.get(CONN)!.status).toBe("active");
    expect(db.audit).toEqual([]);
  });

  it("outro ambiente: recusado antes de qualquer renovação", async () => {
    seed();
    vi.stubEnv("VERCEL_ENV", "production");
    const p = provider(invalidGrant);
    await expect(loadFreshTokens({ provider: p.impl, connectionId: CONN, workspaceId: WS, actorUserId: USER })).rejects.toThrow(
      "calendar_environment_mismatch",
    );
    expect((p.impl as { refreshAccessToken: ReturnType<typeof vi.fn> }).refreshAccessToken).not.toHaveBeenCalled();
    expect(db.rows.get(CONN)!.status).toBe("active");
  });
});

describe("os caminhos que usam a renovação", () => {
  const listedActive = () => [
    {
      id: CONN,
      userId: USER,
      isMine: true,
      status: db.rows.get(CONN)!.status,
      calendarId: "agenda-teste@group.calendar.google.com",
      calendarSummary: "Agenda de teste",
      googleAccountEmail: "teste@exemplo.test",
      createdAt: "",
    },
  ];

  it("sincronização sob demanda (Agenda): marca 'a reautorizar' sem listar eventos", async () => {
    seed();
    const p = provider(invalidGrant);
    session.provider = p.impl;
    session.listed = listedActive();
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});

    await scheduleOnDemandCalendarSync({ userId: USER, workspaceId: WS });
    await Promise.all(session.after);

    expect(db.rows.get(CONN)!.status).toBe("needs_reauth");
    expect(p.calendarCalls).toEqual([]);
    // O log continua só com o código, nunca token ou mensagem do Google.
    expect(logs.mock.calls.flat().join(" ")).not.toMatch(/refresh-ficticio|access-ficticio/);
    logs.mockRestore();
  });

  it("operação interativa (edição já salva no CRM): mensagem compreensível, sem desfazer o que foi salvo", async () => {
    seed();
    session.provider = provider(invalidGrant).impl;
    session.listed = listedActive();

    const notice = await syncLinkedActivity("5e044c2a-0000-4000-8000-000000000001");

    expect(notice?.level).toBe("warning");
    expect(notice?.message).toMatch(/^Salvo no CRM\. O Google Agenda não foi atualizado: /);
    expect(notice?.message).toContain("Autorizar novamente");
    expect(db.rows.get(CONN)!.status).toBe("needs_reauth");
  });

  it("manutenção agendada: 'needs_reauth' com UMA transição; falha temporária não marca", async () => {
    seed();
    const owner = { connectionId: CONN, userId: USER, workspaceId: WS, calendarId: "agenda-teste@group.calendar.google.com" };
    expect(await openOwnerConnection(provider(invalidGrant).impl, owner)).toBe("needs_reauth");
    expect(db.audit).toHaveLength(1);

    db.rows.clear();
    db.audit.length = 0;
    seed();
    const temporary = provider(async () => {
      throw new Error("refresh_failed:oauth_unavailable");
    });
    expect(await openOwnerConnection(temporary.impl, owner)).toBeNull();
    expect(db.rows.get(CONN)!.status).toBe("active");
    expect(db.audit).toEqual([]);
  });
});
