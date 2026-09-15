import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Estabilização pós-A9 — inventário §1.3/§1.4/§1.9: as Server Actions que o
 * kanban, o StageMoveControl, o StageAdvanceDialog, o WonDialog e o
 * LostDialog chamam para decidir o que mostrar. Lista vazia significa
 * "nenhum requisito pendente" (libera avanço/ganho sem o diálogo) ou
 * "nenhum motivo cadastrado" — então falha operacional, oportunidade
 * inacessível e permissão negada precisam chegar ao cliente como erro,
 * nunca como lista vazia.
 */

const state = vi.hoisted(() => ({
  rpc: (() => ({ data: null, error: null })) as (fn: string) => { data: unknown; error: { message: string } | null },
  table: (() => ({ data: [], error: null })) as () => { data: unknown; error: { message: string } | null },
  role: "owner" as string,
}));

function queryBuilder() {
  const settle = () => Promise.resolve(state.table());
  const builder: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
        return () => builder;
      },
    },
  );
  return builder;
}

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: async (fn: string) => state.rpc(fn), from: () => queryBuilder() }),
}));
vi.mock("@/server/authz/permissions", async () => {
  const { roleHasPermission } = await import("@/lib/roles");
  class AuthzError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    AuthzError,
    requireMembership: async () => ({ userId: "u1", workspaceId: "ws-1", membershipId: "m1", role: state.role }),
    requirePermission: async (permission: Parameters<typeof roleHasPermission>[1]) => {
      if (!roleHasPermission(state.role as Parameters<typeof roleHasPermission>[0], permission)) {
        throw new AuthzError("forbidden", "sem permissão");
      }
      return { userId: "u1", workspaceId: "ws-1", membershipId: "m1", role: state.role };
    },
  };
});

const actions = await import("@/modules/opportunities/actions");
const { LOAD_ERROR_MESSAGE } = await import("@/server/data/load-error");

const requirementRow = {
  requirement_id: "r1",
  stage_id: "s2",
  stage_name: "Qualificar",
  label: "Área confirmada",
  field_type: "checkbox",
  hint: null,
  value_text: null,
  value_bool: null,
  filled: false,
};

beforeEach(() => {
  state.rpc = () => ({ data: null, error: null });
  state.table = () => ({ data: [], error: null });
  state.role = "owner";
});

describe.each([
  ["checkStageRequirementsAction", () => actions.checkStageRequirementsAction("o1", "s2")],
  ["checkWinRequirementsAction", () => actions.checkWinRequirementsAction("o1")],
])("%s", (_name, call) => {
  it("falha operacional devolve erro sanitizado, nunca lista vazia", async () => {
    state.rpc = () => ({ data: null, error: { message: "could not connect to server: 10.0.0.3" } });
    const result = await call();
    expect(result).toEqual({ ok: false, error: LOAD_ERROR_MESSAGE });
  });

  it("oportunidade inacessível devolve erro, nunca 'nenhum requisito pendente'", async () => {
    state.rpc = () => ({ data: null, error: { message: "opportunity_not_found" } });
    const result = await call();
    expect(result.ok).toBe(false);
  });

  it("permissão negada devolve erro, nunca lista vazia", async () => {
    state.role = "nao-existe";
    const result = await call();
    expect(result.ok).toBe(false);
  });

  it("sucesso devolve os requisitos", async () => {
    state.rpc = () => ({ data: [requirementRow], error: null });
    const result = await call();
    expect(result).toEqual({ ok: true, requirements: [expect.objectContaining({ requirementId: "r1", filled: false })] });
  });

  it("sucesso sem requisitos devolve lista vazia legítima", async () => {
    state.rpc = () => ({ data: [], error: null });
    await expect(call()).resolves.toEqual({ ok: true, requirements: [] });
  });
});

describe("listLostReasonsAction", () => {
  it("falha operacional devolve erro sanitizado, nunca 'nenhum motivo'", async () => {
    state.table = () => ({ data: null, error: { message: "relation lost_reasons timeout" } });
    await expect(actions.listLostReasonsAction("ws-1")).resolves.toEqual({ ok: false, error: LOAD_ERROR_MESSAGE });
  });

  it("sucesso devolve os motivos", async () => {
    state.table = () => ({ data: [{ id: "lr1", label: "Preço" }], error: null });
    await expect(actions.listLostReasonsAction("ws-1")).resolves.toEqual({
      ok: true,
      reasons: [{ id: "lr1", label: "Preço" }],
    });
  });
});
