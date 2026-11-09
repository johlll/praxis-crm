"use client";

import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FormField, FormLabel } from "@/components/ui/form-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ROLE_LABEL } from "@/lib/roles";
import type { TeamMember } from "@/modules/team/queries";
import { transferOwnershipAction } from "@/modules/team/actions";

const displayName = (member: TeamMember) => member.fullName ?? member.email;

/**
 * Transferência de posse (B5). Confirmação explícita em dois passos: escolher
 * a pessoa e marcar que entende as consequências — o botão só habilita com as
 * duas coisas, e a Server Action recusa sem a confirmação. Quem chama só
 * renderiza isto para o proprietário; o banco decide de verdade.
 */
export function TransferOwnershipDialog({ members }: { members: TeamMember[] }) {
  const candidates = members.filter((member) => !member.isCurrentUser);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const chosen = candidates.find((member) => member.membershipId === target);

  // Abrir e fechar passam SEMPRE por aqui (Esc, clique fora, X, Cancelar e
  // sucesso): a escolha e a confirmação nunca sobram para a próxima abertura —
  // uma confirmação "já marcada" de antes anularia o passo explícito.
  function changeOpen(next: boolean) {
    setOpen(next);
    setTarget("");
    setConfirmed(false);
    setError(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chosen || !confirmed) return;
    const formData = new FormData();
    formData.set("membershipId", chosen.membershipId);
    formData.set("confirm", "yes");
    setError(null);
    startTransition(async () => {
      const result = await transferOwnershipAction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      changeOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="danger" size="sm">
          Transferir posse…
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transferir a posse do workspace</DialogTitle>
          <DialogDescription>Escolha quem passará a ser o proprietário.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <FormField>
            <FormLabel htmlFor="transfer-target">Novo proprietário</FormLabel>
            <select
              id="transfer-target"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
            >
              <option value="">Escolha uma pessoa</option>
              {candidates.map((member) => (
                <option key={member.membershipId} value={member.membershipId}>
                  {displayName(member)} — {ROLE_LABEL[member.role]}
                </option>
              ))}
            </select>
          </FormField>

          <Alert variant="warning">
            <AlertDescription>
              {chosen ? displayName(chosen) : "A pessoa escolhida"} passará a ser <strong>Proprietário</strong> e você
              passará a ser <strong>Administrador</strong>. Depois disso, só o novo proprietário poderá devolver a posse.
              A transferência fica registrada na auditoria.
            </AlertDescription>
          </Alert>

          <label className="flex items-start gap-2 text-small text-text">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5"
            />
            <span>Entendo que deixarei de ser o proprietário deste workspace.</span>
          </label>

          {error ? (
            <Alert variant="danger">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => changeOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="danger" disabled={!chosen || !confirmed || pending}>
              {pending ? "Transferindo…" : "Transferir posse"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
