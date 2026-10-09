"use client";

import { useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { checkSlotAvailabilityAction } from "@/modules/calendar/appointment-actions";
import {
  DEFAULT_APPOINTMENT_MINUTES,
  MAX_APPOINTMENT_MINUTES,
  MIN_APPOINTMENT_MINUTES,
} from "@/modules/calendar/types";
import { formatTime } from "@/lib/timezone";

type Availability = { state: "free" } | { state: "busy"; busy: Array<{ start: string; end: string }> } | { state: "error"; message: string };

/**
 * Campos do Google Agenda de um compromisso: adicionar à agenda, duração,
 * Meet, checagem de disponibilidade e convidados.
 *
 * Convidados são a única opção que faz o Google ENVIAR e-mail: ficam
 * desligados, só aparecem quando o usuário os digita e exigem uma confirmação
 * explícita, dita com todas as letras. Nada aqui é marcado por padrão.
 *
 * Os nomes dos campos são os mesmos das ações de servidor
 * (`calendarAdd`, `durationMinutes`, `withMeet`, `requireFree`,
 * `inviteEmails`, `confirmInvites`).
 */
export function CalendarOptionsFields({
  idPrefix,
  alwaysOn = false,
  getSlot,
}: {
  idPrefix: string;
  /** Quando o formulário já é "adicionar à agenda", a caixa de ligar some. */
  alwaysOn?: boolean;
  /** Data e hora digitadas no formulário, para a checagem de disponibilidade. */
  getSlot: (form: HTMLFormElement) => { dueDate: string; dueTime: string } | null;
}) {
  const [enabled, setEnabled] = useState(alwaysOn);
  const [duration, setDuration] = useState(String(DEFAULT_APPOINTMENT_MINUTES));
  const [invites, setInvites] = useState("");
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [checking, startChecking] = useTransition();
  const anchor = useRef<HTMLDivElement>(null);

  function handleCheck() {
    const form = anchor.current?.closest("form");
    const slot = form ? getSlot(form) : null;
    if (!slot) {
      setAvailability({ state: "error", message: "Informe a data e o horário antes de verificar." });
      return;
    }
    const data = new FormData();
    data.set("dueDate", slot.dueDate);
    data.set("dueTime", slot.dueTime);
    data.set("durationMinutes", duration || String(DEFAULT_APPOINTMENT_MINUTES));
    startChecking(async () => {
      const result = await checkSlotAvailabilityAction({ ok: false }, data);
      if (!result.ok) setAvailability({ state: "error", message: result.error ?? "Não foi possível verificar." });
      else if ((result.busy ?? []).length === 0) setAvailability({ state: "free" });
      else setAvailability({ state: "busy", busy: result.busy ?? [] });
    });
  }

  return (
    <div ref={anchor} className="flex flex-col gap-3 rounded-input border border-border-subtle p-3" data-testid="calendar-options">
      {alwaysOn ? (
        <input type="hidden" name="calendarAdd" value="on" />
      ) : (
        <label className="flex items-center gap-2 text-body text-text">
          <input
            type="checkbox"
            name="calendarAdd"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Adicionar ao Google Agenda
        </label>
      )}

      {enabled ? (
        <>
          <FormField>
            <FormLabel htmlFor={`${idPrefix}-duration`}>Duração (minutos)</FormLabel>
            <Input
              id={`${idPrefix}-duration`}
              name="durationMinutes"
              type="number"
              inputMode="numeric"
              min={MIN_APPOINTMENT_MINUTES}
              max={MAX_APPOINTMENT_MINUTES}
              step={5}
              value={duration}
              onChange={(e) => {
                setDuration(e.target.value);
                setAvailability(null);
              }}
            />
            <span className="text-meta text-text-tertiary">
              Entre {MIN_APPOINTMENT_MINUTES} e {MAX_APPOINTMENT_MINUTES} minutos. Padrão: {DEFAULT_APPOINTMENT_MINUTES}.
            </span>
          </FormField>

          <label className="flex items-center gap-2 text-body text-text">
            <input type="checkbox" name="withMeet" />
            Criar link do Google Meet
          </label>

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" size="sm" disabled={checking} onClick={handleCheck}>
                {checking ? "Verificando…" : "Verificar disponibilidade"}
              </Button>
              <label className="flex items-center gap-2 text-small text-text-secondary">
                <input type="checkbox" name="requireFree" />
                Só criar se o horário estiver livre
              </label>
            </div>
            {availability?.state === "free" ? (
              <p className="text-small text-success" role="status">
                Horário livre na sua agenda.
              </p>
            ) : null}
            {availability?.state === "busy" ? (
              <p className="text-small text-warning" role="status">
                Ocupado na sua agenda:{" "}
                {availability.busy.map((b) => `${formatTime(b.start)}–${formatTime(b.end)}`).join(", ")}.
              </p>
            ) : null}
            {availability?.state === "error" ? (
              <p className="text-small text-danger" role="alert">
                {availability.message}
              </p>
            ) : null}
          </div>

          <FormField>
            <FormLabel htmlFor={`${idPrefix}-invites`}>Convidados (opcional)</FormLabel>
            <textarea
              id={`${idPrefix}-invites`}
              name="inviteEmails"
              rows={2}
              maxLength={2000}
              placeholder="email1@exemplo.com, email2@exemplo.com"
              value={invites}
              onChange={(e) => setInvites(e.target.value)}
              className="rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text"
            />
            <span className="text-meta text-text-tertiary">
              Por padrão ninguém é convidado e nenhum e-mail é enviado.
            </span>
          </FormField>

          {invites.trim() ? (
            <label className="flex items-start gap-2 text-small text-text" data-testid="invite-confirmation">
              <input type="checkbox" name="confirmInvites" className="mt-0.5" />
              <span>
                Confirmo: o Google vai <strong>enviar um e-mail de convite</strong> para essas pessoas.
              </span>
            </label>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
