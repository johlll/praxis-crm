"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";

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
import { createStageRequirementAction, type PipelineConfigActionState } from "@/modules/opportunities/actions";
import { STAGE_REQUIREMENT_TYPES } from "@/modules/opportunities/schema";

const INITIAL_STATE: PipelineConfigActionState = { ok: false };

const FIELD_TYPE_LABEL: Record<(typeof STAGE_REQUIREMENT_TYPES)[number], string> = {
  text: "Texto curto",
  textarea: "Texto longo",
  date: "Data",
  checkbox: "Marcação (sim/não)",
};

export function AddRequirementDialog({ stageId, stageName }: { stageId: string; stageName: string }) {
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
        <Button variant="ghost" size="sm" aria-label={`Novo requisito para ${stageName}`}>
          <Plus size={12} aria-hidden />
          Requisito
        </Button>
      </DialogTrigger>
      <AddRequirementDialogBody
        key={instanceKey}
        stageId={stageId}
        stageName={stageName}
        onDone={() => setOpen(false)}
      />
    </Dialog>
  );
}

function AddRequirementDialogBody({
  stageId,
  stageName,
  onDone,
}: {
  stageId: string;
  stageName: string;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(createStageRequirementAction, INITIAL_STATE);

  if (state.ok) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Requisito criado</DialogTitle>
        </DialogHeader>
        <Alert variant="success">
          <AlertDescription>Passa a valer para quem tentar avançar até &quot;{stageName}&quot;.</AlertDescription>
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
        <DialogTitle>Novo requisito para &quot;{stageName}&quot;</DialogTitle>
        <DialogDescription>
          Passa a ser exigido para AVANÇAR até esta etapa (não bloqueia retroceder, nem ganhar/perder).
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
          <FormLabel htmlFor={`req-label-${stageId}`}>Rótulo</FormLabel>
          <Input id={`req-label-${stageId}`} name="label" required maxLength={160} />
        </FormField>
        <FormField>
          <FormLabel htmlFor={`req-type-${stageId}`}>Tipo de campo</FormLabel>
          <select
            id={`req-type-${stageId}`}
            name="fieldType"
            defaultValue="text"
            className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
          >
            {STAGE_REQUIREMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {FIELD_TYPE_LABEL[type]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField>
          <FormLabel htmlFor={`req-hint-${stageId}`}>Dica (opcional)</FormLabel>
          <Input id={`req-hint-${stageId}`} name="hint" maxLength={200} />
        </FormField>
        {state.error ? (
          <Alert variant="danger">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {pending ? "Criando…" : "Criar requisito"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
