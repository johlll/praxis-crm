/**
 * @vitest-environment node
 *
 * C1 — leitura das automações: só pelas RPCs; recusa de permissão vira `null`
 * (a página responde "não encontrado"); qualquer outra falha, ou linha fora do
 * formato, vira erro de carga (nunca lista vazia); nada de texto de erro do
 * banco sobe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  rpc: (() => ({ data: [], error: null })) as (fn: string, args: Record<string, unknown>) => Result,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  tables: {} as Record<string, Result>,
}));

function tableBuilder(table: string) {
  const settle = () => Promise.resolve(state.tables[table] ?? { data: [], error: null });
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

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return state.rpc(fn, args);
    },
    from: (table: string) => tableBuilder(table),
  }),
}));

const { AutomationLoadError, listAutomationExecutions, listAutomationRules, listAutomationStageOptions } = await import(
  "@/modules/automations/queries"
);
const { DataLoadError } = await import("@/server/data/load-error");

const WS = "10000000-0000-0000-0000-000000000001";
const ID = "70000000-0000-0000-0000-000000000001";
const ST = "60000000-0000-0000-0000-000000000001";

const ruleRow = (over: Record<string, unknown> = {}) => ({
  id: ID,
  name: "Regra",
  status: "active",
  trigger_type: "lead_created",
  cond_priority: "alta",
  cond_legal_area: null,
  cond_to_stage_id: null,
  cond_from_stage_id: null,
  action_title: "Retornar",
  action_due_days: 2,
  action_priority: "media",
  action_assignee_mode: "lead_owner",
  action_assignee_user_id: null,
  version: 3,
  simulation_current: true,
  simulated_at: "2026-11-10T11:00:00+00:00",
  simulated_count: 4,
  activated_at: "2026-11-10T11:05:00+00:00",
  created_at: "2026-11-10T10:00:00+00:00",
  updated_at: "2026-11-10T11:05:00+00:00",
  ...over,
});

const execRow = (over: Record<string, unknown> = {}) => ({
  id: ID,
  rule_id: ID,
  rule_name: "Regra",
  event_type: "lead_created",
  state: "pending",
  attempt_count: 1,
  last_attempt_at: "2026-11-10T12:00:00+00:00",
  next_attempt_at: "2026-11-10T12:01:00+00:00",
  error_code: "assignee_not_member",
  activity_id: null,
  created_at: "2026-11-10T11:59:00+00:00",
  finished_at: null,
  ...over,
});

beforeEach(() => {
  state.rpcCalls = [];
  state.tables = {};
  state.rpc = () => ({ data: [], error: null });
});

describe("listAutomationRules", () => {
  it("lê pela RPC do workspace informado e devolve as regras tipadas", async () => {
    state.rpc = () => ({ data: [ruleRow()], error: null });
    const rules = await listAutomationRules(WS);
    expect(state.rpcCalls).toEqual([{ fn: "list_automation_rules", args: { p_workspace_id: WS } }]);
    expect(rules).toHaveLength(1);
    expect(rules?.[0]).toMatchObject({
      id: ID,
      status: "active",
      trigger: "lead_created",
      condPriority: "alta",
      actionDueDays: 2,
      simulationCurrent: true,
      simulatedCount: 4,
      version: 3,
    });
  });

  it("lista vazia é lista vazia (não é ausência)", async () => {
    expect(await listAutomationRules(WS)).toEqual([]);
  });

  it("recusa de permissão (inclusive workspace alheio) vira null", async () => {
    state.rpc = () => ({ data: null, error: { message: "insufficient_permission" } });
    expect(await listAutomationRules(WS)).toBeNull();
  });

  it("qualquer outra falha é erro de carga, sem o texto do banco", async () => {
    state.rpc = () => ({ data: null, error: { message: 'relation "automation_rules" does not exist' } });
    const error = await listAutomationRules(WS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AutomationLoadError);
    expect(error).toBeInstanceOf(DataLoadError);
    expect((error as Error).message).not.toMatch(/relation|automation_rules/);
  });

  it("linha fora do formato é erro de carga, não regra pela metade", async () => {
    state.rpc = () => ({ data: [ruleRow({ status: "exploded" })], error: null });
    await expect(listAutomationRules(WS)).rejects.toBeInstanceOf(AutomationLoadError);
    state.rpc = () => ({ data: "não é lista", error: null });
    await expect(listAutomationRules(WS)).rejects.toBeInstanceOf(AutomationLoadError);
  });
});

describe("listAutomationExecutions", () => {
  it("lê o histórico com limite e mapeia os campos", async () => {
    state.rpc = () => ({ data: [execRow()], error: null });
    const items = await listAutomationExecutions(WS, 30);
    expect(state.rpcCalls).toEqual([{ fn: "list_automation_executions", args: { p_workspace_id: WS, p_limit: 30 } }]);
    expect(items?.[0]).toMatchObject({ state: "pending", attemptCount: 1, errorCode: "assignee_not_member", ruleName: "Regra" });
  });

  it("recusa de permissão vira null; outra falha, erro de carga", async () => {
    state.rpc = () => ({ data: null, error: { message: "insufficient_permission" } });
    expect(await listAutomationExecutions(WS)).toBeNull();
    state.rpc = () => ({ data: null, error: { message: "connection reset" } });
    await expect(listAutomationExecutions(WS)).rejects.toBeInstanceOf(AutomationLoadError);
  });

  it("um código de erro fora da lista nunca chega à tela como veio", async () => {
    state.rpc = () => ({ data: [execRow({ error_code: "SEGREDO sk_live_x maria@exemplo.com" })], error: null });
    const items = await listAutomationExecutions(WS);
    expect(items?.[0]?.errorCode).toBe("unexpected_error");
    expect(JSON.stringify(items)).not.toMatch(/SEGREDO|sk_live|maria/);
  });
});

describe("listAutomationStageOptions", () => {
  it("um pipeline só: o rótulo é o nome da etapa; etapas de ganho/perda ficam marcadas", async () => {
    state.tables.pipelines = { data: [{ id: "p1", name: "Comercial" }], error: null };
    state.tables.pipeline_stages = {
      data: [
        { id: ST, pipeline_id: "p1", name: "Qualificar", position: 1, is_won: false, is_lost: false },
        { id: "s0", pipeline_id: "p1", name: "Contato", position: 0, is_won: false, is_lost: false },
        { id: "s9", pipeline_id: "p1", name: "Ganho", position: 9, is_won: true, is_lost: false },
      ],
      error: null,
    };
    expect(await listAutomationStageOptions(WS)).toEqual([
      { id: "s0", label: "Contato", terminal: false },
      { id: ST, label: "Qualificar", terminal: false },
      { id: "s9", label: "Ganho", terminal: true },
    ]);
  });

  it("vários pipelines: o rótulo leva o nome do pipeline", async () => {
    state.tables.pipelines = {
      data: [
        { id: "p1", name: "Comercial" },
        { id: "p2", name: "Retenção" },
      ],
      error: null,
    };
    state.tables.pipeline_stages = {
      data: [
        { id: "b", pipeline_id: "p2", name: "Reativar", position: 0, is_won: false, is_lost: false },
        { id: "a", pipeline_id: "p1", name: "Contato", position: 0, is_won: false, is_lost: false },
      ],
      error: null,
    };
    expect((await listAutomationStageOptions(WS)).map((s) => s.label)).toEqual(["Comercial · Contato", "Retenção · Reativar"]);
  });

  it("falha de leitura é erro de carga", async () => {
    state.tables.pipelines = { data: null, error: { message: "boom" } };
    await expect(listAutomationStageOptions(WS)).rejects.toBeInstanceOf(AutomationLoadError);
  });
});
