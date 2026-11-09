/**
 * @vitest-environment node
 *
 * C1 — o que liga a operação de origem ao processamento:
 *  - `scheduleAutomationRun` é melhor esforço: roda depois da resposta, engole
 *    qualquer falha e só chama a RPC idempotente do workspace;
 *  - criar lead e mover etapa pedem a rodada DEPOIS do sucesso (e só nele) e
 *    nada do que ela faça pode alterar o resultado da operação original;
 *  - a rota de cron exige o segredo e devolve só contagens.
 * O evento em si é gravado pelo banco, na mesma transação da operação
 * (supabase/tests/database/47_c1_automacoes.test.sql).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  afterThrows: false,
  afterCallbacks: [] as Array<() => unknown>,
  rpc: (() => ({ data: null, error: null })) as (fn: string, args: Record<string, unknown>) => Result,
  rpcThrows: false,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));
const { revalidatePathMock, redirectMock, fetchMock } = vi.hoisted(() => ({
  revalidatePathMock: vi.fn(),
  redirectMock: vi.fn(),
  fetchMock: vi.fn(),
}));

const WS = "10000000-0000-0000-0000-000000000001";
const LEAD = "80000000-0000-0000-0000-000000000001";
const CONTACT = "40000000-0000-0000-0000-000000000001";
const OPP = "90000000-0000-0000-0000-000000000001";
const ST0 = "60000000-0000-0000-0000-000000000000";
const ST1 = "60000000-0000-0000-0000-000000000001";

vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    after: (callback: () => unknown) => {
      if (state.afterThrows) throw new Error("`after` was called outside a request scope");
      state.afterCallbacks.push(callback);
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      if (state.rpcThrows && fn === "process_automation_events") throw new Error("rede caiu: maria@exemplo.com");
      return state.rpc(fn, args);
    },
  }),
}));
vi.mock("@/server/authz/safe", () => ({
  PERMISSION_DENIED_MESSAGE: "Você não tem permissão para fazer isso.",
  requirePermissionSafe: async () => ({ ctx: { role: "owner", userId: "u1", workspaceId: WS, membershipId: "m1" } }),
}));
vi.stubGlobal("fetch", fetchMock);

const { scheduleAutomationRun } = await import("@/modules/automations/run");
const { createLeadAction } = await import("@/modules/leads/actions");
const { moveOpportunityStageAction } = await import("@/modules/opportunities/actions");

const flush = async () => {
  for (const callback of state.afterCallbacks.splice(0)) await callback();
};
const processCalls = () => state.rpcCalls.filter((call) => call.fn === "process_automation_events");

beforeEach(() => {
  vi.clearAllMocks();
  state.afterThrows = false;
  state.afterCallbacks = [];
  state.rpcThrows = false;
  state.rpcCalls = [];
  state.rpc = () => ({ data: null, error: null });
});

describe("scheduleAutomationRun", () => {
  it("não faz nada na hora: só registra a rodada para depois da resposta", () => {
    scheduleAutomationRun(WS);
    expect(state.rpcCalls).toEqual([]);
    expect(state.afterCallbacks).toHaveLength(1);
  });

  it("depois da resposta, pede a rodada do workspace (RPC idempotente) e mais nada", async () => {
    scheduleAutomationRun(WS);
    await flush();
    expect(state.rpcCalls).toEqual([{ fn: "process_automation_events", args: { p_workspace_id: WS, p_limit: 20 } }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falha da RPC (inclusive exceção) é engolida: nada sobe e nada vaza", async () => {
    state.rpcThrows = true;
    scheduleAutomationRun(WS);
    await expect(flush()).resolves.toBeUndefined();
  });

  it("sem suporte a `after` (fora de uma requisição) não lança", () => {
    state.afterThrows = true;
    expect(() => scheduleAutomationRun(WS)).not.toThrow();
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("criar lead", () => {
  const form = () => {
    const fd = new FormData();
    fd.set("contactId", CONTACT);
    fd.set("legalArea", "Trabalhista");
    fd.set("priority", "alta");
    return fd;
  };

  it("pede a rodada DEPOIS de criar (antes do redirecionamento) e o lead é criado como sempre", async () => {
    state.rpc = (fn) => ({ data: fn === "create_lead" ? LEAD : null, error: null });
    await createLeadAction({ ok: false }, form());
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(["create_lead"]);
    expect(state.afterCallbacks).toHaveLength(1);
    expect(redirectMock).toHaveBeenCalledWith(`/leads/${LEAD}`);
    // a ordem importa: `redirect` interrompe a função na prática, então o agendamento vem antes dele
    expect(state.afterCallbacks.length).toBe(1);
    await flush();
    expect(processCalls()).toHaveLength(1);
    expect(processCalls()[0]?.args).toEqual({ p_workspace_id: WS, p_limit: 20 });
  });

  it("lead recusado pelo banco NÃO pede rodada", async () => {
    state.rpc = () => ({ data: null, error: { message: "insufficient_permission" } });
    const result = await createLeadAction({ ok: false }, form());
    expect(result.ok).toBe(false);
    expect(state.afterCallbacks).toHaveLength(0);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("falha do processamento não muda o resultado da criação", async () => {
    state.rpc = (fn) => ({ data: fn === "create_lead" ? LEAD : null, error: null });
    state.rpcThrows = true;
    await createLeadAction({ ok: false }, form());
    await expect(flush()).resolves.toBeUndefined();
    expect(redirectMock).toHaveBeenCalledWith(`/leads/${LEAD}`);
  });

  it("mesmo sem `after` disponível, o lead é criado e o redirecionamento acontece", async () => {
    state.afterThrows = true;
    state.rpc = (fn) => ({ data: fn === "create_lead" ? LEAD : null, error: null });
    await createLeadAction({ ok: false }, form());
    expect(redirectMock).toHaveBeenCalledWith(`/leads/${LEAD}`);
  });
});

describe("mover de etapa", () => {
  const form = () => {
    const fd = new FormData();
    fd.set("opportunityId", OPP);
    fd.set("fromStageId", ST0);
    fd.set("toStageId", ST1);
    fd.set("lockVersion", "0");
    return fd;
  };

  it("pede a rodada depois do movimento bem-sucedido", async () => {
    const result = await moveOpportunityStageAction({ ok: false }, form());
    expect(result).toEqual({ ok: true, opportunityId: OPP });
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(["move_opportunity_stage"]);
    await flush();
    expect(processCalls()).toHaveLength(1);
  });

  it("movimento recusado (conflito, requisito pendente) NÃO pede rodada", async () => {
    state.rpc = () => ({ data: null, error: { message: "opportunity_conflict" } });
    const result = await moveOpportunityStageAction({ ok: false }, form());
    expect(result.ok).toBe(false);
    expect(state.afterCallbacks).toHaveLength(0);
  });

  it("falha do processamento não muda o resultado do movimento", async () => {
    state.rpcThrows = true;
    const result = await moveOpportunityStageAction({ ok: false }, form());
    await expect(flush()).resolves.toBeUndefined();
    expect(result).toEqual({ ok: true, opportunityId: OPP });
  });
});

describe("rota de cron das automações", () => {
  const SECRET = "segredo-de-cron-com-mais-de-16-caracteres";
  const adminRpc = vi.fn();
  const adminThrows = { value: false };

  vi.doMock("@/server/supabase/admin", () => ({
    createAdminSupabaseClient: () => {
      if (adminThrows.value) throw new Error("config ausente: SUPABASE_SECRET_KEY=sk_live_x");
      return { rpc: adminRpc };
    },
  }));

  const call = async (headers: Record<string, string> = {}, method: "POST" | "GET" = "POST") => {
    vi.resetModules();
    const route = await import("@/app/api/cron/automations/route");
    const request = new Request("http://localhost/api/cron/automations", { method, headers });
    return method === "GET" ? route.GET(request) : route.POST(request);
  };

  beforeEach(() => {
    adminRpc.mockReset();
    adminThrows.value = false;
    vi.stubEnv("CRON_SECRET", SECRET);
  });

  it("sem segredo ou com segredo errado: 401 e o banco não é tocado", async () => {
    expect((await call()).status).toBe(401);
    expect((await call({ authorization: "Bearer errado-errado-errado-errado" })).status).toBe(401);
    expect(adminRpc).not.toHaveBeenCalled();
  });

  it("sem CRON_SECRET configurado, recusa tudo (falha fechada)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call({ authorization: "Bearer " })).status).toBe(401);
    expect(adminRpc).not.toHaveBeenCalled();
  });

  it("com o segredo, roda a rodada do sistema e devolve só contagens", async () => {
    adminRpc.mockResolvedValue({ data: { events: 4, executions: 3, extra: "maria@exemplo.com" }, error: null });
    const response = await call({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: 4, executions: 3 });
    expect(adminRpc).toHaveBeenCalledWith("process_automation_events_system", { p_limit: 100 });
  });

  it("GET com o mesmo segredo funciona (agendadores que só chamam GET)", async () => {
    adminRpc.mockResolvedValue({ data: { events: 0, executions: 0 }, error: null });
    expect((await call({ authorization: `Bearer ${SECRET}` }, "GET")).status).toBe(200);
  });

  it("erro do banco ou configuração ausente: 503 com código fixo, sem texto interno", async () => {
    adminRpc.mockResolvedValue({ data: null, error: { message: "deadlock detected: tabela x" } });
    const failed = await call({ authorization: `Bearer ${SECRET}` });
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toMatch(/deadlock|tabela/);

    adminThrows.value = true;
    const noConfig = await call({ authorization: `Bearer ${SECRET}` });
    expect(noConfig.status).toBe(503);
    expect(JSON.stringify(await noConfig.json())).not.toMatch(/sk_live|SUPABASE_SECRET_KEY/);
  });
});
