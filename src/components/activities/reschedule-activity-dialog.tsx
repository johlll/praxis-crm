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
import { rescheduleActivityAction } from "@/modules/activities/actions";
import type { ActivityListItem } from "@/modules/activities/queries";

/** "YYYY-MM-DDTHH:mm" (ISO local) → partes separadas pro <input type=date>/<input type=time>
 * — exibidas no fuso America/Sao_Paulo (mesmo fuso que o servidor usa pra
 * montar o instante de volta ao salvar; ver comentário na migration da A6). */
function toDateInputParts(iso: string, hasTime: boolean): { date: string; time: string } {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const time = hasTime ? `${get("hour")}:${get("minute")}` : "";
  return { date, time };
}

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
  const initial = toDateInputParts(activity.dueAt, activity.hasTime);

  function handleSubmit(formData: FormData) {
    const dueDate = String(formData.get("dueDate") ?? "");
    const dueTime = String(formData.get("dueTime") ?? "");
    setError(null);
    startTransition(async () => {
      const result = await rescheduleActivityAction(activity.id, activity.lockVersion, dueDate, dueTime, {
        leadId: activity.leadId,
        ...(activity.opportunityId ? { opportunityId: activity.opportunityId } : {}),
      });
      if (result.ok) onDone();
      else setError(result.error ?? "Não foi possível reagendar.");
    });
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
