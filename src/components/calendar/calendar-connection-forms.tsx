"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  connectCalendarAction,
  disconnectCalendarAction,
  recoverCalendarLinksAction,
  selectCalendarAction,
  type CalendarActionState,
} from "@/modules/calendar/actions";

const INITIAL: CalendarActionState = { ok: false };

function ErrorLine({ state }: { state: CalendarActionState }) {
  if (!state.error) return null;
  return (
    <Alert variant="danger">
      <AlertDescription>{state.error}</AlertDescription>
    </Alert>
  );
}

function MessageLine({ state }: { state: CalendarActionState }) {
  if (!state.ok || !state.message) return null;
  return (
    <Alert variant="success">
      <AlertDescription>{state.message}</AlertDescription>
    </Alert>
  );
}

export function ConnectCalendarForm() {
  const [state, action, pending] = useActionState(connectCalendarAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-2">
      <label htmlFor="calendar-authorization" className="text-meta text-text-tertiary">
        Conta a conectar (ambiente de desenvolvimento, provedor simulado)
      </label>
      <div className="flex gap-2">
        <Input id="calendar-authorization" name="authorization" placeholder="conta@dominio.com" />
        <Button type="submit" disabled={pending}>
          Conectar
        </Button>
      </div>
      <ErrorLine state={state} />
    </form>
  );
}

export function SelectCalendarForm({
  connectionId,
  calendars,
}: {
  connectionId: string;
  calendars: Array<{ id: string; summary: string }>;
}) {
  const [state, action, pending] = useActionState(selectCalendarAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="connectionId" value={connectionId} />
      <label htmlFor={`calendar-${connectionId}`} className="text-meta text-text-tertiary">
        Agenda que será vinculada
      </label>
      <div className="flex gap-2">
        <select
          id={`calendar-${connectionId}`}
          name="calendarId"
          className="h-8 flex-1 rounded-md border border-border bg-surface px-2 text-body"
          defaultValue=""
        >
          <option value="" disabled>
            Escolha uma agenda
          </option>
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.summary}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={pending}>
          Vincular
        </Button>
      </div>
      <ErrorLine state={state} />
    </form>
  );
}

export function DisconnectCalendarForm({ connectionId }: { connectionId: string }) {
  const [state, action, pending] = useActionState(disconnectCalendarAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="connectionId" value={connectionId} />
      <Button type="submit" variant="secondary" disabled={pending}>
        Desconectar
      </Button>
      <p className="text-meta text-text-tertiary">
        Os tokens deste ambiente são apagados. Nenhum evento do Google nem compromisso do CRM é removido.
      </p>
      <ErrorLine state={state} />
    </form>
  );
}

/**
 * Reconexão (§6.5): ao conectar e escolher a agenda, os compromissos de uma
 * desconexão anterior são reencontrados automaticamente. Este botão repete a
 * busca e mostra o resultado (o Google pode ter falhado na primeira vez).
 */
export function RecoverCalendarLinksForm() {
  const [state, action, pending] = useActionState(recoverCalendarLinksAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-2">
      <Button type="submit" variant="secondary" disabled={pending}>
        Reencontrar compromissos
      </Button>
      <p className="text-meta text-text-tertiary">
        Volta a vincular, depois de conferir no Google, os compromissos de uma conexão anterior desta conta.
      </p>
      <MessageLine state={state} />
      <ErrorLine state={state} />
    </form>
  );
}
