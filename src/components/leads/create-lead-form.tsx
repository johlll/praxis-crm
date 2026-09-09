"use client";

import { useActionState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LEAD_PRIORITIES } from "@/modules/leads/schema";
import { createLeadAction, type LeadActionState } from "@/modules/leads/actions";
import type { ContactOption } from "@/modules/leads/queries";
import type { TeamMember } from "@/modules/team/queries";

const INITIAL_STATE: LeadActionState = { ok: false };

const PRIORITY_LABEL: Record<(typeof LEAD_PRIORITIES)[number], string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
};

export function CreateLeadForm({
  contacts,
  members,
  canSetValue,
  defaultContactId,
}: {
  contacts: ContactOption[];
  members: TeamMember[];
  canSetValue: boolean;
  defaultContactId?: string | undefined;
}) {
  const [state, formAction, pending] = useActionState(createLeadAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormField>
        <FormLabel htmlFor="contactId">Contato</FormLabel>
        {contacts.length === 0 ? (
          <p className="text-meta text-text-tertiary">
            Nenhum contato cadastrado ainda —{" "}
            <Link href="/contatos/novo" className="text-primary underline">
              crie um contato primeiro
            </Link>
            .
          </p>
        ) : (
          <select
            id="contactId"
            name="contactId"
            required
            defaultValue={defaultContactId ?? ""}
            className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
          >
            <option value="" disabled>
              Selecione um contato
            </option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
        )}
      </FormField>

      <FormField>
        <FormLabel htmlFor="legalArea">Área jurídica</FormLabel>
        <Input id="legalArea" name="legalArea" required placeholder="Trabalhista, Cível, Família…" />
      </FormField>

      <FormField>
        <FormLabel htmlFor="summary">Resumo</FormLabel>
        <textarea
          id="summary"
          name="summary"
          rows={3}
          placeholder="O que a pessoa precisa"
          className="rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text"
        />
      </FormField>

      <FormField>
        <FormLabel htmlFor="tags">Etiquetas</FormLabel>
        <Input id="tags" name="tags" placeholder="urgente, audiência marcada (separadas por vírgula)" />
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <FormField>
          <FormLabel htmlFor="priority">Prioridade</FormLabel>
          <select
            id="priority"
            name="priority"
            defaultValue="media"
            className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
          >
            {LEAD_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_LABEL[priority]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField>
          <FormLabel htmlFor="assignedTo">Responsável</FormLabel>
          <select
            id="assignedTo"
            name="assignedTo"
            defaultValue=""
            className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
          >
            <option value="">Sem responsável</option>
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.fullName ?? member.email}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      {canSetValue ? (
        <FormField>
          <FormLabel htmlFor="estimatedValue">Valor estimado de honorários (opcional)</FormLabel>
          <Input id="estimatedValue" name="estimatedValue" placeholder="5.500,00" inputMode="decimal" />
        </FormField>
      ) : null}

      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" disabled={pending || contacts.length === 0} className="w-full">
        {pending ? "Criando…" : "Criar lead"}
      </Button>
    </form>
  );
}
