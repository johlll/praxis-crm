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
import { checkWinRequirementsAction, winOpportunityAction } from "@/modules/opportunities/actions";
import type { OpportunityCard, StageRequirementStatus } from "@/modules/opportunities/queries";
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

  // Requisitos marcados "obrigatório para marcar como ganho" — em
  // qualquer etapa do pipeline, não só o caminho percorrido. A checagem
  // que bloqueia de fato é a mesma regra dentro de win_opportunity() no
  // banco; isto só mostra as pendências e impede o clique sem preenchê-las.
  const [requirements, setRequirements] = useState<StageRequirementStatus[]>([]);
  const [requirementValues, setRequirementValues] = useState<Record<string, string | boolean>>({});
  const [loadingRequirements, setLoadingRequirements] = useState(true);

  // WonDialog é montado condicionalmente pelo componente pai (só existe
  // enquanto há um alvo de ganho) — cada abertura é um mount novo, então
  // o valor inicial de loadingRequirements (true) já nasce correto, sem
  // precisar de um setState síncrono aqui dentro (proibido pelo lint
  // react-hooks/set-state-in-effect), mesmo padrão do StageAdvanceDialog.
  useEffect(() => {
    let cancelled = false;
    checkWinRequirementsAction(opportunity.id).then((data) => {
      if (cancelled) return;
      setRequirements(data);
      const initial: Record<string, string | boolean> = {};
      for (const req of data) {
        if (req.fieldType === "checkbox") initial[req.requirementId] = req.valueBool ?? false;
        else initial[req.requirementId] = req.valueText ?? "";
      }
      setRequirementValues(initial);
      setLoadingRequirements(false);
    });
    return () => {
      cancelled = true;
    };
  }, [opportunity.id]);

  const pendingCount = requirements.filter((r) =>
    r.fieldType === "checkbox"
      ? requirementValues[r.requirementId] !== true
      : String(requirementValues[r.requirementId] ?? "").trim() === "",
  ).length;

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

    const payload = requirements.map((r) =>
      r.fieldType === "checkbox"
        ? { requirement_id: r.requirementId, value_bool: Boolean(requirementValues[r.requirementId]) }
        : { requirement_id: r.requirementId, value_text: String(requirementValues[r.requirementId] ?? "") },
    );
    fd.set("requirementValues", JSON.stringify(payload));

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

          {loadingRequirements ? null : requirements.length > 0 ? (
            <div className="flex flex-col gap-3 rounded-card border border-border-input bg-surface-subtle p-3">
              <p className="text-meta font-semibold text-text-secondary">Obrigatório para marcar como ganho</p>
              {requirements.map((req) => (
                <FormField key={req.requirementId}>
                  <FormLabel htmlFor={`won-req-${req.requirementId}`}>{req.label}</FormLabel>
                  {req.fieldType === "checkbox" ? (
                    <label className="flex h-8 items-center gap-2 rounded-input border border-border-input px-2.5 text-body text-text">
                      <input
                        id={`won-req-${req.requirementId}`}
                        type="checkbox"
                        checked={Boolean(requirementValues[req.requirementId])}
                        onChange={(e) =>
                          setRequirementValues((v) => ({ ...v, [req.requirementId]: e.target.checked }))
                        }
                      />
                      {req.hint ?? "Confirmado"}
                    </label>
                  ) : req.fieldType === "textarea" ? (
                    <textarea
                      id={`won-req-${req.requirementId}`}
                      rows={2}
                      placeholder={req.hint ?? ""}
                      value={String(requirementValues[req.requirementId] ?? "")}
                      onChange={(e) => setRequirementValues((v) => ({ ...v, [req.requirementId]: e.target.value }))}
                      className="rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text"
                    />
                  ) : (
                    <Input
                      id={`won-req-${req.requirementId}`}
                      type={req.fieldType === "date" ? "date" : "text"}
                      placeholder={req.hint ?? ""}
                      value={String(requirementValues[req.requirementId] ?? "")}
                      onChange={(e) => setRequirementValues((v) => ({ ...v, [req.requirementId]: e.target.value }))}
                    />
                  )}
                </FormField>
              ))}
            </div>
          ) : null}
        </div>

        {error ? (
          <Alert variant="danger">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          {pendingCount > 0 ? (
            <span className="mr-auto text-meta text-text-tertiary">
              {pendingCount} requisito{pendingCount === 1 ? "" : "s"} obrigatório{pendingCount === 1 ? "" : "s"} pendente
              {pendingCount === 1 ? "" : "s"}
            </span>
          ) : null}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="button" disabled={pending || loadingRequirements || pendingCount > 0} onClick={handleSubmit}>
            {pending ? "Salvando…" : "Registrar ganho"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
