"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
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
import { unmergeContactAction, type MergeState } from "@/modules/contacts/actions";
import type { ContactMergeHistoryItem } from "@/modules/contacts/queries";

const INITIAL_STATE: MergeState = { ok: false };

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function UndoMergeButton({ contactId, mergeId, mergedContactName }: {
  contactId: string;
  mergeId: string;
  mergedContactName: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(unmergeContactAction, INITIAL_STATE);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          Desfazer mesclagem
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Desfazer esta mesclagem?</DialogTitle>
          <DialogDescription>
            {mergedContactName} volta a existir como contato separado, com os dados que tinham sido
            movidos para cá. Se algo foi editado depois da mesclagem, o desfazer é recusado — nada é
            sobrescrito automaticamente.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction}>
          <input type="hidden" name="mergeId" value={mergeId} />
          <input type="hidden" name="contactId" value={contactId} />
          {state.error ? (
            <Alert variant="danger" className="mb-3">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Desfazendo…" : "Confirmar desfazer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ContactMergeHistory({
  contactId,
  canUndo,
  history,
}: {
  contactId: string;
  canUndo: boolean;
  history: ContactMergeHistoryItem[];
}) {
  if (history.length === 0) return null;

  return (
    <ul className="flex flex-col gap-2">
      {history.map((entry) => (
        <li
          key={entry.mergeId}
          className="flex items-center justify-between gap-3 rounded-input border border-border bg-surface-subtle px-3 py-2"
        >
          <div className="flex flex-col">
            <span className="text-body text-text">
              Mesclado com <strong>{entry.mergedContactName}</strong> em {formatDateTime(entry.mergedAt)}
            </span>
            {entry.undoneAt ? (
              <span className="text-meta text-text-tertiary">Desfeito em {formatDateTime(entry.undoneAt)}</span>
            ) : null}
          </div>
          {!entry.undoneAt && canUndo ? (
            <UndoMergeButton contactId={contactId} mergeId={entry.mergeId} mergedContactName={entry.mergedContactName} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
