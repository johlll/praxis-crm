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
import { createPipelineStageAction, type PipelineConfigActionState } from "@/modules/opportunities/actions";

const INITIAL_STATE: PipelineConfigActionState = { ok: false };

/**
 * `key={instanceKey}` remonta o corpo do diálogo a cada abertura — troca
 * limpa de estado do useActionState (volta pro formulário em branco) sem
 * setState dentro de efeito (proibido pelo lint react-hooks/set-state-in-effect).
 */
export function CreateStageDialog({ pipelineId }: { pipelineId: string }) {
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
        <Button size="sm" variant="secondary">
          <Plus size={14} aria-hidden />
          Nova etapa
        </Button>
      </DialogTrigger>
      <CreateStageDialogBody key={instanceKey} pipelineId={pipelineId} onDone={() => setOpen(false)} />
    </Dialog>
  );
}

function CreateStageDialogBody({ pipelineId, onDone }: { pipelineId: string; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(createPipelineStageAction, INITIAL_STATE);

  if (state.ok) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Etapa criada</DialogTitle>
        </DialogHeader>
        <Alert variant="success">
          <AlertDescription>A nova etapa já aparece na lista.</AlertDescription>
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
        <DialogTitle>Nova etapa</DialogTitle>
        <DialogDescription>Adicionada ao final do pipeline — a posição pode ser ajustada depois.</DialogDescription>
      </DialogHeader>
      <form
        action={(formData) => {
          formData.set("pipelineId", pipelineId);
          formAction(formData);
        }}
        className="flex flex-col gap-4"
      >
        <FormField>
          <FormLabel htmlFor="stage-name">Nome</FormLabel>
          <Input id="stage-name" name="name" required maxLength={120} />
        </FormField>
        <FormField>
          <FormLabel htmlFor="stage-color">Cor (opcional)</FormLabel>
          <Input id="stage-color" name="color" type="color" defaultValue="#0E6C5C" className="h-9 w-16 p-1" />
        </FormField>
        {state.error ? (
          <Alert variant="danger">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {pending ? "Criando…" : "Criar etapa"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
