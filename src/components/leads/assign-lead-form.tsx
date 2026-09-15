"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EditForm } from "@/components/feedback/edit-form";
import { assignLeadAction, type LeadActionState } from "@/modules/leads/actions";
import type { LeadListItem } from "@/modules/leads/queries";
import type { TeamMember } from "@/modules/team/queries";

const INITIAL_STATE: LeadActionState = { ok: false };

export function AssignLeadForm({ lead, members }: { lead: LeadListItem; members: TeamMember[] }) {
  const [state, formAction, pending] = useActionState(assignLeadAction, INITIAL_STATE);
  // Controlado + EditForm: sem isso o seletor voltava ao responsável anterior
  // depois de salvar (reproduzido no preview; ver components/feedback/edit-form.tsx).
  const [assignedTo, setAssignedTo] = useState(lead.assignedTo ?? "");

  return (
    <EditForm action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="leadId" value={lead.id} />
      <input type="hidden" name="expectedUpdatedAt" value={lead.updatedAt} />
      <div className="flex items-center gap-2">
        <select
          name="assignedTo"
          value={assignedTo}
          onChange={(e) => setAssignedTo(e.target.value)}
          className="h-9 flex-1 rounded-input border border-border-input bg-surface px-3 text-body text-text"
        >
          <option value="">Sem responsável</option>
          {members.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.fullName ?? member.email}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          {pending ? "Salvando…" : "Atribuir"}
        </Button>
      </div>
      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </EditForm>
  );
}
