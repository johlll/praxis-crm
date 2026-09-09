"use client";

import { useState } from "react";

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
import { winOpportunityAction } from "@/modules/opportunities/actions";
import type { OpportunityCard } from "@/modules/opportunities/queries";
import { FEE_MODELS } from "@/modules/opportunities/schema";

const FEE_MODEL_LABEL: Record<(typeof FEE_MODELS)[number], string> = {
  fixed: "Valor fixo",
  contingency: "Êxito",
  fixed_contingency: "Fixo + êxito",
};

export function WonDialog({
  opportunity,
  open,
  onOpenChange,
  onDone,
}: {
  opportunity: OpportunityCard;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [valueReais, setValueReais] = useState(
    opportunity.valueCents !== undefined ? String(opportunity.valueCents / 100) : "",
  );
  const [feeModel, setFeeModel] = useState<(typeof FEE_MODELS)[number]>(opportunity.feeModel ?? "fixed");
  const [signedAt, setSignedAt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setPending(true);
    setError(null);
    const valueCents = Math.round(Number(valueReais.replace(",", ".")) * 100);
    const fd = new FormData();
    fd.set("opportunityId", opportunity.id);
    fd.set("lockVersion", String(opportunity.lockVersion));
    fd.set("valueCents", String(Number.isFinite(valueCents) ? valueCents : 0));
    fd.set("feeModel", feeModel);
    if (signedAt) fd.set("signedAt", signedAt);

    const result = await winOpportunityAction({ ok: false }, fd);
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? "Não foi possível registrar o ganho.");
      return;
    }
    onDone();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar oportunidade ganha</DialogTitle>
          <DialogDescription>{opportunity.contactName}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <FormField>
            <FormLabel htmlFor="won-value">Valor final</FormLabel>
            <Input
              id="won-value"
              inputMode="decimal"
              value={valueReais}
              onChange={(e) => setValueReais(e.target.value)}
              placeholder="0,00"
            />
          </FormField>
          <FormField>
            <FormLabel htmlFor="won-fee-model">Modelo de honorários</FormLabel>
            <select
              id="won-fee-model"
              value={feeModel}
              onChange={(e) => setFeeModel(e.target.value as (typeof FEE_MODELS)[number])}
              className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
            >
              {FEE_MODELS.map((m) => (
                <option key={m} value={m}>
                  {FEE_MODEL_LABEL[m]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField>
            <FormLabel htmlFor="won-signed-at">Data da assinatura</FormLabel>
            <Input id="won-signed-at" type="date" value={signedAt} onChange={(e) => setSignedAt(e.target.value)} />
          </FormField>
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
          <Button type="button" disabled={pending} onClick={handleSubmit}>
            {pending ? "Salvando…" : "Registrar ganho"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
