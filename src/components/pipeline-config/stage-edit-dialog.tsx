"use client";

import { useActionState, useState } from "react";
import { Pencil } from "lucide-react";

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
import { updatePipelineStageAction, type PipelineConfigActionState } from "@/modules/opportunities/actions";
import type { PipelineStageDetail } from "@/modules/opportunities/queries";

const INITIAL_STATE: PipelineConfigActionState = { ok: false };

/**
 * Marcar is_won/is_lost é bloqueado no servidor (stage_has_open_opportunities)
 * se a etapa tiver oportunidade ABERTA nela agora — a mensagem de erro já
 * mapeada em src/lib/errors.ts explica isso, não duplicamos o texto aqui.
 */
export function StageEditDialog({ stage }: { stage: PipelineStageDetail }) {
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
        <Button variant="ghost" size="sm" aria-label={`Editar etapa ${stage.name}`}>
          <Pencil size={14} aria-hidden />
        </Button>
      </DialogTrigger>
      <StageEditDialogBody key={instanceKey} stage={stage} onDone={() => setOpen(false)} />
    </Dialog>
  );
}

function StageEditDialogBody({ stage, onDone }: { stage: PipelineStageDetail; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(updatePipelineStageAction, INITIAL_STATE);

  if (state.ok) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Etapa atualizada</DialogTitle>
        </DialogHeader>
        <Alert variant="success">
          <AlertDescription>As alterações já aparecem na lista.</AlertDescription>
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
        <DialogTitle>Editar etapa</DialogTitle>
        <DialogDescription>
          Marcar como ganho/perda impede que oportunidades sejam movidas para cá — o encerramento passa a ser só
          pelos botões &quot;Ganhou&quot;/&quot;Perdeu&quot;.
        </DialogDescription>
      </DialogHeader>
      <form
        action={(formData) => {
          formData.set("stageId", stage.id);
          formAction(formData);
        }}
        className="flex flex-col gap-4"
      >
        <FormField>
          <FormLabel htmlFor={`stage-name-${stage.id}`}>Nome</FormLabel>
          <Input id={`stage-name-${stage.id}`} name="name" defaultValue={stage.name} required maxLength={120} />
        </FormField>
        <FormField>
          <FormLabel htmlFor={`stage-color-${stage.id}`}>Cor</FormLabel>
          <Input
            id={`stage-color-${stage.id}`}
            name="color"
            type="color"
            defaultValue={stage.color ?? "#0E6C5C"}
            className="h-9 w-16 p-1"
          />
        </FormField>
        <FormField className="flex-row items-center gap-2">
          <input
            id={`stage-is-won-${stage.id}`}
            name="isWon"
            type="checkbox"
            value="true"
            defaultChecked={stage.isWon}
            className="size-4"
          />
          <FormLabel htmlFor={`stage-is-won-${stage.id}`} className="mb-0">
            Etapa de ganho
          </FormLabel>
        </FormField>
        <FormField className="flex-row items-center gap-2">
          <input
            id={`stage-is-lost-${stage.id}`}
            name="isLost"
            type="checkbox"
            value="true"
            defaultChecked={stage.isLost}
            className="size-4"
          />
          <FormLabel htmlFor={`stage-is-lost-${stage.id}`} className="mb-0">
            Etapa de perda
          </FormLabel>
        </FormField>
        {state.error ? (
          <Alert variant="danger">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {pending ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
