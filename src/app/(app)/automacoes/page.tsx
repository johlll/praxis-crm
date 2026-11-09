import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { History, Zap } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { AutomationExecutionHistory } from "@/components/automations/execution-history";
import { ProcessNowButton } from "@/components/automations/process-now-button";
import { AutomationRuleFormDialog } from "@/components/automations/rule-form-dialog";
import { AutomationRuleList } from "@/components/automations/rule-list";
import { EmptyState } from "@/components/feedback/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  listAutomationExecutions,
  listAutomationRules,
  listAutomationStageOptions,
} from "@/modules/automations/queries";
import { getShellContext } from "@/modules/shell/queries";
import { listTeamMembers } from "@/modules/team/queries";
import { requireMembership, roleHasPermission } from "@/server/authz/permissions";

export const metadata: Metadata = {
  title: "Automações — Praxis CRM Jurídico",
};

/**
 * Automações internas (C1 mínima).
 *
 * Quem consulta: `automation.view` (proprietário, administrador e gestor); quem
 * gerencia: `automation.manage` (proprietário e administrador). Qualquer outro
 * papel recebe "não encontrado", nunca "proibido". O workspace vem SEMPRE da
 * sessão; o banco repete a checagem e trata workspace alheio como inexistente.
 */
export default async function AutomacoesPage() {
  const membership = await requireMembership();
  if (!roleHasPermission(membership.role, "automation.view")) {
    notFound();
  }
  const canManage = roleHasPermission(membership.role, "automation.manage");

  const { user, activeWorkspace } = await getShellContext();

  const [rules, executions, stages, team] = await Promise.all([
    listAutomationRules(membership.workspaceId),
    listAutomationExecutions(membership.workspaceId),
    listAutomationStageOptions(membership.workspaceId),
    listTeamMembers(membership.workspaceId, membership.userId),
  ]);
  // O banco recusou (papel mudou desde que a página abriu): mesma resposta de quem nunca teve acesso.
  if (rules === null || executions === null) notFound();

  const members = team.map((member) => ({ userId: member.userId, name: member.fullName ?? member.email }));

  return (
    <>
      <Topbar title="Automações" subtitle={activeWorkspace.name} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
          <p className="m-0 text-meta text-text-muted">
            Regras internas que criam uma atividade de acompanhamento quando um lead é criado ou uma oportunidade muda de
            etapa. Toda regra precisa ser simulada antes de ser ativada. Nesta versão as automações não enviam
            mensagens, e-mails nem notificações.
          </p>

          {!canManage ? (
            <Alert variant="default">
              <AlertDescription>
                Você pode consultar as regras e o histórico. Só proprietário e administrador criam ou alteram regras.
              </AlertDescription>
            </Alert>
          ) : null}

          <section aria-labelledby="regras" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="regras" className="m-0 text-body font-semibold text-text">
                Regras
              </h2>
              {canManage ? (
                <div className="flex flex-wrap items-center gap-3">
                  <ProcessNowButton />
                  <AutomationRuleFormDialog
                    stages={stages}
                    members={members}
                    trigger={<Button size="sm">Nova regra</Button>}
                  />
                </div>
              ) : null}
            </div>

            {rules.length === 0 ? (
              <EmptyState
                icon={Zap}
                title="Nenhuma regra ainda"
                description={
                  canManage
                    ? "Crie a primeira regra, simule o resultado e ative quando estiver tudo certo."
                    : "Quando proprietário ou administrador criarem regras, elas aparecem aqui."
                }
              />
            ) : (
              <AutomationRuleList rules={rules} stages={stages} members={members} canManage={canManage} />
            )}
          </section>

          <section aria-labelledby="historico" className="flex flex-col gap-3">
            <h2 id="historico" className="m-0 text-body font-semibold text-text">
              Histórico de execuções
            </h2>
            {executions.length === 0 ? (
              <EmptyState
                icon={History}
                title="Nenhuma execução ainda"
                description="Quando uma regra ativa for acionada, cada tentativa aparece aqui, com o resultado e o motivo."
              />
            ) : (
              <AutomationExecutionHistory items={executions} />
            )}
          </section>
        </div>
      </main>
    </>
  );
}
