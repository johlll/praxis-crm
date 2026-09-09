"use client";

import { useActionState, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { createOpportunityAction, type OpportunityActionState } from "@/modules/opportunities/actions";
import type { OpportunityListItem } from "@/modules/opportunities/queries";

const INITIAL_STATE: OpportunityActionState = { ok: false };

const STATUS_LABEL: Record<OpportunityListItem["status"], string> = {
  open: "Aberta",
  won: "Ganha",
  lost: "Perdida",
};

export function LeadOpportunitiesSection({
  leadId,
  opportunities,
  canEdit,
}: {
  leadId: string;
  opportunities: OpportunityListItem[];
  canEdit: boolean;
}) {
  const [state, formAction, pending] = useActionState(createOpportunityAction, INITIAL_STATE);
  const [creating, setCreating] = useState(false);

  // Fecha o formulário quando um submit passa de pendente para
  // bem-sucedido — computado durante o render (não em useEffect) seguindo
  // o padrão do próprio React para "ajustar estado quando algo muda":
  // https://react.dev/learn/you-might-not-need-an-effect.
  const [lastOk, setLastOk] = useState(state.ok);
  if (state.ok !== lastOk) {
    setLastOk(state.ok);
    if (state.ok) setCreating(false);
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-body font-semibold text-text">
          Oportunidades {opportunities.length > 0 ? `(${opportunities.length})` : ""}
        </h2>
        {canEdit && !creating ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => setCreating(true)}>
            Nova oportunidade
          </Button>
        ) : null}
      </div>

      {opportunities.length === 0 && !creating ? (
        <p className="text-body text-text-tertiary">Nenhuma oportunidade ainda para este lead.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {opportunities.map((opp) => (
            <li key={opp.id}>
              <Link
                href={`/oportunidades/${opp.id}`}
                className="flex items-center justify-between rounded-input border border-border px-3 py-2 hover:bg-app"
              >
                <span className="text-body text-text">{opp.stageName}</span>
                <span className="text-meta text-text-tertiary">{STATUS_LABEL[opp.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <form action={formAction} className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
          <input type="hidden" name="leadId" value={leadId} />
          {state.error ? (
            <Alert variant="danger">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <p className="text-meta text-text-tertiary">
            Cria a oportunidade na primeira etapa do pipeline padrão do workspace.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setCreating(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Criando…" : "Criar oportunidade"}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
