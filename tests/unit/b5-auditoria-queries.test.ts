/**
 * @vitest-environment node
 *
 * B5 — leitura da auditoria: só pela RPC sanitizada, com o contrato de erro do
 * projeto (ausência legítima = null; falha = DataLoadError, nunca lista vazia).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, fromMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), fromMock: vi.fn() }));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock, from: fromMock }),
}));

const { listAuditLog, AuditLoadError } = await import("@/modules/audit/queries");
const { DataLoadError } = await import("@/server/data/load-error");

const WS = "10000000-0000-0000-0000-000000000001";
const ANA = "20000000-0000-0000-0000-000000000001";
const CARLA = "20000000-0000-0000-0000-000000000003";
const NO_FILTERS = { action: null, actorUserId: null, from: null, to: null };

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  created_at: "2026-11-09T15:00:00.123456+00:00",
  action: "membership.role_changed",
  actor_user_id: ANA,
  actor_name: "Ana Owner",
  target_name: null,
  details: { from_role: "viewer", to_role: "admin" },
  ...over,
});
const ID1 = "a1000000-0000-0000-0000-000000000001";
const ID2 = "a1000000-0000-0000-0000-000000000002";

beforeEach(() => {
  rpcMock.mockReset();
  fromMock.mockReset();
  fromMock.mockImplementation(() => {
    throw new Error("audit_logs não tem leitura por tabela: só a RPC sanitizada");
  });
});

describe("o que é pedido ao banco", () => {
  it("sem filtro: só o workspace da sessão e o tamanho da página", async () => {
    rpcMock.mockResolvedValue({ data: [{ items: [], has_more: false }], error: null });
    await listAuditLog(WS, NO_FILTERS, null);
    expect(rpcMock).toHaveBeenCalledExactlyOnceWith("list_audit_log", { p_workspace_id: WS, p_limit: 25 });
  });

  it("filtros e cursor viram parâmetros; o que não foi pedido não é enviado", async () => {
    rpcMock.mockResolvedValue({ data: [{ items: [], has_more: false }], error: null });
    await listAuditLog(
      WS,
      { action: "lead.created", actorUserId: CARLA, from: "2026-11-01", to: "2026-11-09" },
      { createdAt: "2026-11-09T15:00:00.123456+00:00", id: ID1 },
    );
    expect(rpcMock).toHaveBeenCalledExactlyOnceWith("list_audit_log", {
      p_workspace_id: WS,
      p_action: "lead.created",
      p_actor_user_id: CARLA,
      p_from: "2026-11-01",
      p_to: "2026-11-09",
      p_before: "2026-11-09T15:00:00.123456+00:00",
      p_before_id: ID1,
      p_limit: 25,
    });
  });

  it("nunca lê a tabela audit_logs diretamente", async () => {
    rpcMock.mockResolvedValue({ data: [{ items: [row(ID1)], has_more: false }], error: null });
    await listAuditLog(WS, NO_FILTERS, null);
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe("o que volta", () => {
  it("mapeia a página e calcula o cursor da próxima", async () => {
    rpcMock.mockResolvedValue({
      data: [{ items: [row(ID2, { created_at: "2026-11-09T15:05:00+00:00" }), row(ID1)], has_more: true }],
      error: null,
    });
    const page = await listAuditLog(WS, NO_FILTERS, null);
    expect(page).toEqual({
      items: [
        {
          id: ID2,
          createdAt: "2026-11-09T15:05:00+00:00",
          action: "membership.role_changed",
          actorUserId: ANA,
          actorName: "Ana Owner",
          targetName: null,
          details: { from_role: "viewer", to_role: "admin" },
        },
        {
          id: ID1,
          createdAt: "2026-11-09T15:00:00.123456+00:00",
          action: "membership.role_changed",
          actorUserId: ANA,
          actorName: "Ana Owner",
          targetName: null,
          details: { from_role: "viewer", to_role: "admin" },
        },
      ],
      hasMore: true,
      // O instante com microssegundos volta exatamente como o banco mandou.
      nextCursor: { createdAt: "2026-11-09T15:00:00.123456+00:00", id: ID1 },
    });
  });

  it("última página: sem cursor", async () => {
    rpcMock.mockResolvedValue({ data: [{ items: [row(ID1)], has_more: false }], error: null });
    const page = await listAuditLog(WS, NO_FILTERS, null);
    expect(page?.hasMore).toBe(false);
    expect(page?.nextCursor).toBeNull();
  });

  it("sem registros: lista vazia (resposta legítima)", async () => {
    rpcMock.mockResolvedValue({ data: [{ items: [], has_more: false }], error: null });
    expect(await listAuditLog(WS, NO_FILTERS, null)).toEqual({ items: [], hasMore: false, nextCursor: null });
    rpcMock.mockResolvedValue({ data: [], error: null });
    expect(await listAuditLog(WS, NO_FILTERS, null)).toEqual({ items: [], hasMore: false, nextCursor: null });
  });

  it("detalhes passam de novo pela lista de permissão, mesmo que o banco mandasse mais", async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          items: [
            row(ID1, {
              action: "invitation.created",
              details: {
                role: "lawyer",
                email: "convidado@exemplo.com",
                name: "Maria Silva",
                token: "tok_123",
                api_key: "sk_live_x",
                phone: "+5511999990000",
                metadata: { tudo: "cru" },
                environment: "staging",
              },
            }),
          ],
          has_more: false,
        },
      ],
      error: null,
    });
    const page = await listAuditLog(WS, NO_FILTERS, null);
    expect(page?.items[0]?.details).toEqual({ role: "lawyer" });
    expect(JSON.stringify(page)).not.toMatch(/exemplo|Maria|tok_123|sk_live|5511|cru|staging|metadata/);
  });

  it("nenhum campo extra do banco vaza para o resultado", async () => {
    rpcMock.mockResolvedValue({
      data: [{ items: [row(ID1, { metadata: { email: "x@y.z" }, workspace_id: WS, resource_id: ID2 })], has_more: false }],
      error: null,
    });
    const page = await listAuditLog(WS, NO_FILTERS, null);
    expect(Object.keys(page!.items[0]!).sort()).toEqual(
      ["action", "actorName", "actorUserId", "createdAt", "details", "id", "targetName"].sort(),
    );
    expect(JSON.stringify(page)).not.toContain("x@y.z");
  });
});

describe("erros", () => {
  it("insufficient_permission (workspace alheio, inexistente ou papel que mudou) → null", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "insufficient_permission" } });
    expect(await listAuditLog(WS, NO_FILTERS, null)).toBeNull();
  });

  it("falha operacional → DataLoadError sem o texto do banco, nunca lista vazia", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "canceling statement due to statement timeout: select * from audit_logs where email = 'x@y.z'" },
    });
    const error = await listAuditLog(WS, NO_FILTERS, null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuditLoadError);
    expect(error).toBeInstanceOf(DataLoadError);
    expect((error as Error).message).not.toMatch(/statement|select|x@y\.z/);
  });

  it("invalid_filter/invalid_period/invalid_cursor do banco também são falha de carga, não 'vazio'", async () => {
    for (const code of ["invalid_filter", "invalid_period", "invalid_cursor", "authentication_required"]) {
      rpcMock.mockResolvedValue({ data: null, error: { message: code } });
      await expect(listAuditLog(WS, NO_FILTERS, null)).rejects.toBeInstanceOf(DataLoadError);
    }
  });

  it("linha fora do formato → DataLoadError (não finge que está tudo bem)", async () => {
    for (const bad of [
      row("nao-e-uuid"),
      row(ID1, { created_at: "" }),
      row(ID1, { action: "" }),
      row(ID1, { actor_user_id: "nao-e-uuid" }),
      row(ID1, { actor_name: 7 }),
      { ...row(ID1), id: undefined },
    ]) {
      rpcMock.mockResolvedValue({ data: [{ items: [bad], has_more: false }], error: null });
      await expect(listAuditLog(WS, NO_FILTERS, null)).rejects.toBeInstanceOf(AuditLoadError);
    }
    rpcMock.mockResolvedValue({ data: [{ items: "não é lista", has_more: false }], error: null });
    await expect(listAuditLog(WS, NO_FILTERS, null)).rejects.toBeInstanceOf(AuditLoadError);
  });

  it("registro do sistema: ator nulo é aceito", async () => {
    rpcMock.mockResolvedValue({
      data: [{ items: [row(ID1, { actor_user_id: null, actor_name: null })], has_more: false }],
      error: null,
    });
    const page = await listAuditLog(WS, NO_FILTERS, null);
    expect(page?.items[0]).toMatchObject({ actorUserId: null, actorName: null });
  });
});
