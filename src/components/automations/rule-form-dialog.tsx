"use client";

import { useState, useTransition, type FormEvent, type ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { saveAutomationRuleAction } from "@/modules/automations/actions";
import type { AutomationRule, AutomationStageOption } from "@/modules/automations/queries";
import {
  AUTOMATION_ASSIGNEE_MODE_LABEL,
  AUTOMATION_ASSIGNEE_MODES,
  AUTOMATION_TRIGGER_LABEL,
  AUTOMATION_TRIGGERS,
  type AutomationAssigneeMode,
  type AutomationTrigger,
} from "@/modules/automations/schema";

export type AutomationMemberOption = { userId: string; name: string };

const SELECT_CLASS = "h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text";
const PRIORITIES = [
  { value: "baixa", label: "Baixa" },
  { value: "media", label: "Média" },
  { value: "alta", label: "Alta" },
] as const;

type Props = {
  /** Sem `rule`, cria uma regra nova (sempre como rascunho). */
  rule?: AutomationRule | undefined;
  stages: AutomationStageOption[];
  members: AutomationMemberOption[];
  trigger: ReactNode;
};

/**
 * Criar e editar regra. Os campos são os da estrutura FECHADA da C1 (gatilho,
 * condições padrão, uma ação); não existe campo livre de expressão. O estado
 * volta ao inicial a cada abertura (o corpo é remontado), para um valor
 * esquecido de uma edição anterior nunca vazar para a próxima.
 */
export function AutomationRuleFormDialog({ rule, stages, members, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const [instanceKey, setInstanceKey] = useState(0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setInstanceKey((key) => key + 1);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <RuleFormBody
          key={instanceKey}
          rule={rule}
          stages={stages}
          members={members}
          onDone={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function RuleFormBody({
  rule,
  stages,
  members,
  onDone,
}: Omit<Props, "trigger"> & { onDone: () => void }) {
  const [name, setName] = useState(rule?.name ?? "");
  const [triggerType, setTriggerType] = useState<AutomationTrigger>(rule?.trigger ?? "lead_created");
  const [condPriority, setCondPriority] = useState(rule?.condPriority ?? "");
  const [condLegalArea, setCondLegalArea] = useState(rule?.condLegalArea ?? "");
  const [condToStageId, setCondToStageId] = useState(rule?.condToStageId ?? "");
  const [condFromStageId, setCondFromStageId] = useState(rule?.condFromStageId ?? "");
  const [actionTitle, setActionTitle] = useState(rule?.actionTitle ?? "");
  const [actionDueDays, setActionDueDays] = useState(String(rule?.actionDueDays ?? 1));
  const [actionPriority, setActionPriority] = useState<string>(rule?.actionPriority ?? "media");
  const [assigneeMode, setAssigneeMode] = useState<AutomationAssigneeMode>(rule?.assigneeMode ?? "lead_owner");
  const [assigneeUserId, setAssigneeUserId] = useState(rule?.assigneeUserId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const selectableStages = stages.filter((stage) => !stage.terminal);
  const known = new Set(stages.map((stage) => stage.id));
  const isEdit = rule !== undefined;
  const isStageTrigger = triggerType === "opportunity_stage_changed";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData();
    if (rule) data.set("ruleId", rule.id);
    data.set("name", name);
    data.set("trigger", triggerType);
    // Condições que não valem para o gatilho escolhido nem seguem para o servidor.
    if (!isStageTrigger) {
      data.set("condPriority", condPriority);
      data.set("condLegalArea", condLegalArea);
    } else {
      data.set("condToStageId", condToStageId);
      data.set("condFromStageId", condFromStageId);
    }
    data.set("actionTitle", actionTitle);
    data.set("actionDueDays", actionDueDays);
    data.set("actionPriority", actionPriority);
    data.set("assigneeMode", assigneeMode);
    if (assigneeMode === "user") data.set("assigneeUserId", assigneeUserId);

    setError(null);
    startTransition(async () => {
      const result = await saveAutomationRuleAction(data);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone();
    });
  }

  function stageOptions(current: string) {
    return (
      <>
        {selectableStages.map((stage) => (
          <option key={stage.id} value={stage.id}>
            {stage.label}
          </option>
        ))}
        {current && !selectableStages.some((stage) => stage.id === current) ? (
          <option value={current}>{known.has(current) ? "Etapa de ganho ou perda" : "Etapa removida"}</option>
        ) : null}
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEdit ? "Editar regra" : "Nova regra"}</DialogTitle>
        <DialogDescription>
          Quando algo acontecer, o CRM cria uma atividade de acompanhamento. Nada é enviado a ninguém.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
        {isEdit && rule.status !== "draft" ? (
          <Alert variant="warning">
            <AlertDescription>
              Mudar o gatilho, as condições ou a ação invalida a simulação
              {rule.status === "active" ? " e pausa a regra" : ""}: será preciso simular e ativar de novo.
            </AlertDescription>
          </Alert>
        ) : null}

        <FormField>
          <FormLabel htmlFor="automation-name">Nome da regra</FormLabel>
          <Input
            id="automation-name"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ex.: Retornar leads de alta prioridade"
          />
        </FormField>

        <fieldset className="flex flex-col gap-3 rounded-card border border-border p-3">
          <legend className="px-1 text-meta font-semibold text-text-secondary">Quando</legend>
          <FormField>
            <FormLabel htmlFor="automation-trigger">Gatilho</FormLabel>
            <select
              id="automation-trigger"
              value={triggerType}
              onChange={(event) => setTriggerType(event.target.value as AutomationTrigger)}
              className={SELECT_CLASS}
            >
              {AUTOMATION_TRIGGERS.map((value) => (
                <option key={value} value={value}>
                  {AUTOMATION_TRIGGER_LABEL[value]}
                </option>
              ))}
            </select>
          </FormField>

          {isStageTrigger ? (
            <>
              <FormField>
                <FormLabel htmlFor="automation-to-stage">Etapa de destino</FormLabel>
                <select
                  id="automation-to-stage"
                  value={condToStageId}
                  onChange={(event) => setCondToStageId(event.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value="">Escolha a etapa</option>
                  {stageOptions(condToStageId)}
                </select>
              </FormField>
              <FormField>
                <FormLabel htmlFor="automation-from-stage">Vinda de (opcional)</FormLabel>
                <select
                  id="automation-from-stage"
                  value={condFromStageId}
                  onChange={(event) => setCondFromStageId(event.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value="">Qualquer etapa</option>
                  {stages.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {stage.label}
                    </option>
                  ))}
                  {condFromStageId && !known.has(condFromStageId) ? (
                    <option value={condFromStageId}>Etapa removida</option>
                  ) : null}
                </select>
              </FormField>
            </>
          ) : (
            <>
              <FormField>
                <FormLabel htmlFor="automation-cond-priority">Prioridade do lead (opcional)</FormLabel>
                <select
                  id="automation-cond-priority"
                  value={condPriority}
                  onChange={(event) => setCondPriority(event.target.value as typeof condPriority)}
                  className={SELECT_CLASS}
                >
                  <option value="">Qualquer prioridade</option>
                  {PRIORITIES.map((priority) => (
                    <option key={priority.value} value={priority.value}>
                      {priority.label}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField>
                <FormLabel htmlFor="automation-cond-area">Área jurídica (opcional)</FormLabel>
                <Input
                  id="automation-cond-area"
                  value={condLegalArea}
                  maxLength={120}
                  onChange={(event) => setCondLegalArea(event.target.value)}
                  placeholder="Ex.: Trabalhista"
                />
              </FormField>
            </>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-card border border-border p-3">
          <legend className="px-1 text-meta font-semibold text-text-secondary">Então, criar a atividade</legend>
          <FormField>
            <FormLabel htmlFor="automation-title">Título</FormLabel>
            <Input
              id="automation-title"
              value={actionTitle}
              maxLength={160}
              onChange={(event) => setActionTitle(event.target.value)}
              placeholder="Ex.: Retornar o contato"
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField>
              <FormLabel htmlFor="automation-days">Prazo (dias)</FormLabel>
              <Input
                id="automation-days"
                inputMode="numeric"
                value={actionDueDays}
                maxLength={2}
                onChange={(event) => setActionDueDays(event.target.value)}
              />
            </FormField>
            <FormField>
              <FormLabel htmlFor="automation-priority">Prioridade</FormLabel>
              <select
                id="automation-priority"
                value={actionPriority}
                onChange={(event) => setActionPriority(event.target.value)}
                className={SELECT_CLASS}
              >
                {PRIORITIES.map((priority) => (
                  <option key={priority.value} value={priority.value}>
                    {priority.label}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
          <FormField>
            <FormLabel htmlFor="automation-assignee-mode">Responsável</FormLabel>
            <select
              id="automation-assignee-mode"
              value={assigneeMode}
              onChange={(event) => setAssigneeMode(event.target.value as AutomationAssigneeMode)}
              className={SELECT_CLASS}
            >
              {AUTOMATION_ASSIGNEE_MODES.map((value) => (
                <option key={value} value={value}>
                  {AUTOMATION_ASSIGNEE_MODE_LABEL[value]}
                </option>
              ))}
            </select>
          </FormField>
          {assigneeMode === "user" ? (
            <FormField>
              <FormLabel htmlFor="automation-assignee-user">Pessoa</FormLabel>
              <select
                id="automation-assignee-user"
                value={assigneeUserId}
                onChange={(event) => setAssigneeUserId(event.target.value)}
                className={SELECT_CLASS}
              >
                <option value="">Escolha uma pessoa</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.name}
                  </option>
                ))}
              </select>
            </FormField>
          ) : null}
        </fieldset>

        {error ? (
          <Alert variant="danger">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onDone}>
            Cancelar
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Salvando…" : isEdit ? "Salvar alterações" : "Criar como rascunho"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
