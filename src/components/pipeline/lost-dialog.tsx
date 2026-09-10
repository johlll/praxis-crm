"use client";

import { useEffect, useState } from "react";

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
} from "@/components/ui/dialog";
import { listLostReasonsAction, loseOpportunityAction } from "@/modules/opportunities/actions";
import type { OpportunityCard, LostReasonOption } from "@/modules/opportunities/queries";

export function LostDialog({
  opportunity,
  workspaceId,
  open,
  onOpenChange,
  onDone,
}: {
  opportunity: OpportunityCard;
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [reasons, setReasons] = useState<LostReasonOption[]>([]);
  const [reasonId, setReasonId] = useState("");
  const [note, setNote] = useState("");
  const [followup, setFollowup] = useState(false);
  const [followupDate, setFollowupDate] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listLostReasonsAction(workspaceId).then(setReasons);
  }, [workspaceId]);

  async function handleSubmit() {
    if (!reasonId) return;
    setPending(true);
    setError(null);
    const fd = new FormData();
    fd.set("opportunityId", opportunity.id);
    fd.set("lockVersion", String(opportunity.lockVersion));
    fd.set("lostReasonId", reasonId);
    if (note) fd.set("lostNote", note);
    if (followup && followupDate) fd.set("followupDate", followupDate);

    const result = await loseOpportunityAction({ ok: false }, fd);
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? "Não foi possível registrar a perda.");
      return;
    }
    onDone();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar oportunidade perdida</DialogTitle>
          <DialogDescription>{opportunity.contactName} · motivo obrigatório</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <FormField>
            <FormLabel htmlFor="lost-reason">Motivo da perda</FormLabel>
            <select
              id="lost-reason"
              value={reasonId}
              onChange={(e) => setReasonId(e.target.value)}
              className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
            >
              <option value="" disabled>
                Selecione…
              </option>
              {reasons.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField>
            <FormLabel htmlFor="lost-note">Contexto (opcional)</FormLabel>
            <textarea
              id="lost-note"
              rows={2}
              placeholder="Contexto para o relatório de perdas"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text"
            />
          </FormField>
          <label className="flex items-center gap-2 text-body text-text">
            <input type="checkbox" checked={followup} onChange={(e) => setFollowup(e.target.checked)} />
            Marcar data de retomada de contato
          </label>
          {followup ? (
            <Input type="date" value={followupDate} onChange={(e) => setFollowupDate(e.target.value)} />
          ) : null}
        </div>

        {error ? (
          <Alert variant="danger">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="button" disabled={pending || !reasonId} onClick={handleSubmit}>
            {pending ? "Salvando…" : "Registrar perda"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
