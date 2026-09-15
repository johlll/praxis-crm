import { describe, expect, it, vi } from "vitest";

/**
 * A action real (não mockada): antes ela chamava listActivities(), que
 * transforma erro de RPC em lista vazia — a action respondia ok: true com
 * hasMore: false e o "Carregar mais" sumia como se não houvesse mais nada.
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));
vi.mock("@/server/authz/permissions", () => ({
  requireMembership: async () => ({ userId: "u1", workspaceId: "ws-1", membershipId: "m1", role: "owner" }),
  requirePermission: vi.fn(),
  AuthzError: class AuthzError extends Error {},
}));

const { loadMoreLeadActivitiesAction } = await import("@/modules/activities/actions");

describe("loadMoreLeadActivitiesAction", () => {
  it("falha do RPC na segunda página vira ok: false — nunca ok: true com hasMore: false", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: "conexão perdida (simulado)" } }));

    const result = await loadMoreLeadActivitiesAction("lead-1", 2);

    expect(result).toEqual({ ok: false, error: "Não foi possível carregar mais atividades. Tente novamente." });
    expect(rpcMock).toHaveBeenCalledWith(
      "list_activities",
      expect.objectContaining({ p_lead_id: "lead-1", p_page: 2, p_page_size: 50, p_status: null }),
    );
  });

  it("sucesso devolve os itens e hasMore calculado do total", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({ data: [{ items: [], total_count: 50, counts: {} }], error: null }));

    await expect(loadMoreLeadActivitiesAction("lead-1", 2)).resolves.toEqual({ ok: true, items: [], hasMore: false });
  });
});
