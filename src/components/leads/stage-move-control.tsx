"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { StageAdvanceDialog } from "@/components/pipeline/stage-advance-dialog";
import { moveOpportunityStageAction, checkStageRequirementsAction } from "@/modules/opportunities/actions";
import type { PipelineStageDetail } from "@/modules/opportunities/queries";

/**
 * Mudar de etapa sem sair do Perfil 360 — mesma RPC/regra de bloqueio do
 * kanban (`move_opportunity_stage` + `StageAdvanceDialog`), só que
 * disparada por um `<select>` em vez de arrastar um card. Etapas
 * terminais (ganha/perdida) não entram nas opções — ganhar/perder
 * continuam os botões próprios do `OpportunityDetailPanel`, já
 * reaproveitados sem mudança (docs/decisoes/a9-perfil-360.md §8, achado
 * do review pós-CI: essa mudança de etapa exigia ir ao Pipeline).
 */
export function StageMoveControl({
  leadId,
  opportunityId,
  lockVersion,
  stages,
  currentStageId,
}: {
  leadId: string;
  opportunityId: string;
  lockVersion: number;
  stages: PipelineStageDetail[];
  currentStageId: string;
}) {
  const router = useRouter();
  const options = stages.filter((s) => !s.isWon && !s.isLost);
  const [selected, setSelected] = useState(currentStageId);
  const [error, setError] = useState<string | null>(null);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  async function performMove(toStageId: string, requirementValues: unknown[] = []) {
    setError(null);
    const fd = new FormData();
    fd.set("opportunityId", opportunityId);
    fd.set("fromStageId", currentStageId);
    fd.set("toStageId", toStageId);
    fd.set("lockVersion", String(lockVersion));
    fd.set("requirementValues", JSON.stringify(requirementValues));
    fd.set("leadId", leadId);
    const result = await moveOpportunityStageAction({ ok: false }, fd);
    if (!result.ok) {
      setError(result.error ?? "Não foi possível mover a oportunidade.");
      setSelected(currentStageId);
    }
    router.refresh();
  }

  function handleConfirm() {
    if (selected === currentStageId) return;
    startTransition(async () => {
      const pending = await checkStageRequirementsAction(opportunityId, selected);
      const missing = pending.filter((r) => !r.filled);
      if (missing.length > 0) {
        setAdvanceOpen(true);
        return;
      }
      await performMove(selected);
    });
  }

  if (options.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Mover etapa para"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="h-8 rounded-input border border-border-input bg-surface px-2 text-meta text-text"
      >
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={selected === currentStageId || pending}
        onClick={handleConfirm}
      >
        {pending ? "Movendo…" : "Mover etapa"}
      </Button>
      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <StageAdvanceDialog
        opportunityId={opportunityId}
        toStageId={selected}
        open={advanceOpen}
        onOpenChange={setAdvanceOpen}
        onConfirm={async (values) => {
          await performMove(selected, values);
          setAdvanceOpen(false);
        }}
      />
    </div>
  );
}
