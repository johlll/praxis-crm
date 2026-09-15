"use client";

import { useState, useTransition } from "react";

import { ROLE_LABEL } from "@/lib/roles";
import type { PendingInvitation } from "@/modules/team/queries";
import { cancelInvitationAction } from "@/modules/team/actions";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function PendingInvitationRow({
  invitation,
}: {
  invitation: PendingInvitation;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function cancel() {
    const formData = new FormData();
    formData.set("invitationId", invitation.id);
    setError(null);
    startTransition(async () => {
      const result = await cancelInvitationAction(formData);
      if (!result.ok) setError(result.error);
    });
  }

  const expiresAt = new Date(invitation.expiresAt).toLocaleDateString("pt-BR");

  return (
    <div className="flex flex-col gap-2 border-b border-border-subtle px-4 py-3 last:border-0">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-small font-semibold text-text">
            {invitation.email}
          </span>
          <span className="truncate text-meta text-text-tertiary">
            {ROLE_LABEL[invitation.role]} · expira em {expiresAt}
          </span>
        </div>
        <Button variant="ghost" size="sm" disabled={isPending} onClick={cancel}>
          Cancelar
        </Button>
      </div>
      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
