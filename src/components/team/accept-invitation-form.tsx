"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { acceptInvitationAction, type AcceptInvitationState } from "@/modules/team/actions";

const INITIAL_STATE: AcceptInvitationState = { ok: false };

export function AcceptInvitationForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(acceptInvitationAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Entrando no workspace…" : "Aceitar convite"}
      </Button>
    </form>
  );
}
