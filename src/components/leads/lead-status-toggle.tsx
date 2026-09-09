"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { setLeadStatusAction, type LeadActionState } from "@/modules/leads/actions";
import type { LeadListItem } from "@/modules/leads/queries";

const INITIAL_STATE: LeadActionState = { ok: false };

export function LeadStatusToggle({ lead }: { lead: LeadListItem }) {
  const [state, formAction, pending] = useActionState(setLeadStatusAction, INITIAL_STATE);
  const nextStatus = lead.status === "ativo" ? "arquivado" : "ativo";

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={lead.id} />
      <input type="hidden" name="status" value={nextStatus} />
      <input type="hidden" name="expectedUpdatedAt" value={lead.updatedAt} />
      <Button type="submit" variant="secondary" size="sm" disabled={pending} className="self-start">
        {pending ? "Salvando…" : nextStatus === "arquivado" ? "Arquivar lead" : "Reabrir lead"}
      </Button>
      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
