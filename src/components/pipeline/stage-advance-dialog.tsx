"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { checkStageRequirementsAction } from "@/modules/opportunities/actions";
import type { StageRequirementStatus } from "@/modules/opportunities/queries";

type FieldValue = { requirement_id: string; value_text?: string; value_bool?: boolean };

export function StageAdvanceDialog({
  opportunityId,
  toStageId,
  open,
  onOpenChange,
  onConfirm,
}: {
  opportunityId: string;
  toStageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (values: FieldValue[]) => Promise<void>;
}) {
  const [requirements, setRequirements] = useState<StageRequirementStatus[]>([]);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    checkStageRequirementsAction(opportunityId, toStageId).then((data) => {
      if (cancelled) return;
      setRequirements(data);
      const initial: Record<string, string | boolean> = {};
      for (const req of data) {
        if (req.fieldType === "checkbox") initial[req.requirementId] = req.valueBool ?? false;
        else initial[req.requirementId] = req.valueText ?? "";
      }
      setValues(initial);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [opportunityId, toStageId]);

  const completedCount = requirements.filter((r) =>
    r.fieldType === "checkbox" ? values[r.requirementId] === true : String(values[r.requirementId] ?? "").trim() !== "",
  ).length;

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const payload: FieldValue[] = requirements.map((r) =>
        r.fieldType === "checkbox"
          ? { requirement_id: r.requirementId, value_bool: Boolean(values[r.requirementId]) }
          : { requirement_id: r.requirementId, value_text: String(values[r.requirementId] ?? "") },
      );
      await onConfirm(payload);
    } catch {
      setError("Não foi possível salvar. Tente novamente.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Complete os dados necessários para avançar esta oportunidade</DialogTitle>
          <DialogDescription>
            {requirements[0]?.stageName ? `Até ${requirements[requirements.length - 1]?.stageName}` : ""}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-body text-text-tertiary">Carregando…</p>
        ) : (
          <div className="flex flex-col gap-3">
            {requirements.map((req) => (
              <div key={req.requirementId} className="flex flex-col gap-1.5">
                <label className="text-meta font-semibold text-text-secondary" htmlFor={`req-${req.requirementId}`}>
                  {req.label}
                </label>
                {req.fieldType === "checkbox" ? (
                  <label className="flex h-8 items-center gap-2 rounded-input border border-border-input px-2.5 text-body text-text">
                    <input
                      id={`req-${req.requirementId}`}
                      type="checkbox"
                      checked={Boolean(values[req.requirementId])}
                      onChange={(e) => setValues((v) => ({ ...v, [req.requirementId]: e.target.checked }))}
                    />
                    {req.hint ?? "Confirmado"}
                  </label>
                ) : req.fieldType === "textarea" ? (
                  <textarea
                    id={`req-${req.requirementId}`}
                    rows={2}
                    placeholder={req.hint ?? ""}
                    value={String(values[req.requirementId] ?? "")}
                    onChange={(e) => setValues((v) => ({ ...v, [req.requirementId]: e.target.value }))}
                    className="rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text"
                  />
                ) : (
                  <Input
                    id={`req-${req.requirementId}`}
                    type={req.fieldType === "date" ? "date" : "text"}
                    placeholder={req.hint ?? ""}
                    value={String(values[req.requirementId] ?? "")}
                    onChange={(e) => setValues((v) => ({ ...v, [req.requirementId]: e.target.value }))}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {error ? (
          <Alert variant="danger">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <span className="mr-auto text-meta text-text-tertiary">
            {completedCount} de {requirements.length} requisitos completos
          </span>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            type="button"
            disabled={loading || submitting || completedCount < requirements.length}
            onClick={handleSubmit}
          >
            {submitting ? "Salvando…" : "Salvar e avançar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
