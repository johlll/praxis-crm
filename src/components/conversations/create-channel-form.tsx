"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { createWhatsAppChannelAction, type ActionState } from "@/modules/conversations/actions";

const INITIAL_STATE: ActionState = { ok: false };

export function CreateChannelForm({ workspaceId }: { workspaceId: string }) {
  const [state, formAction, pending] = useActionState(createWhatsAppChannelAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-3 border-t border-border pt-3">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <div className="grid grid-cols-2 gap-3">
        <FormField>
          <FormLabel htmlFor="channel-label">Nome do canal</FormLabel>
          <Input id="channel-label" name="label" required maxLength={120} placeholder="Ex.: WhatsApp comercial" />
        </FormField>
        <FormField>
          <FormLabel htmlFor="channel-display-number">Número (fictício)</FormLabel>
          <Input id="channel-display-number" name="displayPhoneNumber" required placeholder="+55 11 99999-0000" />
        </FormField>
      </div>
      <FormField>
        <FormLabel htmlFor="channel-phone-number-id">Identificador do número (phone_number_id)</FormLabel>
        <Input
          id="channel-phone-number-id"
          name="phoneNumberId"
          required
          maxLength={64}
          placeholder="Ex.: sim-escritorio-um-001 (só precisa ser único)"
        />
      </FormField>
      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Criando…" : "Criar canal"}
        </Button>
      </div>
    </form>
  );
}
