"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EditForm } from "@/components/feedback/edit-form";
import { transferClientOwnerAction, type ClientActionState } from "@/modules/clients/actions";
import type { ClientDetail } from "@/modules/clients/queries";
import type { TeamMember } from "@/modules/team/queries";

const INITIAL_STATE: ClientActionState = { ok: false };

export function TransferClientOwnerForm({ client, members }: { client: ClientDetail; members: TeamMember[] }) {
  const [state, formAction, pending] = useActionState(transferClientOwnerAction, INITIAL_STATE);
  // Controlados: com defaultValue, o React limpava o formulário ao fim do
  // envio e a tela voltava a mostrar o valor anterior ao salvo.
  const [ownerUserId, setOwnerUserId] = useState(client.ownerUserId ?? "");

  return (
    <EditForm action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="clientId" value={client.id} />
      <input type="hidden" name="lockVersion" value={client.lockVersion} />
      <div className="flex items-center gap-2">
        <select
          name="ownerUserId"
          value={ownerUserId}
          onChange={(e) => setOwnerUserId(e.target.value)}
          aria-label="Responsável pelo cliente"
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
          {pending ? "Salvando…" : "Transferir"}
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
