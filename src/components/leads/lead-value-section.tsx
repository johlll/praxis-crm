"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { setLeadValueAction, type LeadActionState } from "@/modules/leads/actions";
import type { LeadListItem } from "@/modules/leads/queries";

const INITIAL_STATE: LeadActionState = { ok: false };

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * O que aparece como "valor atual" é exatamente o que a resposta trouxe —
 * nunca inventa um formato: exato pra quem pode ver o exato, faixa pra
 * quem só pode ver faixa (atendimento nunca vê o número que ele mesmo
 * digitou de volta, só a faixa — é assim que a matriz do plano pede).
 */
export function LeadValueSection({ lead }: { lead: LeadListItem }) {
  const [state, formAction, pending] = useActionState(setLeadValueAction, INITIAL_STATE);

  const currentLabel =
    lead.estimatedValueCents != null
      ? formatCents(lead.estimatedValueCents)
      : (lead.estimatedValueBand ?? "Não informado");

  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-text">
        Valor atual: <span className="font-semibold">{currentLabel}</span>
      </p>
      <form action={formAction} className="flex items-end gap-2">
        <input type="hidden" name="leadId" value={lead.id} />
        <input type="hidden" name="expectedUpdatedAt" value={lead.valueUpdatedAt ?? ""} />
        <FormField className="flex-1">
          <FormLabel htmlFor="estimatedValue">Novo valor estimado</FormLabel>
          <Input id="estimatedValue" name="estimatedValue" placeholder="5.500,00" inputMode="decimal" />
        </FormField>
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          {pending ? "Salvando…" : "Atualizar"}
        </Button>
      </form>
      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.ok ? (
        <Alert variant="success">
          <AlertDescription>Valor atualizado.</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
