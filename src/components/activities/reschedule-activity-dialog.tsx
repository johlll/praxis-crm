"use client";

import { useState, useTransition } from "react";
import { CalendarClock } from "lucide-react";

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
import { dateTimeInputParts } from "@/lib/timezone";
import { rescheduleActivityAction, type ActivityActionState } from "@/modules/activities/actions";
import type { ActivityListItem } from "@/modules/activities/queries";
import { MAX_APPOINTMENT_MINUTES, MIN_APPOINTMENT_MINUTES } from "@/modules/calendar/types";

export function RescheduleActivityDialog({ activity }: { activity: ActivityListItem }) {
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
        <Button variant="ghost" size="sm" aria-label={`Reagendar ${activity.title}`}>
          <CalendarClock size={14} aria-hidden />
        </Button>
      </DialogTrigger>
      <RescheduleActivityDialogBody key={instanceKey} activity={activity} onDone={() => setOpen(false)} />
    </Dialog>
  );
}

function RescheduleActivityDialogBody({ activity, onDone }: { activity: ActivityListItem; onDone: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ActivityActionState | null>(null);
  const initial = dateTimeInputParts(activity.dueAt, activity.hasTime);
  const caps = useCalendarCapabilities();
  const info = activity.calendar;
  const editableDuration =
    caps.enabled && caps.canUse && info?.isMine === true && (info.status === "linked" || info.status === "needs_attention");

  function handleSubmit(formData: FormData) {
    const dueDate = String(formData.get("dueDate") ?? "");
    const dueTime = String(formData.get("dueTime") ?? "");
    setError(null);

    // A duração só viaja quando o usuário a MUDOU: sem mudança, vale a duração
    // real do evento (inclusive a de evento externo fora de 15–480).
    let durationMinutes: number | undefined;
    if (editableDuration && info) {
      const typed = Number(formData.get("durationMinutes") ?? info.durationMinutes);
      if (typed !== info.durationMinutes) {
        if (!Number.isInteger(typed) || typed < MIN_APPOINTMENT_MINUTES || typed > MAX_APPOINTMENT_MINUTES) {
          setError(`Informe uma duração entre ${MIN_APPOINTMENT_MINUTES} e ${MAX_APPOINTMENT_MINUTES} minutos.`);
          return;
        }
        durationMinutes = typed;
      }
    }

    startTransition(async () => {
      const result = await rescheduleActivityAction(
        activity.id,
        activity.lockVersion,
        dueDate,
        dueTime,
        {
          leadId: activity.leadId,
          ...(activity.opportunityId ? { opportunityId: activity.opportunityId } : {}),
        },
        durationMinutes !== undefined ? { durationMinutes } : undefined,
      );
      if (!result.ok) setError(result.error ?? "Não foi possível reagendar.");
      else if (result.calendar) setDone(result);
      else onDone();
    });
  }

  if (done) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Atividade reagendada</DialogTitle>
        </DialogHeader>
        <CalendarNoticeAlert notice={done.calendar} />
        <DialogFooter>
          <Button type="button" onClick={onDone}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reagendar &quot;{activity.title}&quot;</DialogTitle>
      </DialogHeader>
      <form action={handleSubmit} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <FormField>
            <FormLabel htmlFor="reschedule-date">Data</FormLabel>
            <Input id="reschedule-date" name="dueDate" type="date" required defaultValue={initial.date} />
          </FormField>
          <FormField>
            <FormLabel htmlFor="reschedule-time">Horário (opcional)</FormLabel>
            <Input id="reschedule-time" name="dueTime" type="time" defaultValue={initial.time} />
          </FormField>
        </div>
        {info && !info.isMine ? (
          <p className="text-small text-text-secondary">
            Este compromisso está na agenda de outra pessoa: o Google Agenda não será alterado.
          </p>
        ) : null}
        {editableDuration && info ? (
          <FormField>
            <FormLabel htmlFor="reschedule-duration">Duração no Google Agenda (minutos)</FormLabel>
            <Input
              id="reschedule-duration"
              name="durationMinutes"
              type="number"
              inputMode="numeric"
              step={5}
              defaultValue={info.durationMinutes}
            />
            <span className="text-meta text-text-tertiary">
              Mantida como está, a duração atual do evento não muda.
            </span>
          </FormField>
        ) : null}
        {error ? (
          <Alert variant="danger">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Salvando…" : "Reagendar"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
