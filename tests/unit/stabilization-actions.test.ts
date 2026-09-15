import { AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Estabilização pós-A9 — inventário §1.17, §1.18 e §3
 * (docs/decisoes/estabilizacao-pos-a9.md).
 *
 * - Falha operacional do Auth/membership não pode virar "sessão ausente"
 *   (login) nem "sem workspace" (onboarding).
 * - O helper de permissão das Server Actions devolve erro tratado também
 *   para falha de carregamento, não só para permissão negada.
 * - Actions sem canal de erro (equipe, contatos) passam a devolver o erro
 *   do RPC ao cliente, em vez de terminar em silêncio.
 */

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

const state = vi.hoisted(() => ({
  getUser: (() => ({ data: { user: { id: "u1" } }, error: null })) as () => { data: { user: unknown }; error: unknown },
  rpc: (() => ({ data: null, error: null })) as (fn: string) => RpcResult,
  membership: (() => ({ data: { id: "m1", role: "owner", workspace_id: "ws-1" }, error: null })) as () => RpcResult,
  signIn: (() => ({ error: null })) as () => { error: unknown },
  cookie: undefined as string | undefined,
  redirects: [] as string[],
}));

class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`);
  }
}

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

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    state.redirects.push(to);
    throw new RedirectSignal(to);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.cookie ? { value: state.cookie } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  }),
  headers: async () => new Headers({ host: "localhost:3000", "x-forwarded-proto": "http" }),
}));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    auth: {
      getUser: async () => state.getUser(),
      signInWithPassword: async () => state.signIn(),
    },
    rpc: async (fn: string) => state.rpc(fn),
    from: () => membershipBuilder(),
  }),
}));

const { createHmac } = await import("node:crypto");
const permissions = await import("@/server/authz/permissions");
const { requirePermissionSafe, PERMISSION_DENIED_MESSAGE } = await import("@/server/authz/safe");
const { DataLoadError, LOAD_ERROR_MESSAGE } = await import("@/server/data/load-error");
const team = await import("@/modules/team/actions");
const contacts = await import("@/modules/contacts/actions");
const auth = await import("@/modules/auth/actions");

const WS = "10000000-0000-0000-0000-000000000001";
function signedCookie(workspaceId: string) {
  const mac = createHmac("sha256", process.env.WORKSPACE_ACTIVE_COOKIE_SECRET!).update(workspaceId).digest("hex");
  return `${workspaceId}.${mac}`;
}
const operational = { message: "canceling statement due to statement timeout" };

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  state.getUser = () => ({ data: { user: { id: "u1" } }, error: null });
  state.rpc = () => ({ data: null, error: null });
  state.membership = () => ({ data: { id: "m1", role: "owner", workspace_id: WS }, error: null });
  state.signIn = () => ({ error: null });
  state.cookie = signedCookie(WS);
  state.redirects = [];
});

describe("requireUser e redirecionamentos (§1.17)", () => {
  it("falha de rede do Auth lança DataLoadError, não 'sessão ausente'", async () => {
    state.getUser = () => ({ data: { user: null }, error: new AuthRetryableFetchError("fetch failed", 0) });
    await expect(permissions.requireUser()).rejects.toBeInstanceOf(DataLoadError);
  });

  it("sessão ausente continua AuthzError 'unauthenticated'", async () => {
    state.getUser = () => ({ data: { user: null }, error: new AuthSessionMissingError() });
    await expect(permissions.requireUser()).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("requireUserOrRedirect não manda para /entrar numa falha de rede", async () => {
    state.getUser = () => ({ data: { user: null }, error: new AuthRetryableFetchError("fetch failed", 0) });
    await expect(permissions.requireUserOrRedirect()).rejects.toBeInstanceOf(DataLoadError);
    expect(state.redirects).toEqual([]);
  });

  it("requireMembershipOrRedirect não manda para /entrar nem /onboarding quando a membership falha", async () => {
    state.membership = () => ({ data: null, error: operational });
    await expect(permissions.requireMembershipOrRedirect()).rejects.toBeInstanceOf(DataLoadError);
    expect(state.redirects).toEqual([]);
  });

  it("sem membership ainda redireciona para /onboarding", async () => {
    state.cookie = undefined;
    await expect(permissions.requireMembershipOrRedirect()).rejects.toBeInstanceOf(RedirectSignal);
    expect(state.redirects).toEqual(["/onboarding"]);
  });

  it("signInAction: login certo mas membership falha → erro tratado, sem redirecionar", async () => {
    state.cookie = undefined;
    state.membership = () => ({ data: null, error: operational });
    const result = await auth.signInAction({ ok: false }, form({ email: "a@b.com", password: "senha-valida-123" }));
    expect(result).toEqual({ ok: false, error: LOAD_ERROR_MESSAGE });
    expect(state.redirects).toEqual([]);
  });
});

describe("requirePermissionSafe compartilhado (§1.18)", () => {
  it("permissão negada → mensagem de permissão", async () => {
    state.membership = () => ({ data: { id: "m1", role: "viewer", workspace_id: WS }, error: null });
    await expect(requirePermissionSafe("contact.edit")).resolves.toEqual({ error: PERMISSION_DENIED_MESSAGE });
  });

  it("falha ao carregar a membership → mensagem de carregamento, não exceção", async () => {
    let calls = 0;
    state.membership = () => {
      calls += 1;
      return calls === 1 ? { data: { workspace_id: WS }, error: null } : { data: null, error: operational };
    };
    await expect(requirePermissionSafe("contact.edit")).resolves.toEqual({ error: LOAD_ERROR_MESSAGE });
  });

  it("autorizado → devolve o contexto", async () => {
    await expect(requirePermissionSafe("contact.edit")).resolves.toMatchObject({ ctx: { role: "owner" } });
  });
});

describe("actions de equipe devolvem o erro do RPC (§3.1)", () => {
  it.each([
    ["cancelInvitationAction", () => team.cancelInvitationAction(form({ invitationId: "10000000-0000-4000-8000-000000000009" }))],
    [
      "updateMembershipRoleAction",
      () => team.updateMembershipRoleAction(form({ membershipId: "10000000-0000-4000-8000-000000000009", role: "viewer" })),
    ],
    ["removeMembershipAction", () => team.removeMembershipAction(form({ membershipId: "10000000-0000-4000-8000-000000000009" }))],
  ])("%s: recusa do banco chega ao cliente", async (_name, call) => {
    state.rpc = () => ({ data: null, error: { message: "last_owner" } });
    const result = await call();
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toBeTruthy();
  });

  it("permissão negada devolve erro em vez de lançar exceção", async () => {
    state.membership = () => ({ data: { id: "m1", role: "viewer", workspace_id: WS }, error: null });
    await expect(
      team.removeMembershipAction(form({ membershipId: "10000000-0000-4000-8000-000000000009" })),
    ).resolves.toEqual({ ok: false, error: PERMISSION_DENIED_MESSAGE });
    await expect(
      team.createInvitationAction({ ok: false }, form({ email: "novo@x.com", role: "viewer" })),
    ).resolves.toEqual({ ok: false, error: PERMISSION_DENIED_MESSAGE });
  });

  it("sucesso devolve ok", async () => {
    await expect(
      team.cancelInvitationAction(form({ invitationId: "10000000-0000-4000-8000-000000000009" })),
    ).resolves.toEqual({ ok: true });
  });
});

describe("actions de contato devolvem o erro do RPC (§3.2)", () => {
  const contactId = "10000000-0000-4000-8000-000000000001";
  const itemId = "10000000-0000-4000-8000-000000000002";

  it.each([
    ["addPhoneAction", () => contacts.addPhoneAction(form({ contactId, value: "+5511999990000" }))],
    ["updatePhoneAction", () => contacts.updatePhoneAction(form({ contactId, phoneId: itemId, value: "+5511999990001" }))],
    ["removePhoneAction", () => contacts.removePhoneAction(form({ contactId, phoneId: itemId }))],
    ["addEmailAction", () => contacts.addEmailAction(form({ contactId, value: "x@y.com" }))],
    ["updateEmailAction", () => contacts.updateEmailAction(form({ contactId, emailId: itemId, value: "z@y.com" }))],
    ["removeEmailAction", () => contacts.removeEmailAction(form({ contactId, emailId: itemId }))],
    ["clearCpfCnpjAction", () => contacts.clearCpfCnpjAction(form({ contactId }))],
    ["dismissDuplicateCandidateAction", () => contacts.dismissDuplicateCandidateAction(form({ candidateId: itemId }))],
  ])("%s: recusa do banco chega ao cliente", async (_name, call) => {
    state.rpc = () => ({ data: null, error: { message: "insufficient_permission" } });
    const result = await call();
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toBeTruthy();
  });

  it("sucesso devolve ok", async () => {
    await expect(contacts.removePhoneAction(form({ contactId, phoneId: itemId }))).resolves.toEqual({ ok: true });
  });
});
