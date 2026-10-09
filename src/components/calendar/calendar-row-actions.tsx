"use client";

import { useActionState, useState, useTransition } from "react";
import { CalendarPlus, CalendarX2, RefreshCw, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { dateTimeInputParts, formatTime } from "@/lib/timezone";
import {
  addMeetAction,
  cancelAppointmentAction,
  createAppointmentAction,
  recoverUncertainCreateAction,
  rescheduleAppointmentAction,
  type AppointmentActionState,
} from "@/modules/calendar/appointment-actions";
import type { ActivityListItem } from "@/modules/activities/queries";
import { CalendarOptionsFields } from "./calendar-options-fields";
import { useCalendarCapabilities } from "./calendar-capabilities";

type Feedback = { level: "success" | "warning" | "danger"; text: string; meetUrl?: string | null } | null;

function formDataFor(activityId: string): FormData {
  const data = new FormData();
  data.set("activityId", activityId);
  return data;
}

/** O que mostrar depois de uma ação: SEMPRE a mensagem do resultado concreto
 * que o servidor devolveu (removido ≠ mantido; Meet pronto ≠ em criação;
 * conflito; incerto) — nunca um texto fixo de sucesso. */
function feedbackOf(result: AppointmentActionState): Feedback {
  if (result.notice) {
    return {
      level: result.notice.level === "warning" ? "warning" : "success",
      text: result.notice.message,
      meetUrl: result.notice.meetUrl ?? null,
    };
  }
  if (!result.ok) return { level: "danger", text: result.error ?? "Não foi possível concluir." };
  return { level: "success", text: "Feito." };
}

/**
 * Ações de agenda de um compromisso: adicionar ao Google Agenda, criar o
 * Meet, sincronizar/verificar de novo e remover da agenda. Um vínculo
 * EXISTENTE sempre mostra os seus controles, qualquer que seja o tipo ou o
 * horário atual da atividade; "adicionar" é só para reunião com horário,
 * pendente.
 */
export function CalendarRowActions({ activity }: { activity: ActivityListItem }) {
  const caps = useCalendarCapabilities();
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<Feedback>(null);

  if (!caps.enabled || !caps.canUse) return null;

  const info = activity.calendar;
  const mine = info?.isMine === true;
  const live = !!info && info.status !== "cancelled_in_google" && info.status !== "missing_in_google" && info.status !== "not_linked";
  const showRecover = mine && info.status === "not_linked";
  const showMeet = mine && live && info.status === "linked" && info.syncState === "in_sync" && !info.meetUrl && info.meetStatus !== "pending";
  const needsSync = mine && live && (info.status === "needs_attention" || (info.syncState !== "in_sync" && info.syncOperation !== "delete"));
  const showRemove = mine && live;
  const showAdd =
    !info && caps.hasConnection && activity.type === "meeting" && activity.hasTime && activity.status === "pending";
  if (!showRecover && !showMeet && !needsSync && !showRemove && !showAdd && !feedback) return null;

  function run(action: (prev: AppointmentActionState, data: FormData) => Promise<AppointmentActionState>) {
    setFeedback(null);
    startTransition(async () => {
      setFeedback(feedbackOf(await action({ ok: false }, formDataFor(activity.id))));
    });
  }

  function handleRemove() {
    if (!window.confirm(`Remover "${activity.title}" do Google Agenda? A atividade continua no CRM.`)) return;
    run(cancelAppointmentAction);
  }

  const uncertain = info?.syncState === "uncertain";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {showRecover ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={isPending}
            aria-label={`Verificar inclusão de ${activity.title} no Google Agenda`}
            title="Consulta o Google Agenda antes de qualquer nova tentativa"
            onClick={() => run(recoverUncertainCreateAction)}
          >
            Verificar inclusão
          </Button>
        ) : null}
        {showMeet ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            aria-label={`Criar link do Meet para ${activity.title}`}
            title="Criar link do Google Meet"
            onClick={() => run(addMeetAction)}
          >
            <Video size={14} aria-hidden />
          </Button>
        ) : null}
        {needsSync ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            aria-label={`${uncertain ? "Verificar" : "Sincronizar"} ${activity.title} com o Google Agenda`}
            title={uncertain ? "Consulta o Google Agenda antes de repetir" : "Sincronizar de novo"}
            onClick={() => run(rescheduleAppointmentAction)}
          >
            <RefreshCw size={14} aria-hidden />
          </Button>
        ) : null}
        {showRemove ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            aria-label={`Remover ${activity.title} do Google Agenda`}
            title="Remover do Google Agenda"
            onClick={handleRemove}
          >
            <CalendarX2 size={14} aria-hidden />
          </Button>
        ) : null}
        {showAdd ? <AddToCalendarDialog activity={activity} /> : null}
      </div>
      {feedback ? (
        <Alert variant={feedback.level} data-testid="calendar-row-feedback">
          <AlertDescription>
            {feedback.text}
            {feedback.meetUrl ? (
              <>
                {" "}
                <a href={feedback.meetUrl} target="_blank" rel="noopener noreferrer" className="underline">
                  Link do Meet
                </a>
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function AddToCalendarDialog({ activity }: { activity: ActivityListItem }) {
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
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Adicionar ${activity.title} ao Google Agenda`}
          title="Adicionar ao Google Agenda"
        >
          <CalendarPlus size={14} aria-hidden />
        </Button>
      </DialogTrigger>
      <AddToCalendarBody key={instanceKey} activity={activity} onDone={() => setOpen(false)} />
    </Dialog>
  );
}

function AddToCalendarBody({ activity, onDone }: { activity: ActivityListItem; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(createAppointmentAction, { ok: false } as AppointmentActionState);
  const slot = dateTimeInputParts(activity.dueAt, activity.hasTime);

  if (state.ok) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adicionado ao Google Agenda</DialogTitle>
        </DialogHeader>
        <Alert variant="success">
          <AlertDescription>
            {state.notice?.message ?? "O compromisso já está na sua agenda."}
            {state.meetUrl ? (
              <>
                {" "}
                <a href={state.meetUrl} target="_blank" rel="noopener noreferrer" className="underline">
                  Link do Meet
                </a>
              </>
            ) : null}
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
        <DialogTitle>Adicionar ao Google Agenda</DialogTitle>
        <DialogDescription>&quot;{activity.title}&quot; será criado na sua agenda.</DialogDescription>
      </DialogHeader>
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="activityId" value={activity.id} />
        <CalendarOptionsFields
          idPrefix={`add-${activity.id}`}
          alwaysOn
          getSlot={() => ({ dueDate: slot.date, dueTime: slot.time })}
        />
        {state.result === "busy" ? (
          <Alert variant="warning">
            <AlertDescription>
              O horário está ocupado na sua agenda (
              {(state.busy ?? []).map((b) => `${formatTime(b.start)}–${formatTime(b.end)}`).join(", ")}). Nada foi criado.
            </AlertDescription>
          </Alert>
        ) : state.notice ? (
          <Alert variant="warning" data-testid="calendar-row-feedback">
            <AlertDescription>{state.notice.message}</AlertDescription>
          </Alert>
        ) : state.error ? (
          <Alert variant="danger">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {pending ? "Adicionando…" : "Adicionar à agenda"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
