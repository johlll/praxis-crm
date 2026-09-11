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
import { createActivityAction, type ActivityActionState } from "@/modules/activities/actions";
import { ACTIVITY_TYPES } from "@/modules/activities/schema";
import { LEAD_PRIORITIES } from "@/modules/leads/schema";
import type { LeadListItem } from "@/modules/leads/queries";
import type { TeamMember } from "@/modules/team/queries";
import { ACTIVITY_TYPE_LABEL, PRIORITY_LABEL } from "./labels";

const INITIAL_STATE: ActivityActionState = { ok: false };

export function CreateActivityDialog({
  leadOptions = [],
  members,
  leadId,
  opportunityId,
}: {
  /** Só é necessário quando leadId não é passado (Central de Atividades, sem lead fixo). */
  leadOptions?: LeadListItem[];
  members: TeamMember[];
  /** Quando a origem já sabe o lead (painel da oportunidade ou do lead), o campo some do formulário. */
  leadId?: string;
  opportunityId?: string;
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
        <Button size="sm">
          <Plus size={14} aria-hidden />
          Nova atividade
        </Button>
      </DialogTrigger>
      <CreateActivityDialogBody
        key={instanceKey}
        leadOptions={leadOptions}
        members={members}
        {...(leadId ? { leadId } : {})}
        {...(opportunityId ? { opportunityId } : {})}
        onDone={() => setOpen(false)}
      />
    </Dialog>
  );
}

function CreateActivityDialogBody({
  leadOptions,
  members,
  leadId,
  opportunityId,
  onDone,
}: {
  leadOptions: LeadListItem[];
  members: TeamMember[];
  leadId?: string;
  opportunityId?: string;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(createActivityAction, INITIAL_STATE);

  if (state.ok) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Atividade criada</DialogTitle>
        </DialogHeader>
        <Alert variant="success">
          <AlertDescription>A atividade já aparece na Central de Atividades.</AlertDescription>
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
        <DialogTitle>Nova atividade</DialogTitle>
        {!leadId ? <DialogDescription>Vinculada a um lead — opcionalmente também a uma oportunidade.</DialogDescription> : null}
      </DialogHeader>
      <form action={formAction} className="flex flex-col gap-4">
        {leadId ? (
          <input type="hidden" name="leadId" value={leadId} />
        ) : (
          <FormField>
            <FormLabel htmlFor="activity-lead">Lead</FormLabel>
            <select
              id="activity-lead"
              name="leadId"
              required
              defaultValue=""
              className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
            >
              <option value="" disabled>
                Selecione um lead
              </option>
              {leadOptions.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.contactName} — {lead.legalArea}
                </option>
              ))}
            </select>
          </FormField>
        )}
        {opportunityId ? <input type="hidden" name="opportunityId" value={opportunityId} /> : null}

        <FormField>
          <FormLabel htmlFor="activity-type">Tipo</FormLabel>
          <select
            id="activity-type"
            name="type"
            defaultValue="task"
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
          <FormLabel htmlFor="activity-title">Título</FormLabel>
          <Input id="activity-title" name="title" required maxLength={160} />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField>
            <FormLabel htmlFor="activity-due-date">Data</FormLabel>
            <Input id="activity-due-date" name="dueDate" type="date" required />
          </FormField>
          <FormField>
            <FormLabel htmlFor="activity-due-time">Horário (opcional)</FormLabel>
            <Input id="activity-due-time" name="dueTime" type="time" />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField>
            <FormLabel htmlFor="activity-priority">Prioridade</FormLabel>
            <select
              id="activity-priority"
              name="priority"
              defaultValue="media"
              className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
            >
              {LEAD_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField>
            <FormLabel htmlFor="activity-assigned">Responsável</FormLabel>
            <select
              id="activity-assigned"
              name="assignedTo"
              defaultValue=""
              className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
            >
              <option value="">Sem responsável</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.fullName ?? member.email}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        <FormField>
          <FormLabel htmlFor="activity-notes">Notas (opcional)</FormLabel>
          <textarea
            id="activity-notes"
            name="notes"
            rows={2}
            maxLength={2000}
            className="rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text"
          />
        </FormField>

        {state.error ? (
          <Alert variant="danger">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {pending ? "Criando…" : "Criar atividade"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
