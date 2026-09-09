"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LEAD_PRIORITIES } from "@/modules/leads/schema";
import { updateLeadBasicFieldsAction, type LeadActionState } from "@/modules/leads/actions";
import type { LeadListItem } from "@/modules/leads/queries";

const INITIAL_STATE: LeadActionState = { ok: false };

const PRIORITY_LABEL: Record<(typeof LEAD_PRIORITIES)[number], string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
};

export function LeadBasicFieldsForm({ lead, readOnly }: { lead: LeadListItem; readOnly: boolean }) {
  const [state, formAction, pending] = useActionState(updateLeadBasicFieldsAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="leadId" value={lead.id} />
      <input type="hidden" name="expectedUpdatedAt" value={lead.updatedAt} />

      <FormField>
        <FormLabel htmlFor="legalArea">Área jurídica</FormLabel>
        <Input id="legalArea" name="legalArea" defaultValue={lead.legalArea} required disabled={readOnly} />
      </FormField>

      <FormField>
        <FormLabel htmlFor="summary">Resumo</FormLabel>
        <textarea
          id="summary"
          name="summary"
          rows={3}
          defaultValue={lead.summary ?? ""}
          disabled={readOnly}
          className="rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text disabled:opacity-60"
        />
      </FormField>

      <FormField>
        <FormLabel htmlFor="tags">Etiquetas</FormLabel>
        <Input id="tags" name="tags" defaultValue={lead.tags.join(", ")} disabled={readOnly} />
      </FormField>

      <FormField>
        <FormLabel htmlFor="priority">Prioridade</FormLabel>
        <select
          id="priority"
          name="priority"
          defaultValue={lead.priority}
          disabled={readOnly}
          className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text disabled:opacity-60"
        >
          {LEAD_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {PRIORITY_LABEL[priority]}
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

      {readOnly ? null : (
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? "Salvando…" : "Salvar"}
        </Button>
      )}
    </form>
  );
}
