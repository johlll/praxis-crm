"use client";

import { useActionState, useState } from "react";
import { Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { setStageAutoActivityRuleAction, type StageRuleActionState } from "@/modules/activities/actions";
import { ACTIVITY_TYPES, ACTIVITY_ASSIGNEE_RULES } from "@/modules/activities/schema";
import type { StageAutoActivityRuleDetail } from "@/modules/opportunities/queries";
import { ACTIVITY_TYPE_LABEL } from "@/components/activities/labels";

const INITIAL_STATE: StageRuleActionState = { ok: false };

const ASSIGNEE_RULE_LABEL: Record<(typeof ACTIVITY_ASSIGNEE_RULES)[number], string> = {
  unassigned: "Nasce sem responsável",
  lead_owner: "Herda o responsável do lead",
};

export function StageAutoActivityDialog({
  stageId,
  stageName,
  rule,
}: {
  stageId: string;
  stageName: string;
  rule: StageAutoActivityRuleDetail | null;
}) {
  const [open, setOpen] = useState(false);
  const [instanceKey, setInstanceKey] = useState(0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setInstanceKey((k) => k + 1);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`${rule ? "Editar" : "Configurar"} atividade automática de ${stageName}`}>
          <Zap size={12} aria-hidden />
          {rule ? "Atividade automática" : "Automatizar"}
        </Button>
      </DialogTrigger>
      <StageAutoActivityDialogBody
        key={instanceKey}
        stageId={stageId}
        stageName={stageName}
        rule={rule}
        onDone={() => setOpen(false)}
      />
    </Dialog>
  );
}

function StageAutoActivityDialogBody({
  stageId,
  stageName,
  rule,
  onDone,
}: {
  stageId: string;
  stageName: string;
  rule: StageAutoActivityRuleDetail | null;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(setStageAutoActivityRuleAction, INITIAL_STATE);

  if (state.ok) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Regra salva</DialogTitle>
        </DialogHeader>
        <Alert variant="success">
          <AlertDescription>
            Toda vez que uma oportunidade entrar em &quot;{stageName}&quot;, essa atividade é criada automaticamente.
          </AlertDescription>
        </Alert>
        <DialogFooter>
          <Button type="button" onClick={onDone}>
            Concluir
          </Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Atividade automática em &quot;{stageName}&quot;</DialogTitle>
        <DialogDescription>
          Criada só quando a movimentação é aceita pelo servidor — recusada, com requisito pendente ou em conflito, não gera nada.
        </DialogDescription>
      </DialogHeader>
      <form
        action={(formData) => {
          formData.set("stageId", stageId);
          formAction(formData);
        }}
        className="flex flex-col gap-4"
      >
        <FormField>
          <FormLabel htmlFor={`rule-type-${stageId}`}>Tipo da atividade</FormLabel>
          <select
            id={`rule-type-${stageId}`}
            name="activityType"
            defaultValue={rule?.activityType ?? "task"}
            className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
          >
            {ACTIVITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {ACTIVITY_TYPE_LABEL[type]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField>
          <FormLabel htmlFor={`rule-title-${stageId}`}>Título</FormLabel>
          <Input id={`rule-title-${stageId}`} name="title" required maxLength={160} defaultValue={rule?.title ?? ""} />
        </FormField>
        <FormField>
          <FormLabel htmlFor={`rule-offset-${stageId}`}>Prazo (horas após a movimentação)</FormLabel>
          <Input
            id={`rule-offset-${stageId}`}
            name="dueOffsetHours"
            type="number"
            min={0}
            max={720}
            defaultValue={rule?.dueOffsetHours ?? 24}
          />
        </FormField>
        <FormField>
          <FormLabel htmlFor={`rule-assignee-${stageId}`}>Responsável</FormLabel>
          <select
            id={`rule-assignee-${stageId}`}
            name="assigneeRule"
            defaultValue={rule?.assigneeRule ?? "lead_owner"}
            className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
          >
            {ACTIVITY_ASSIGNEE_RULES.map((r) => (
              <option key={r} value={r}>
                {ASSIGNEE_RULE_LABEL[r]}
              </option>
            ))}
          </select>
        </FormField>
        {state.error ? (
          <Alert variant="danger">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {pending ? "Salvando…" : "Salvar regra"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
