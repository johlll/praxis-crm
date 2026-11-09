import { AutomationRuleCard } from "@/components/automations/rule-card";
import type { AutomationMemberOption } from "@/components/automations/rule-form-dialog";
import type { AutomationRule, AutomationStageOption } from "@/modules/automations/queries";
import { describeAction, describeTrigger } from "@/modules/automations/summary";

/**
 * Lista de regras. As frases são montadas aqui, no servidor, só com
 * configuração (nome de etapa e de pessoa da equipe); cada cartão recebe o
 * texto pronto.
 */
export function AutomationRuleList({
  rules,
  stages,
  members,
  canManage,
}: {
  rules: AutomationRule[];
  stages: AutomationStageOption[];
  members: AutomationMemberOption[];
  canManage: boolean;
}) {
  const stageName = (id: string | null) => (id ? (stages.find((stage) => stage.id === id)?.label ?? null) : null);
  const personName = (id: string | null) => (id ? (members.find((member) => member.userId === id)?.name ?? null) : null);

  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {rules.map((rule) => (
        <AutomationRuleCard
          key={rule.id}
          rule={rule}
          triggerText={describeTrigger(rule, stageName)}
          actionText={describeAction(rule, personName)}
          canManage={canManage}
          stages={stages}
          members={members}
        />
      ))}
    </ul>
  );
}
