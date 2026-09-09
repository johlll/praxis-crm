"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CONTACT_CHANNELS, CONTACT_TYPES } from "@/modules/contacts/schema";
import { createContactAction, type ContactActionState } from "@/modules/contacts/actions";

const INITIAL_STATE: ContactActionState = { ok: false };

const TYPE_LABEL: Record<(typeof CONTACT_TYPES)[number], string> = {
  pf: "Pessoa física",
  pj: "Pessoa jurídica",
};

const CHANNEL_LABEL: Record<(typeof CONTACT_CHANNELS)[number], string> = {
  whatsapp: "WhatsApp",
  email: "E-mail",
  telefone: "Telefone",
  presencial: "Presencial",
};

export function CreateContactForm() {
  const [state, formAction, pending] = useActionState(createContactAction, INITIAL_STATE);
  const [wantsCpf, setWantsCpf] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormField>
        <FormLabel htmlFor="type">Tipo</FormLabel>
        <select
          id="type"
          name="type"
          defaultValue="pf"
          className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
        >
          {CONTACT_TYPES.map((type) => (
            <option key={type} value={type}>
              {TYPE_LABEL[type]}
            </option>
          ))}
        </select>
      </FormField>

      <FormField>
        <FormLabel htmlFor="name">Nome</FormLabel>
        <Input id="name" name="name" required placeholder="Nome completo ou razão social" />
      </FormField>

      <div className="grid grid-cols-[1fr_80px] gap-3">
        <FormField>
          <FormLabel htmlFor="city">Cidade</FormLabel>
          <Input id="city" name="city" placeholder="São Paulo" />
        </FormField>
        <FormField>
          <FormLabel htmlFor="uf">UF</FormLabel>
          <Input id="uf" name="uf" maxLength={2} placeholder="SP" />
        </FormField>
      </div>

      <FormField>
        <FormLabel htmlFor="preferredChannel">Canal preferido</FormLabel>
        <select
          id="preferredChannel"
          name="preferredChannel"
          defaultValue=""
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

      <FormField>
        <FormLabel htmlFor="phone">Telefone</FormLabel>
        <Input id="phone" name="phone" placeholder="(11) 99999-9999" />
      </FormField>

      <FormField>
        <FormLabel htmlFor="email">E-mail</FormLabel>
        <Input id="email" name="email" type="email" placeholder="contato@exemplo.com" />
      </FormField>

      <FormField>
        <label className="flex items-center gap-2 text-body text-text">
          <input
            type="checkbox"
            checked={wantsCpf}
            onChange={(event) => setWantsCpf(event.target.checked)}
            className="size-4 rounded border-border-input"
          />
          Cadastrar CPF/CNPJ
        </label>
        <p className="text-meta text-text-tertiary">
          Opcional — só cadastre quando for realmente necessário para o caso.
        </p>
        {wantsCpf ? (
          <Input name="cpfCnpj" placeholder="Somente números" inputMode="numeric" />
        ) : null}
      </FormField>

      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Criando…" : "Criar contato"}
      </Button>
    </form>
  );
}
