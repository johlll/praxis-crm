/**
 * @vitest-environment node
 *
 * C1 — Server Actions das automações: só owner/admin (matriz real); o
 * workspace é o da sessão, nunca o do formulário; entrada inválida não chama o
 * banco; recusas do banco viram mensagens sanitizadas; nenhuma chamada externa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  role: "owner" as string,
  rpc: (() => ({ data: null, error: null })) as (fn: string, args: Record<string, unknown>) => Result,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));
const { revalidatePathMock, fetchMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn(), fetchMock: vi.fn() }));

const WS = "10000000-0000-0000-0000-000000000001";
const OTHER_WS = "10000000-0000-0000-0000-000000000002";
const RULE = "70000000-0000-0000-0000-000000000001";
const ST1 = "60000000-0000-0000-0000-000000000001";
const BRUNO = "20000000-0000-0000-0000-000000000002";

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return state.rpc(fn, args);
    },
  }),
}));
vi.mock("@/server/authz/safe", async () => {
  const roles: { roleHasPermission: (role: string, permission: string) => boolean } = await vi.importActual("@/lib/roles");
  return {
    PERMISSION_DENIED_MESSAGE: "Você não tem permissão para fazer isso.",
    requirePermissionSafe: async (permission: string) =>
      roles.roleHasPermission(state.role, permission)
        ? { ctx: { role: state.role, userId: "u1", workspaceId: WS, membershipId: "m1" } }
        : { error: "Você não tem permissão para fazer isso." },
  };
});

vi.stubGlobal("fetch", fetchMock);

const { processAutomationsAction, saveAutomationRuleAction, setAutomationRuleStatusAction, simulateAutomationRuleAction } =
  await import("@/modules/automations/actions");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}
const valid = {
  name: "Retorno",
  trigger: "lead_created",
  condPriority: "alta",
  actionTitle: "Retornar o contato",
  actionDueDays: "2",
  actionPriority: "alta",
  assigneeMode: "lead_owner",
};

beforeEach(() => {
  vi.clearAllMocks();
  state.role = "owner";
  state.rpcCalls = [];
  state.rpc = () => ({ data: null, error: null });
});

describe("papéis", () => {
  it.each(["owner", "admin"])("%s gerencia", async (role) => {
    state.role = role;
    state.rpc = () => ({ data: RULE, error: null });
    expect(await saveAutomationRuleAction(form(valid))).toEqual({ ok: true, ruleId: RULE });
  });

  it.each(["manager", "lawyer", "sales", "viewer"])("%s é recusado em TODAS as ações, sem tocar no banco", async (role) => {
    state.role = role;
    const denied = { ok: false, error: "Você não tem permissão para fazer isso." };
    expect(await saveAutomationRuleAction(form(valid))).toEqual(denied);
    expect(await simulateAutomationRuleAction(RULE)).toEqual(denied);
    expect(await setAutomationRuleStatusAction(RULE, "active")).toEqual(denied);
    expect(await processAutomationsAction()).toEqual(denied);
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("criar e editar", () => {
  it("cria no workspace da SESSÃO (um workspace vindo do formulário é ignorado)", async () => {
    state.rpc = () => ({ data: RULE, error: null });
    await saveAutomationRuleAction(form({ ...valid, workspaceId: OTHER_WS, workspace_id: OTHER_WS }));
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toEqual({
      fn: "create_automation_rule",
      args: {
        p_workspace_id: WS,
        p_name: "Retorno",
        p_trigger_type: "lead_created",
        p_action_title: "Retornar o contato",
        p_action_due_days: 2,
        p_action_priority: "alta",
        p_action_assignee_mode: "lead_owner",
        p_cond_priority: "alta",
      },
    });
    expect(JSON.stringify(state.rpcCalls)).not.toContain(OTHER_WS);
    expect(revalidatePathMock).toHaveBeenCalledWith("/automacoes");
  });

  it("com ruleId, edita (e não envia workspace)", async () => {
    await saveAutomationRuleAction(form({ ...valid, ruleId: RULE, condPriority: "" }));
    expect(state.rpcCalls[0]?.fn).toBe("update_automation_rule");
    expect(state.rpcCalls[0]?.args).toMatchObject({ p_rule_id: RULE, p_name: "Retorno" });
    expect(state.rpcCalls[0]?.args).not.toHaveProperty("p_workspace_id");
    expect(state.rpcCalls[0]?.args).not.toHaveProperty("p_cond_priority");
  });

  it("gatilho de etapa com pessoa específica", async () => {
    state.rpc = () => ({ data: RULE, error: null });
    await saveAutomationRuleAction(
      form({
        name: "Etapa",
        trigger: "opportunity_stage_changed",
        condToStageId: ST1,
        actionTitle: "Preparar",
        actionDueDays: "0",
        actionPriority: "media",
        assigneeMode: "user",
        assigneeUserId: BRUNO,
      }),
    );
    expect(state.rpcCalls[0]?.args).toMatchObject({
      p_trigger_type: "opportunity_stage_changed",
      p_cond_to_stage_id: ST1,
      p_action_assignee_mode: "user",
      p_action_assignee_user_id: BRUNO,
      p_action_due_days: 0,
    });
  });

  it.each([
    [{ name: "" }, "Informe o nome da regra."],
    [{ actionTitle: "" }, "Informe o título da atividade."],
    [{ actionDueDays: "99" }, "O prazo máximo é de 90 dias."],
    [{ trigger: "opportunity_stage_changed", condPriority: "" }, "Escolha a etapa de destino."],
  ])("entrada inválida (%j) volta com mensagem clara e sem chamar o banco", async (over, message) => {
    expect(await saveAutomationRuleAction(form({ ...valid, ...over }))).toEqual({ ok: false, error: message });
    expect(state.rpcCalls).toEqual([]);
  });

  it.each([
    ["invalid_automation_stage", "Escolha uma etapa válida deste workspace (não vale etapa de ganho ou perda)."],
    ["invalid_automation_assignee", "Escolha uma pessoa ativa deste workspace como responsável."],
    ["automation_rule_archived", "Esta regra está arquivada e não pode mais ser alterada."],
    ["automation_rule_not_found", "Regra não encontrada."],
  ])("recusa do banco %s vira mensagem sanitizada", async (code, message) => {
    state.rpc = () => ({ data: null, error: { message: code } });
    expect(await saveAutomationRuleAction(form({ ...valid, ruleId: RULE }))).toEqual({ ok: false, error: message });
  });

  it("erro desconhecido do banco vira mensagem genérica, sem o texto original", async () => {
    state.rpc = () => ({ data: null, error: { message: 'insert into "automation_rules" ... maria@exemplo.com' } });
    const result = await saveAutomationRuleAction(form(valid));
    expect(result).toEqual({ ok: false, error: "Não foi possível concluir a operação. Tente novamente." });
  });
});

describe("simular", () => {
  const sim = {
    version: 2,
    window_days: 30,
    match_count: 5,
    sample: [{ date: "2026-11-09", priority: "alta", legal_area: "Trabalhista", due_date: "2026-11-11", assignee: "ok" }],
    sample_invalid: 0,
  };

  it("devolve a simulação validada", async () => {
    state.rpc = () => ({ data: sim, error: null });
    expect(await simulateAutomationRuleAction(RULE)).toEqual({ ok: true, simulation: sim });
    expect(state.rpcCalls).toEqual([{ fn: "simulate_automation_rule", args: { p_rule_id: RULE } }]);
  });

  it("id inválido não chama o banco; resposta fora do formato não vaza", async () => {
    expect(await simulateAutomationRuleAction("não-é-uuid")).toEqual({ ok: false, error: "Regra não encontrada." });
    expect(state.rpcCalls).toEqual([]);
    state.rpc = () => ({ data: { match_count: "muitos", conteudo: "maria" }, error: null });
    const result = await simulateAutomationRuleAction(RULE);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("maria");
  });

  it("regra de outro workspace responde como não encontrada", async () => {
    state.rpc = () => ({ data: null, error: { message: "automation_rule_not_found" } });
    expect(await simulateAutomationRuleAction(RULE)).toEqual({ ok: false, error: "Regra não encontrada." });
  });
});

describe("estado da regra", () => {
  it.each(["active", "paused", "archived"] as const)("aplica %s pela RPC", async (status) => {
    expect(await setAutomationRuleStatusAction(RULE, status)).toEqual({ ok: true });
    expect(state.rpcCalls).toEqual([{ fn: "set_automation_rule_status", args: { p_rule_id: RULE, p_status: status } }]);
  });

  it("ativar sem simulação atual vem recusado pelo banco, com a mensagem certa", async () => {
    state.rpc = () => ({ data: null, error: { message: "automation_simulation_required" } });
    expect(await setAutomationRuleStatusAction(RULE, "active")).toEqual({
      ok: false,
      error: "Simule a regra (versão atual) antes de ativá-la.",
    });
  });

  it("estado fora da lista e id inválido não chegam ao banco", async () => {
    expect(await setAutomationRuleStatusAction(RULE, "draft" as never)).toEqual({ ok: false, error: "Dados inválidos." });
    expect(await setAutomationRuleStatusAction("x", "active")).toEqual({ ok: false, error: "Dados inválidos." });
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("processar agora", () => {
  it("roda a rodada do workspace da sessão e devolve só contagens", async () => {
    state.rpc = () => ({ data: { events: 3, executions: 2 }, error: null });
    expect(await processAutomationsAction()).toEqual({ ok: true, events: 3, executions: 2 });
    expect(state.rpcCalls).toEqual([{ fn: "process_automation_events", args: { p_workspace_id: WS, p_limit: 50 } }]);
    expect(revalidatePathMock).toHaveBeenCalledWith("/atividades");
  });

  it("falha do banco vira mensagem genérica", async () => {
    state.rpc = () => ({ data: null, error: { message: "deadlock detected" } });
    expect(await processAutomationsAction()).toEqual({
      ok: false,
      error: "Não foi possível concluir a operação. Tente novamente.",
    });
  });
});

it("nenhuma ação faz chamada externa (só RPC do banco)", async () => {
  state.rpc = () => ({ data: RULE, error: null });
  await saveAutomationRuleAction(form(valid));
  await simulateAutomationRuleAction(RULE);
  await setAutomationRuleStatusAction(RULE, "paused");
  await processAutomationsAction();
  expect(fetchMock).not.toHaveBeenCalled();
});
