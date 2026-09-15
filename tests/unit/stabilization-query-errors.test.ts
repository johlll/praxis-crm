import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Estabilização pós-A9 — inventário §1 (docs/decisoes/estabilizacao-pos-a9.md).
 *
 * Cada consulta recebe uma falha OPERACIONAL simulada (o cliente Supabase
 * devolve `error` preenchido) e precisa lançar DataLoadError — nunca devolver
 * null, lista vazia, contagem zero ou "sem acesso". As que têm ausência
 * legítima também são testadas com o código de ausência da própria RPC,
 * que continua virando null.
 */

type Result = { data: unknown; error: { message: string } | null; count?: number | null };

const state = vi.hoisted(() => ({
  rpc: (() => ({ data: null, error: null })) as (fn: string, args: unknown) => Result,
  table: (() => ({ data: null, error: null })) as (table: string) => Result,
  cookie: undefined as string | undefined,
}));

function queryBuilder(table: string) {
  const settle = () => Promise.resolve(state.table(table));
  const builder: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return (resolve: (v: Result) => unknown, reject: (e: unknown) => unknown) => settle().then(resolve, reject);
        if (prop === "maybeSingle" || prop === "single") return settle;
        return () => builder;
      },
    },
  );
  return builder;
}

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    rpc: async (fn: string, args: unknown) => state.rpc(fn, args),
    from: (table: string) => queryBuilder(table),
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.cookie ? { value: state.cookie } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { DataLoadError } = await import("@/server/data/load-error");
const opportunities = await import("@/modules/opportunities/queries");
const activities = await import("@/modules/activities/queries");
const leads = await import("@/modules/leads/queries");
const conversations = await import("@/modules/conversations/queries");
const contacts = await import("@/modules/contacts/queries");
const team = await import("@/modules/team/queries");
const workspace = await import("@/modules/workspace/queries");
const authWorkspace = await import("@/server/auth/workspace");
const permissions = await import("@/server/authz/permissions");

const operational = { message: "canceling statement due to statement timeout" };
const WS = "10000000-0000-0000-0000-000000000001";

function failEverything() {
  state.rpc = () => ({ data: null, error: operational });
  state.table = () => ({ data: null, error: operational, count: null });
}

function signedCookie(workspaceId: string) {
  const mac = createHmac("sha256", process.env.WORKSPACE_ACTIVE_COOKIE_SECRET!).update(workspaceId).digest("hex");
  return `${workspaceId}.${mac}`;
}

beforeEach(() => {
  state.rpc = () => ({ data: null, error: null });
  state.table = () => ({ data: [], error: null, count: 0 });
  state.cookie = undefined;
});

const operationalCases: Array<[string, () => Promise<unknown>]> = [
  ["getOpportunity", () => opportunities.getOpportunity("o1")],
  ["listOpportunities", () => opportunities.listOpportunities(WS, { leadId: "l1" })],
  ["getPipelineBoard", () => opportunities.getPipelineBoard("p1")],
  ["getStageRequirementsStatus", () => opportunities.getStageRequirementsStatus("o1", "s2")],
  ["getWinRequirementsStatus", () => opportunities.getWinRequirementsStatus("o1")],
  ["listPipelines", () => opportunities.listPipelines(WS)],
  ["getDefaultPipeline", () => opportunities.getDefaultPipeline(WS)],
  ["listPipelineStages", () => opportunities.listPipelineStages("p1")],
  ["listPipelineStagesWithDetails", () => opportunities.listPipelineStagesWithDetails("p1")],
  ["listLostReasons", () => opportunities.listLostReasons(WS)],
  ["listActivities", () => activities.listActivities(WS, { opportunityId: "o1", status: "pending" })],
  ["getActivity", () => activities.getActivity("a1")],
  ["getActivityCounts", () => activities.getActivityCounts(WS)],
  ["listLeads", () => leads.listLeads(WS)],
  ["listContactOptions", () => leads.listContactOptions(WS)],
  ["getLeadDetail", () => leads.getLeadDetail("l1")],
  ["getConversation", () => conversations.getConversation("c1")],
  ["listWhatsAppChannels", () => conversations.listWhatsAppChannels(WS)],
  ["listContactConsents", () => conversations.listContactConsents("ct1")],
  ["listContacts", () => contacts.listContacts(WS)],
  ["getContactDetail", () => contacts.getContactDetail("ct1")],
  ["getDuplicateCandidateDetail", () => contacts.getDuplicateCandidateDetail("d1")],
  ["listContactMergeHistory", () => contacts.listContactMergeHistory("ct1")],
  ["listPendingDuplicateCandidates", () => contacts.listPendingDuplicateCandidates(WS)],
  ["searchContactsByCpfCnpj", () => contacts.searchContactsByCpfCnpj(WS, "22222222222")],
  ["listTeamMembers", () => team.listTeamMembers(WS, "u1")],
  ["listPendingInvitations", () => team.listPendingInvitations(WS)],
  ["listMyWorkspaces", () => workspace.listMyWorkspaces()],
];

describe("falha operacional nunca vira vazio/nulo", () => {
  it.each(operationalCases)("%s lança DataLoadError", async (_name, call) => {
    failEverything();
    await expect(call()).rejects.toBeInstanceOf(DataLoadError);
  });

  it("DataLoadError não carrega o texto do banco na mensagem", async () => {
    failEverything();
    const error = await opportunities.getOpportunity("o1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataLoadError);
    expect((error as Error).message).not.toContain(operational.message);
    expect((error as Error & { cause?: unknown }).cause).toEqual(operational);
  });
});

describe("falha em consulta secundária também não é engolida", () => {
  it("listPipelineStagesWithDetails: etapas carregam, requisitos falham", async () => {
    state.table = (table) =>
      table === "pipeline_stages"
        ? { data: [{ id: "s1", pipeline_id: "p1", name: "Etapa", position: 1, color: null, is_won: false, is_lost: false }], error: null }
        : { data: null, error: operational };
    await expect(opportunities.listPipelineStagesWithDetails("p1")).rejects.toBeInstanceOf(DataLoadError);
  });

  it("getContactDetail: contato carrega, telefones falham", async () => {
    state.table = (table) =>
      table === "contacts"
        ? { data: { id: "ct1", workspace_id: WS, name: "X", type: "pf", city: null, uf: null, preferred_channel: null, created_at: "2026-09-01" }, error: null }
        : { data: null, error: operational };
    state.rpc = () => ({ data: false, error: null });
    await expect(contacts.getContactDetail("ct1")).rejects.toBeInstanceOf(DataLoadError);
  });
});

describe("ausência legítima continua null", () => {
  it.each([
    ["getOpportunity", "opportunity_not_found", () => opportunities.getOpportunity("o1")],
    ["getOpportunity", "insufficient_permission", () => opportunities.getOpportunity("o1")],
    ["getLeadDetail", "lead_not_found", () => leads.getLeadDetail("l1")],
    ["getLeadDetail", "insufficient_permission", () => leads.getLeadDetail("l1")],
    ["getConversation", "conversation_not_found", () => conversations.getConversation("c1")],
    ["getActivity", "activity_not_found", () => activities.getActivity("a1")],
    ["getStageRequirementsStatus", "opportunity_not_found", () => opportunities.getStageRequirementsStatus("o1", "s2")],
    ["getWinRequirementsStatus", "opportunity_not_found", () => opportunities.getWinRequirementsStatus("o1")],
  ] as const)("%s com %s devolve null", async (_name, code, call) => {
    state.rpc = () => ({ data: null, error: { message: code } });
    await expect(call()).resolves.toBeNull();
  });

  it("getContactDetail sem linha visível (RLS) devolve null", async () => {
    state.table = () => ({ data: null, error: null });
    await expect(contacts.getContactDetail("ct1")).resolves.toBeNull();
  });

  it("getDefaultPipeline sem pipeline padrão devolve null", async () => {
    state.table = () => ({ data: null, error: null });
    await expect(opportunities.getDefaultPipeline(WS)).resolves.toBeNull();
  });
});

describe("membership: falha operacional não vira 'sem workspace' nem 'não é membro'", () => {
  it("getActiveWorkspaceId lança DataLoadError quando a consulta de membership falha", async () => {
    state.cookie = signedCookie(WS);
    failEverything();
    await expect(authWorkspace.getActiveWorkspaceId()).rejects.toBeInstanceOf(DataLoadError);
  });

  it("getActiveWorkspaceId sem membership devolve null", async () => {
    state.cookie = signedCookie(WS);
    state.table = () => ({ data: null, error: null });
    await expect(authWorkspace.getActiveWorkspaceId()).resolves.toBeNull();
  });

  it("switchActiveWorkspace lança DataLoadError quando a consulta falha", async () => {
    failEverything();
    await expect(authWorkspace.switchActiveWorkspace(WS)).rejects.toBeInstanceOf(DataLoadError);
  });

  it("requireMembership lança DataLoadError (não AuthzError) quando a consulta falha", async () => {
    state.cookie = signedCookie(WS);
    let membershipCalls = 0;
    state.table = () => {
      membershipCalls += 1;
      // 1ª: getActiveWorkspaceId confirma a membership; 2ª: requireMembership falha.
      return membershipCalls === 1 ? { data: { workspace_id: WS }, error: null } : { data: null, error: operational };
    };
    await expect(permissions.requireMembership()).rejects.toBeInstanceOf(DataLoadError);
  });
});
