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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CalendarNoticeAlert } from "@/components/calendar/calendar-notice";
import { useCalendarCapabilities } from "@/components/calendar/calendar-capabilities";
import { updateActivityAction, type ActivityActionState } from "@/modules/activities/actions";
import { ACTIVITY_TYPES } from "@/modules/activities/schema";
import { LEAD_PRIORITIES } from "@/modules/leads/schema";
import type { ActivityListItem } from "@/modules/activities/queries";
import { ACTIVITY_TYPE_LABEL, PRIORITY_LABEL } from "./labels";

const INITIAL_STATE: ActivityActionState = { ok: false };

export function EditActivityDialog({ activity }: { activity: ActivityListItem }) {
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
        <Button variant="ghost" size="sm" aria-label={`Editar ${activity.title}`}>
          <Pencil size={14} aria-hidden />
        </Button>
      </DialogTrigger>
      <EditActivityDialogBody key={instanceKey} activity={activity} onDone={() => setOpen(false)} />
    </Dialog>
  );
}

function EditActivityDialogBody({ activity, onDone }: { activity: ActivityListItem; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(updateActivityAction, INITIAL_STATE);
  // Vínculo vivo com o Google: o tipo não muda sem resolver o vínculo; na agenda
  // de outra pessoa (ou com inclusão incerta), o título também fica travado.
  // O servidor confere de novo antes de salvar.
  const caps = useCalendarCapabilities();
  const info = caps.enabled ? activity.calendar : null;
  const live = !!info && info.status !== "cancelled_in_google" && info.status !== "missing_in_google";
  const titleLocked = live && (!info.isMine || info.status === "not_linked");

  if (state.ok) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Atividade atualizada</DialogTitle>
        </DialogHeader>
        <Alert variant="success">
          <AlertDescription>As alterações foram salvas.</AlertDescription>
        </Alert>
        <CalendarNoticeAlert notice={state.calendar} />
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
        <DialogTitle>Editar atividade</DialogTitle>
      </DialogHeader>
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="activityId" value={activity.id} />
        <input type="hidden" name="lockVersion" value={activity.lockVersion} />

        <FormField>
          <FormLabel htmlFor="edit-activity-type">Tipo</FormLabel>
          <select
            id="edit-activity-type"
            name="type"
            defaultValue={activity.type}
            disabled={live}
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
          <FormLabel htmlFor="edit-activity-title">Título</FormLabel>
          <Input
            id="edit-activity-title"
            name="title"
            required
            maxLength={160}
            defaultValue={activity.title}
            disabled={titleLocked}
          />
        </FormField>
        {live ? (
          <p className="text-small text-text-secondary" data-testid="calendar-edit-hint">
            {titleLocked
              ? "Este compromisso está vinculado à agenda de outra pessoa (ou com inclusão incerta): tipo e título só mudam depois de resolver o vínculo. Notas e prioridade continuam editáveis."
              : "Este compromisso está no Google Agenda: para mudar o tipo, remova-o da agenda primeiro."}
          </p>
        ) : null}

        <FormField>
          <FormLabel htmlFor="edit-activity-priority">Prioridade</FormLabel>
          <select
            id="edit-activity-priority"
            name="priority"
            defaultValue={activity.priority}
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
          <FormLabel htmlFor="edit-activity-notes">Notas</FormLabel>
          <textarea
            id="edit-activity-notes"
            name="notes"
            rows={2}
            maxLength={2000}
            defaultValue={activity.notes ?? ""}
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
            {pending ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
