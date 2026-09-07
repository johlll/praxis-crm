"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ROLES, ROLE_LABEL, type Role } from "@/lib/roles";
import { createInvitationAction, type TeamActionState } from "@/modules/team/actions";

const INITIAL_STATE: TeamActionState = { ok: false };
const DEFAULT_INVITE_ROLE: Role = "viewer";

export function InviteDialog() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createInvitationAction, INITIAL_STATE);
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    if (!state.inviteLink) return;
    try {
      await navigator.clipboard.writeText(state.inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sem permissão de clipboard — o link continua visível para copiar
      // manualmente, não é um erro que precise de mensagem própria.
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setCopied(false);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus size={14} aria-hidden />
          Convidar
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convidar para a equipe</DialogTitle>
          <DialogDescription>
            Gera um link de convite para copiar e enviar manualmente.
          </DialogDescription>
        </DialogHeader>

        {state.ok && state.inviteLink ? (
          <div className="flex flex-col gap-3">
            <Alert variant="success">
              <AlertDescription>Convite criado.</AlertDescription>
            </Alert>
            <div className="flex flex-col gap-1.5">
              <FormLabel htmlFor="invite-link">Link do convite</FormLabel>
              <div className="flex gap-2">
                <Input id="invite-link" readOnly value={state.inviteLink} />
                <Button type="button" variant="secondary" onClick={copyLink}>
                  {copied ? "Copiado" : "Copiar"}
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => setOpen(false)}>
                Concluir
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form action={formAction} className="flex flex-col gap-4">
            <FormField>
              <FormLabel htmlFor="invite-email">E-mail</FormLabel>
              <Input id="invite-email" name="email" type="email" required />
            </FormField>
            <FormField>
              <FormLabel htmlFor="invite-role">Papel</FormLabel>
              <select
                id="invite-role"
                name="role"
                defaultValue={DEFAULT_INVITE_ROLE}
                className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABEL[role]}
                  </option>
                ))}
              </select>
            </FormField>
            {state.error ? (
              <Alert variant="danger">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Criando…" : "Criar convite"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
