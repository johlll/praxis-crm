import type { AutomationRule } from "./queries";
import { AUTOMATION_ASSIGNEE_MODE_LABEL } from "./schema";

/**
 * Frases da tela de Automações, em português claro, a partir da regra. Só
 * configuração (nomes de etapa e de pessoas da equipe): nenhum dado de lead.
 */

const PRIORITY_TEXT = { baixa: "baixa", media: "média", alta: "alta" } as const;

export type NameLookup = (id: string | null) => string | null;

const quote = (text: string) => `«${text}»`;

export function describeTrigger(rule: AutomationRule, stageName: NameLookup): string {
  if (rule.trigger === "lead_created") {
    const conditions: string[] = [];
    if (rule.condPriority) conditions.push(`prioridade ${PRIORITY_TEXT[rule.condPriority]}`);
    if (rule.condLegalArea) conditions.push(`área ${quote(rule.condLegalArea)}`);
    return conditions.length === 0
      ? "Quando um lead for criado"
      : `Quando um lead for criado com ${conditions.join(" e ")}`;
  }

  const to = stageName(rule.condToStageId);
  const base = to
    ? `Quando uma oportunidade entrar na etapa ${quote(to)}`
    : "Quando uma oportunidade entrar em uma etapa removida";
  if (!rule.condFromStageId) return base;
  const from = stageName(rule.condFromStageId);
  return from ? `${base}, vinda de ${quote(from)}` : `${base}, vinda de uma etapa removida`;
}

export function describeAction(rule: AutomationRule, personName: NameLookup): string {
  const days =
    rule.actionDueDays === 0 ? "para o mesmo dia" : `com prazo de ${rule.actionDueDays} dia${rule.actionDueDays === 1 ? "" : "s"}`;
  const assignee =
    rule.assigneeMode === "lead_owner"
      ? AUTOMATION_ASSIGNEE_MODE_LABEL.lead_owner.toLowerCase()
      : (personName(rule.assigneeUserId) ?? "pessoa não encontrada na equipe");
  return `Criar a atividade ${quote(rule.actionTitle)} ${days}, prioridade ${PRIORITY_TEXT[rule.actionPriority]}, responsável: ${assignee}`;
}
