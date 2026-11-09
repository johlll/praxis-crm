/**
 * @vitest-environment node
 *
 * C1 — estrutura fechada da regra: o que o formulário aceita, os parâmetros
 * enviados ao banco, as linhas que voltam (sem texto livre de erro) e as
 * frases da tela. As regras de verdade estão no banco
 * (supabase/tests/database/47_c1_automacoes.test.sql).
 */
import { describe, expect, it } from "vitest";

import { ROLES, roleHasPermission } from "@/lib/roles";
import {
  AUTOMATION_ERROR_CODES,
  AUTOMATION_ERROR_LABEL,
  automationErrorLabel,
  automationExecutionRowSchema,
  automationRuleFormSchema,
  automationSimulationSchema,
  ruleRpcArgs,
} from "@/modules/automations/schema";
import { describeAction, describeTrigger } from "@/modules/automations/summary";
import type { AutomationRule } from "@/modules/automations/queries";

const ST1 = "60000000-0000-0000-0000-000000000001";
const ST2 = "60000000-0000-0000-0000-000000000002";
const BRUNO = "20000000-0000-0000-0000-000000000002";

const leadForm = {
  name: "Retorno de alta prioridade",
  trigger: "lead_created",
  condPriority: "alta",
  condLegalArea: "Trabalhista",
  actionTitle: "Retornar o contato",
  actionDueDays: "2",
  actionPriority: "alta",
  assigneeMode: "lead_owner",
};
const stageForm = {
  name: "Preparar",
  trigger: "opportunity_stage_changed",
  condToStageId: ST1,
  actionTitle: "Preparar a qualificação",
  actionDueDays: "0",
  actionPriority: "media",
  assigneeMode: "user",
  assigneeUserId: BRUNO,
};

describe("formulário da regra", () => {
  it("aceita a regra de lead criado e a de mudança de etapa", () => {
    const lead = automationRuleFormSchema.safeParse(leadForm);
    expect(lead.success).toBe(true);
    const stage = automationRuleFormSchema.safeParse(stageForm);
    expect(stage.success).toBe(true);
    if (stage.success) expect(stage.data.actionDueDays).toBe(0);
  });

  it("campos vazios viram 'ausente' (nunca texto vazio nem zero)", () => {
    const parsed = automationRuleFormSchema.parse({
      ...leadForm,
      ruleId: "",
      condPriority: "",
      condLegalArea: "",
      condToStageId: "",
      assigneeUserId: "",
    });
    expect(parsed.ruleId).toBeUndefined();
    expect(parsed.condPriority).toBeUndefined();
    expect(parsed.condLegalArea).toBeUndefined();
    expect(ruleRpcArgs(parsed)).not.toHaveProperty("p_cond_priority");
    expect(ruleRpcArgs(parsed)).not.toHaveProperty("p_cond_legal_area");
  });

  it.each([
    ["gatilho fora da lista", { trigger: "delete_everything" }],
    ["gatilho vazio", { trigger: "" }],
    ["nome em branco", { name: "   " }],
    ["título em branco", { actionTitle: "" }],
    ["prazo vazio (não vira zero)", { actionDueDays: "" }],
    ["prazo negativo", { actionDueDays: "-1" }],
    ["prazo acima de 90", { actionDueDays: "91" }],
    ["prazo com texto", { actionDueDays: "2 dias" }],
    ["prioridade fora da lista", { actionPriority: "urgente" }],
    ["modo de responsável fora da lista", { assigneeMode: "qualquer" }],
    ["condição de prioridade fora da lista", { condPriority: "critica" }],
    ["etapa de destino não é uuid", { trigger: "opportunity_stage_changed", condPriority: "", condLegalArea: "", condToStageId: "abc" }],
  ])("recusa: %s", (_nome, over) => {
    expect(automationRuleFormSchema.safeParse({ ...leadForm, ...over }).success).toBe(false);
  });

  it("recusa combinações que o gatilho não admite", () => {
    // Lead criado com condição de etapa.
    expect(automationRuleFormSchema.safeParse({ ...leadForm, condToStageId: ST1 }).success).toBe(false);
    // Etapa sem etapa de destino.
    expect(automationRuleFormSchema.safeParse({ ...stageForm, condToStageId: "" }).success).toBe(false);
    // Etapa com prioridade/área (condições do outro gatilho).
    expect(automationRuleFormSchema.safeParse({ ...stageForm, condPriority: "alta" }).success).toBe(false);
    expect(automationRuleFormSchema.safeParse({ ...stageForm, condLegalArea: "Cível" }).success).toBe(false);
    // Pessoa específica sem pessoa; responsável do lead com pessoa.
    expect(automationRuleFormSchema.safeParse({ ...stageForm, assigneeUserId: "" }).success).toBe(false);
    expect(automationRuleFormSchema.safeParse({ ...leadForm, assigneeUserId: BRUNO }).success).toBe(false);
  });

  it("não há campo para SQL, expressão ou código: campos extras são descartados", () => {
    const parsed = automationRuleFormSchema.parse({
      ...leadForm,
      where: "1=1; drop table leads",
      expression: "process.exit(1)",
      sql: "delete from leads",
    });
    expect(Object.keys(parsed).sort()).toEqual(
      ["actionDueDays", "actionPriority", "actionTitle", "assigneeMode", "condLegalArea", "condPriority", "name", "trigger"].sort(),
    );
    expect(JSON.stringify(ruleRpcArgs(parsed))).not.toMatch(/drop table|process\.exit|delete from/);
  });

  it("os parâmetros da RPC levam só o que foi preenchido", () => {
    const args = ruleRpcArgs(automationRuleFormSchema.parse(stageForm));
    expect(args).toEqual({
      p_name: "Preparar",
      p_trigger_type: "opportunity_stage_changed",
      p_action_title: "Preparar a qualificação",
      p_action_due_days: 0,
      p_action_priority: "media",
      p_action_assignee_mode: "user",
      p_action_assignee_user_id: BRUNO,
      p_cond_to_stage_id: ST1,
    });
  });
});

describe("códigos de erro e linhas do histórico", () => {
  const row = {
    id: ST1,
    rule_id: ST2,
    rule_name: "Regra",
    event_type: "lead_created",
    state: "dead_letter",
    attempt_count: 4,
    last_attempt_at: "2026-11-10T12:00:00+00:00",
    next_attempt_at: null,
    error_code: "assignee_not_member",
    activity_id: null,
    created_at: "2026-11-10T11:00:00+00:00",
    finished_at: "2026-11-10T12:00:00+00:00",
  };

  it("todo código tem texto próprio", () => {
    for (const code of AUTOMATION_ERROR_CODES) {
      expect(AUTOMATION_ERROR_LABEL[code].length).toBeGreaterThan(10);
      expect(automationErrorLabel(code)).toBe(AUTOMATION_ERROR_LABEL[code]);
    }
    expect(automationErrorLabel(null)).toBeNull();
  });

  it("texto livre NUNCA passa como código: vira o código genérico", () => {
    const hostile = "relation \"leads\" violates ... maria@exemplo.com sk_live_123";
    const parsed = automationExecutionRowSchema.parse({ ...row, error_code: hostile });
    expect(parsed.error_code).toBe("unexpected_error");
    expect(automationErrorLabel(hostile)).toBe(AUTOMATION_ERROR_LABEL.unexpected_error);
    expect(JSON.stringify(parsed)).not.toMatch(/maria|sk_live|violates/);
  });

  it("código nulo continua nulo e código válido é mantido", () => {
    expect(automationExecutionRowSchema.parse({ ...row, error_code: null }).error_code).toBeNull();
    expect(automationExecutionRowSchema.parse(row).error_code).toBe("assignee_not_member");
  });

  it("linha com estado desconhecido é recusada (formato inesperado)", () => {
    expect(automationExecutionRowSchema.safeParse({ ...row, state: "exploded" }).success).toBe(false);
  });
});

describe("simulação", () => {
  it("só aceita a forma sem identificação", () => {
    const ok = automationSimulationSchema.safeParse({
      version: 1,
      window_days: 30,
      match_count: 3,
      sample: [{ date: "2026-11-09", priority: "alta", legal_area: "Trabalhista", due_date: "2026-11-11", assignee: "ok" }],
      sample_invalid: 0,
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      // Chaves extras (um dado pessoal que alguém tentasse devolver) não passam adiante.
      const withPii = automationSimulationSchema.parse({
        version: 1,
        window_days: 30,
        match_count: 1,
        sample: [{ date: "2026-11-09", priority: "alta", legal_area: null, due_date: "2026-11-11", assignee: "ok", name: "Maria", phone: "+5511" }],
        sample_invalid: 0,
      });
      expect(JSON.stringify(withPii)).not.toMatch(/Maria|\+5511|phone|name/);
    }
  });
});

describe("frases da tela", () => {
  const base: AutomationRule = {
    id: ST1,
    name: "Regra",
    status: "draft",
    trigger: "lead_created",
    condPriority: null,
    condLegalArea: null,
    condToStageId: null,
    condFromStageId: null,
    actionTitle: "Retornar o contato",
    actionDueDays: 2,
    actionPriority: "alta",
    assigneeMode: "lead_owner",
    assigneeUserId: null,
    version: 1,
    simulationCurrent: false,
    simulatedAt: null,
    simulatedCount: null,
    activatedAt: null,
    createdAt: "2026-11-10T11:00:00+00:00",
    updatedAt: "2026-11-10T11:00:00+00:00",
  };
  const stages = new Map([[ST1, "Qualificar oportunidade"], [ST2, "Fazer primeiro contato"]]);
  const stageName = (id: string | null) => (id ? (stages.get(id) ?? null) : null);
  const personName = (id: string | null) => (id === BRUNO ? "Bruno" : null);

  it("lead criado, sem e com condições", () => {
    expect(describeTrigger(base, stageName)).toBe("Quando um lead for criado");
    expect(describeTrigger({ ...base, condPriority: "alta", condLegalArea: "Trabalhista" }, stageName)).toBe(
      "Quando um lead for criado com prioridade alta e área «Trabalhista»",
    );
  });

  it("mudança de etapa, com e sem origem, e etapa removida", () => {
    const stage = { ...base, trigger: "opportunity_stage_changed" as const, condToStageId: ST1 };
    expect(describeTrigger(stage, stageName)).toBe("Quando uma oportunidade entrar na etapa «Qualificar oportunidade»");
    expect(describeTrigger({ ...stage, condFromStageId: ST2 }, stageName)).toBe(
      "Quando uma oportunidade entrar na etapa «Qualificar oportunidade», vinda de «Fazer primeiro contato»",
    );
    expect(describeTrigger({ ...stage, condToStageId: "x" }, stageName)).toBe("Quando uma oportunidade entrar em uma etapa removida");
  });

  it("ação: prazo, prioridade e responsável", () => {
    expect(describeAction(base, personName)).toBe(
      "Criar a atividade «Retornar o contato» com prazo de 2 dias, prioridade alta, responsável: responsável atual do lead",
    );
    expect(describeAction({ ...base, actionDueDays: 0, actionPriority: "media", assigneeMode: "user", assigneeUserId: BRUNO }, personName)).toBe(
      "Criar a atividade «Retornar o contato» para o mesmo dia, prioridade média, responsável: Bruno",
    );
    expect(describeAction({ ...base, actionDueDays: 1, assigneeMode: "user", assigneeUserId: "z" }, personName)).toContain(
      "com prazo de 1 dia,",
    );
    expect(describeAction({ ...base, assigneeMode: "user", assigneeUserId: "z" }, personName)).toContain("pessoa não encontrada na equipe");
  });
});

describe("permissões da C1", () => {
  it("gerenciar: só owner e admin; consultar: também manager; os demais, nada", () => {
    expect(ROLES.filter((role) => roleHasPermission(role, "automation.manage"))).toEqual(["owner", "admin"]);
    expect(ROLES.filter((role) => roleHasPermission(role, "automation.view"))).toEqual(["owner", "admin", "manager"]);
  });

  it("nenhuma permissão existente mudou", () => {
    expect(ROLES.filter((r) => roleHasPermission(r, "audit_log.view"))).toEqual(["owner", "admin"]);
    expect(ROLES.filter((r) => roleHasPermission(r, "activity.configure"))).toEqual(["owner", "admin", "manager"]);
    expect(ROLES.filter((r) => roleHasPermission(r, "lead.edit"))).toEqual(["owner", "admin", "manager", "lawyer", "sales"]);
    expect(ROLES.filter((r) => roleHasPermission(r, "workspace.transfer_ownership"))).toEqual(["owner"]);
    expect(ROLES.filter((r) => roleHasPermission(r, "form_endpoint.manage"))).toEqual(["owner", "admin"]);
  });
});
