"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EditForm } from "@/components/feedback/edit-form";
import { updateClientStatusAction, type ClientActionState } from "@/modules/clients/actions";
import type { ClientDetail } from "@/modules/clients/queries";
import { CLIENT_STATUSES } from "@/modules/clients/schema";

const STATUS_LABEL: Record<(typeof CLIENT_STATUSES)[number], string> = {
  ativo: "Ativo",
  encerrado: "Encerrado",
  suspenso: "Suspenso",
};

const INITIAL_STATE: ClientActionState = { ok: false };

export function ClientStatusForm({ client }: { client: ClientDetail }) {
  const [state, formAction, pending] = useActionState(updateClientStatusAction, INITIAL_STATE);
  // Controlados: com defaultValue, o React limpava o formulário ao fim do
  // envio e a tela voltava a mostrar o valor anterior ao salvo.
  const [status, setStatus] = useState(client.status);

  return (
    <EditForm action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="clientId" value={client.id} />
      <input type="hidden" name="lockVersion" value={client.lockVersion} />
      <div className="flex items-center gap-2">
        <select
          name="status"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          aria-label="Status do cliente"
          className="h-9 flex-1 rounded-input border border-border-input bg-surface px-3 text-body text-text"
        >
          {CLIENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          {pending ? "Salvando…" : "Salvar status"}
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
