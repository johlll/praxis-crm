"use client";

import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AutomationRuleFormDialog, type AutomationMemberOption } from "@/components/automations/rule-form-dialog";
import { AutomationStatusBadge } from "@/components/automations/status-badge";
import { formatDate, formatDateTime } from "@/lib/timezone";
import {
  setAutomationRuleStatusAction,
  simulateAutomationRuleAction,
} from "@/modules/automations/actions";
import type { AutomationRule, AutomationStageOption } from "@/modules/automations/queries";
import { type AutomationSimulation } from "@/modules/automations/schema";

const PRIORITY_LABEL = { baixa: "Baixa", media: "Média", alta: "Alta" } as const;
const ASSIGNEE_RESULT_LABEL = {
  ok: "Válido",
  none: "Sem responsável",
  invalid: "Inválido: a execução falharia",
} as const;

type Props = {
  rule: AutomationRule;
  triggerText: string;
  actionText: string;
  canManage: boolean;
  stages: AutomationStageOption[];
  members: AutomationMemberOption[];
};

/**
 * Uma regra: o que ela faz, o estado, a situação da simulação e os controles.
 * A ativação só é oferecida com simulação da VERSÃO ATUAL (o botão fica
 * desabilitado sem ela, e o banco recusa de qualquer jeito). Quem só consulta
 * (gestor) vê tudo, sem nenhum botão de ação.
 */
export function AutomationRuleCard({ rule, triggerText, actionText, canManage, stages, members }: Props) {
  const [simulation, setSimulation] = useState<AutomationSimulation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [pending, startTransition] = useTransition();

  const archived = rule.status === "archived";
  const canActivate = (rule.status === "draft" || rule.status === "paused") && rule.simulationCurrent;

  function simulate() {
    setError(null);
    startTransition(async () => {
      const result = await simulateAutomationRuleAction(rule.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSimulation(result.simulation);
    });
  }

  function changeStatus(status: "active" | "paused" | "archived") {
    setError(null);
    startTransition(async () => {
      const result = await setAutomationRuleStatusAction(rule.id, status);
      if (!result.ok) setError(result.error);
      setConfirmArchive(false);
    });
  }

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-body font-semibold text-text">{rule.name}</h3>
            <AutomationStatusBadge status={rule.status} />
          </div>
          <p className="m-0 text-meta text-text-secondary">{triggerText}.</p>
          <p className="m-0 text-meta text-text-secondary">{actionText}.</p>
        </div>
      </div>

      <p className="m-0 text-meta text-text-tertiary">
        {archived
          ? "Regra arquivada: não executa mais e não pode ser alterada."
          : rule.simulationCurrent && rule.simulatedAt
            ? `Simulada em ${formatDateTime(rule.simulatedAt)}: ${rule.simulatedCount ?? 0} registro(s) compatíveis nos últimos 30 dias.`
            : rule.simulatedAt
              ? "A simulação está desatualizada: a regra mudou depois dela. Simule de novo para poder ativar."
              : "Ainda não simulada. Simule antes de ativar."}
        {rule.status === "active" && rule.activatedAt ? ` Ativa desde ${formatDate(rule.activatedAt)}.` : ""}
      </p>

      {simulation ? (
        <div className="flex flex-col gap-2 rounded-card border border-border bg-background p-3" aria-live="polite">
          <p className="m-0 text-meta font-semibold text-text">
            Simulação: {simulation.match_count} registro(s) compatíveis nos últimos {simulation.window_days} dias.
          </p>
          <p className="m-0 text-meta text-text-tertiary">
            Nada foi criado nem alterado. A prévia não mostra nomes nem dados de contato.
          </p>
          {simulation.sample.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-meta">
                <thead>
                  <tr className="text-text-tertiary">
                    <th className="py-1 pr-3 font-medium">Data</th>
                    <th className="py-1 pr-3 font-medium">Prioridade</th>
                    <th className="py-1 pr-3 font-medium">Área</th>
                    <th className="py-1 pr-3 font-medium">Prazo da atividade</th>
                    <th className="py-1 font-medium">Responsável</th>
                  </tr>
                </thead>
                <tbody>
                  {simulation.sample.map((item, index) => (
                    <tr key={index} className="border-t border-border text-text-secondary">
                      <td className="py-1 pr-3">{formatDate(`${item.date}T12:00:00-03:00`)}</td>
                      <td className="py-1 pr-3">{PRIORITY_LABEL[item.priority]}</td>
                      <td className="py-1 pr-3">{item.legal_area ?? "—"}</td>
                      <td className="py-1 pr-3">{formatDate(`${item.due_date}T12:00:00-03:00`)}</td>
                      <td className="py-1">{ASSIGNEE_RESULT_LABEL[item.assignee]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {simulation.sample_invalid > 0 ? (
            <Alert variant="warning">
              <AlertDescription>
                Em {simulation.sample_invalid} exemplo(s) o responsável seria inválido: a execução falharia. Ajuste o
                responsável antes de ativar.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {canManage && !archived ? (
        <div className="flex flex-wrap items-center gap-2">
          <AutomationRuleFormDialog
            rule={rule}
            stages={stages}
            members={members}
            trigger={
              <Button variant="secondary" size="sm" disabled={pending}>
                Editar
              </Button>
            }
          />
          <Button variant="secondary" size="sm" onClick={simulate} disabled={pending}>
            {pending ? "Aguarde…" : "Simular"}
          </Button>
          {rule.status === "active" ? (
            <Button variant="secondary" size="sm" onClick={() => changeStatus("paused")} disabled={pending}>
              Pausar
            </Button>
          ) : (
            <Button size="sm" onClick={() => changeStatus("active")} disabled={pending || !canActivate}>
              {rule.status === "paused" ? "Reativar" : "Ativar"}
            </Button>
          )}
          {confirmArchive ? (
            <>
              <Button variant="danger" size="sm" onClick={() => changeStatus("archived")} disabled={pending}>
                Confirmar arquivamento
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(false)} disabled={pending}>
                Cancelar
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(true)} disabled={pending}>
              Arquivar
            </Button>
          )}
          {rule.status !== "active" && !canActivate ? (
            <span className="text-meta text-text-tertiary">Simule a versão atual para poder ativar.</span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
