"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EditForm } from "@/components/feedback/edit-form";
import { CONTACT_CHANNELS } from "@/modules/contacts/schema";
import { updateContactBasicFieldsAction, type ContactActionState } from "@/modules/contacts/actions";
import type { ContactDetail } from "@/modules/contacts/queries";

const INITIAL_STATE: ContactActionState = { ok: false };

const CHANNEL_LABEL: Record<(typeof CONTACT_CHANNELS)[number], string> = {
  whatsapp: "WhatsApp",
  email: "E-mail",
  telefone: "Telefone",
  presencial: "Presencial",
};

export function ContactBasicFieldsForm({ contact }: { contact: ContactDetail }) {
  const [state, formAction, pending] = useActionState(updateContactBasicFieldsAction, INITIAL_STATE);
  // Controlados: com defaultValue, o React limpava o formulário ao fim do
  // envio e a tela voltava a mostrar o valor anterior ao salvo.
  const [name, setName] = useState(contact.name);
  const [city, setCity] = useState(contact.city ?? "");
  const [uf, setUf] = useState(contact.uf ?? "");
  const [preferredChannel, setPreferredChannel] = useState(contact.preferredChannel ?? "");

  return (
    <EditForm action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="contactId" value={contact.id} />
      <FormField>
        <FormLabel htmlFor="name">Nome</FormLabel>
        <Input id="name" name="name" value={name} onChange={(e) => setName(e.target.value)} required />
      </FormField>
      <div className="grid grid-cols-[1fr_80px] gap-3">
        <FormField>
          <FormLabel htmlFor="city">Cidade</FormLabel>
          <Input id="city" name="city" value={city} onChange={(e) => setCity(e.target.value)} />
        </FormField>
        <FormField>
          <FormLabel htmlFor="uf">UF</FormLabel>
          <Input id="uf" name="uf" maxLength={2} value={uf} onChange={(e) => setUf(e.target.value)} />
        </FormField>
      </div>
      <FormField>
        <FormLabel htmlFor="preferredChannel">Canal preferido</FormLabel>
        <select
          id="preferredChannel"
          name="preferredChannel"
          value={preferredChannel}
          onChange={(e) => setPreferredChannel(e.target.value)}
          className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
        >
          <option value="">Não informado</option>
          {CONTACT_CHANNELS.map((channel) => (
            <option key={channel} value={channel}>
              {CHANNEL_LABEL[channel]}
            </option>
          ))}
        </select>
      </FormField>
      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.ok ? (
        <Alert variant="success">
          <AlertDescription>Dados salvos.</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Salvando…" : "Salvar"}
      </Button>
    </EditForm>
  );
}
