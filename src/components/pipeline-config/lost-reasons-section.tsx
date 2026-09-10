"use client";

import { useActionState, useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  createLostReasonAction,
  deactivateLostReasonAction,
  type PipelineConfigActionState,
} from "@/modules/opportunities/actions";
import type { LostReasonOption } from "@/modules/opportunities/queries";

const INITIAL_STATE: PipelineConfigActionState = { ok: false };

function CreateLostReasonDialog({ workspaceId }: { workspaceId: string }) {
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
          Novo motivo
        </Button>
      </DialogTrigger>
      <CreateLostReasonDialogBody key={instanceKey} workspaceId={workspaceId} onDone={() => setOpen(false)} />
    </Dialog>
  );
}

function CreateLostReasonDialogBody({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(createLostReasonAction, INITIAL_STATE);

  if (state.ok) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Motivo criado</DialogTitle>
        </DialogHeader>
        <Alert variant="success">
          <AlertDescription>Já aparece na lista e no diálogo de perda.</AlertDescription>
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
        <DialogTitle>Novo motivo de perda</DialogTitle>
      </DialogHeader>
      <form
        action={(formData) => {
          formData.set("workspaceId", workspaceId);
          formAction(formData);
        }}
        className="flex flex-col gap-4"
      >
        <FormField>
          <FormLabel htmlFor="lost-reason-label">Motivo</FormLabel>
          <Input id="lost-reason-label" name="label" required maxLength={160} />
        </FormField>
        {state.error ? (
          <Alert variant="danger">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {pending ? "Criando…" : "Criar motivo"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function LostReasonRow({ reason }: { reason: LostReasonOption }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function deactivate() {
    setError(null);
    const formData = new FormData();
    formData.set("lostReasonId", reason.id);
    startTransition(async () => {
      const result = await deactivateLostReasonAction({ ok: false }, formData);
      if (!result.ok) setError(result.error ?? "Não foi possível desativar este motivo.");
    });
  }

  return (
    <div className="flex flex-col gap-1 border-b border-border-subtle px-4 py-2.5 last:border-0">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-small text-text">{reason.label}</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={isPending}
          aria-label={`Desativar motivo ${reason.label}`}
          onClick={deactivate}
        >
          <Trash2 size={14} aria-hidden />
        </Button>
      </div>
      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function LostReasonsSection({
  workspaceId,
  reasons,
}: {
  workspaceId: string;
  reasons: LostReasonOption[];
}) {
  return (
    <section className="rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-body font-semibold text-text">Motivos de perda</h2>
          <p className="text-meta text-text-tertiary">Desativar não remove o histórico — um motivo já usado continua visível nas oportunidades perdidas.</p>
        </div>
        <CreateLostReasonDialog workspaceId={workspaceId} />
      </div>
      {reasons.map((reason) => (
        <LostReasonRow key={reason.id} reason={reason} />
      ))}
    </section>
  );
}
