/**
 * B5 — Server Action de transferência de posse.
 *
 * Usa a verificação de permissão REAL (membership via banco simulado): só o
 * proprietário passa; o workspace é o da sessão, nunca o do formulário; sem a
 * confirmação explícita nada é chamado; as recusas do banco viram mensagens
 * sanitizadas. As regras de verdade (owner ativo, destinatário ativo do mesmo
 * workspace, atomicidade) estão provadas em
 * supabase/tests/database/45_b5_auditoria_e_posse.test.sql.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type RpcResult = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  getUser: (() => ({ data: { user: { id: "u1" } }, error: null })) as () => { data: { user: unknown }; error: unknown },
  membership: (() => ({ data: null, error: null })) as () => RpcResult,
  rpc: (() => ({ data: null, error: null })) as (fn: string, args: Record<string, unknown>) => RpcResult,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  cookie: undefined as string | undefined,
}));
const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));

function membershipBuilder() {
  const settle = () => Promise.resolve(state.membership());
  const builder: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
        if (prop === "maybeSingle" || prop === "single") return settle;
        return () => builder;
      },
    },
  );
  return builder;
}

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.cookie ? { value: state.cookie } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  }),
  headers: async () => new Headers({ host: "localhost:3000" }),
}));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => state.getUser() },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return state.rpc(fn, args);
    },
    from: () => membershipBuilder(),
  }),
}));

const { createHmac } = await import("node:crypto");
const { transferOwnershipAction } = await import("@/modules/team/actions");
const { PERMISSION_DENIED_MESSAGE } = await import("@/server/authz/safe");
const { LOAD_ERROR_MESSAGE } = await import("@/server/data/load-error");

const WS = "10000000-0000-0000-0000-000000000001";
const OTHER_WS = "10000000-0000-0000-0000-000000000002";
const TARGET = "30000000-0000-0000-0000-000000000009";

function signedCookie(workspaceId: string) {
  const mac = createHmac("sha256", process.env.WORKSPACE_ACTIVE_COOKIE_SECRET!).update(workspaceId).digest("hex");
  return `${workspaceId}.${mac}`;
}
function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}
const valid = () => form({ membershipId: TARGET, confirm: "yes" });
const asRole = (role: string) => {
  state.membership = () => ({ data: { id: "m1", role, workspace_id: WS }, error: null });
};

beforeEach(() => {
  state.getUser = () => ({ data: { user: { id: "u1" } }, error: null });
  state.rpc = () => ({ data: null, error: null });
  state.rpcCalls = [];
  state.cookie = signedCookie(WS);
  revalidatePathMock.mockClear();
  asRole("owner");
});

describe("quem pode", () => {
  it.each(["admin", "manager", "lawyer", "sales", "viewer"])("%s é recusado e o banco nem é chamado", async (role) => {
    asRole(role);
    const result = await transferOwnershipAction(valid());
    expect(result).toEqual({ ok: false, error: PERMISSION_DENIED_MESSAGE });
    expect(state.rpcCalls).toEqual([]);
  });

  it("sem sessão: recusado", async () => {
    state.getUser = () => ({ data: { user: null }, error: { name: "AuthSessionMissingError", message: "x" } });
    const result = await transferOwnershipAction(valid());
    expect(result).toEqual({ ok: false, error: PERMISSION_DENIED_MESSAGE });
    expect(state.rpcCalls).toEqual([]);
  });

  it("falha operacional ao carregar a membership: mensagem de carga, nada chamado", async () => {
    state.membership = () => ({ data: null, error: { message: "canceling statement due to statement timeout" } });
    const result = await transferOwnershipAction(valid());
    expect(result).toEqual({ ok: false, error: LOAD_ERROR_MESSAGE });
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("o que vai ao banco", () => {
  it("proprietário + confirmação: uma chamada, com o workspace da SESSÃO e o destinatário", async () => {
    const result = await transferOwnershipAction(valid());
    expect(result).toEqual({ ok: true });
    expect(state.rpcCalls).toEqual([
      { fn: "transfer_workspace_ownership", args: { p_workspace_id: WS, p_target_membership_id: TARGET } },
    ]);
    expect(revalidatePathMock).toHaveBeenCalledExactlyOnceWith("/configuracoes/equipe");
  });

  it("workspace, papel ou ator vindos do formulário não chegam ao banco", async () => {
    await transferOwnershipAction(
      form({
        membershipId: TARGET,
        confirm: "yes",
        workspaceId: OTHER_WS,
        workspace_id: OTHER_WS,
        p_workspace_id: OTHER_WS,
        role: "owner",
        actorUserId: TARGET,
        p_actor_user_id: TARGET,
      }),
    );
    expect(state.rpcCalls).toHaveLength(1);
    expect(Object.keys(state.rpcCalls[0]!.args).sort()).toEqual(["p_target_membership_id", "p_workspace_id"]);
    expect(state.rpcCalls[0]!.args.p_workspace_id).toBe(WS);
  });
});

describe("confirmação e validação", () => {
  it("sem a confirmação explícita, nada é chamado", async () => {
    for (const confirm of [undefined, "", "on", "true", "1", "YES", "Yes", "no", "yes "]) {
      state.rpcCalls = [];
      const result = await transferOwnershipAction(
        confirm === undefined ? form({ membershipId: TARGET }) : form({ membershipId: TARGET, confirm }),
      );
      expect(result).toEqual({ ok: false, error: "Confirme que entendeu as consequências para transferir a posse." });
      expect(state.rpcCalls).toEqual([]);
    }
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("destinatário ausente ou que não é uuid: 'Dados inválidos.', nada chamado", async () => {
    for (const membershipId of [undefined, "", "nao-e-uuid", "1; drop table memberships", `${TARGET}x`]) {
      state.rpcCalls = [];
      const result = await transferOwnershipAction(
        membershipId === undefined ? form({ confirm: "yes" }) : form({ membershipId, confirm: "yes" }),
      );
      expect(result).toEqual({ ok: false, error: "Dados inválidos." });
      expect(state.rpcCalls).toEqual([]);
    }
  });

  it("destinatário inválido E sem confirmação: prevalece 'Dados inválidos.'", async () => {
    const result = await transferOwnershipAction(form({ membershipId: "x" }));
    expect(result).toEqual({ ok: false, error: "Dados inválidos." });
  });
});

describe("recusas do banco viram mensagens sanitizadas", () => {
  it.each([
    ["insufficient_permission", "Você não tem permissão para fazer isso."],
    ["membership_not_found", "Membro não encontrado."],
    ["cannot_transfer_to_self", "Escolha outra pessoa: a posse não pode ser transferida para você mesmo."],
    ["membership_not_active", "Só é possível transferir a posse para um membro ativo da equipe."],
    ["ownership_transfer_failed", "Não foi possível transferir a posse. Nada foi alterado."],
    ["authentication_required", "Sua sessão expirou. Entre novamente."],
  ])("%s", async (code, message) => {
    state.rpc = () => ({ data: null, error: { message: code } });
    const result = await transferOwnershipAction(valid());
    expect(result).toEqual({ ok: false, error: message });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("erro desconhecido (com SQL, e-mail ou segredo) vira mensagem genérica", async () => {
    state.rpc = () => ({
      data: null,
      error: { message: 'update "memberships" set role=... falhou para owner-a.seed@praxis.test com sk_live_x' },
    });
    const result = await transferOwnershipAction(valid());
    expect(result).toEqual({ ok: false, error: "Não foi possível concluir a operação. Tente novamente." });
    expect(JSON.stringify(result)).not.toMatch(/memberships|praxis\.test|sk_live/);
  });
});
