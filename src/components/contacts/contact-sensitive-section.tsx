"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SensitiveField } from "./sensitive-field";
import { clearCpfCnpjAction, setCpfCnpjAction, type ContactActionState } from "@/modules/contacts/actions";

const INITIAL_STATE: ContactActionState = { ok: false };

export function ContactSensitiveSection({
  contactId,
  hasSensitive,
}: {
  contactId: string;
  hasSensitive: boolean;
}) {
  const [state, formAction, pending] = useActionState(setCpfCnpjAction, INITIAL_STATE);

  if (hasSensitive && !state.ok) {
    return (
      <div className="flex items-center justify-between gap-3">
        <SensitiveField contactId={contactId} />
        <form action={clearCpfCnpjAction}>
          <input type="hidden" name="contactId" value={contactId} />
          <Button type="submit" variant="ghost" size="sm">
            Remover
          </Button>
        </form>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="contactId" value={contactId} />
      <p className="text-meta text-text-tertiary">
        Opcional — só cadastre quando for realmente necessário para o caso.
      </p>
      <div className="flex gap-2">
        <Input name="value" placeholder="Somente números" inputMode="numeric" className="max-w-[220px]" />
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          {pending ? "Salvando…" : "Cadastrar"}
        </Button>
      </div>
      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
