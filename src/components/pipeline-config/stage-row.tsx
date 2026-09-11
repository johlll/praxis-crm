"use client";

import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { PipelineStageDetail } from "@/modules/opportunities/queries";
import {
  deletePipelineStageAction,
  deleteStageRequirementAction,
  reorderPipelineStagesAction,
  updateStageRequirementAction,
} from "@/modules/opportunities/actions";
import { deleteStageAutoActivityRuleAction } from "@/modules/activities/actions";
import { StageEditDialog } from "./stage-edit-dialog";
import { AddRequirementDialog } from "./add-requirement-dialog";
import { StageAutoActivityDialog } from "./stage-auto-activity-dialog";

export function StageRow({
  stage,
  pipelineId,
  orderedStageIds,
  index,
  total,
}: {
  stage: PipelineStageDetail;
  pipelineId: string;
  orderedStageIds: string[];
  index: number;
  total: number;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function move(direction: -1 | 1) {
    const next = [...orderedStageIds];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setError(null);
    startTransition(async () => {
      const result = await reorderPipelineStagesAction(pipelineId, next);
      if (!result.ok) setError(result.error ?? "Não foi possível reordenar.");
    });
  }

  function remove() {
    setError(null);
    const formData = new FormData();
    formData.set("stageId", stage.id);
    startTransition(async () => {
      const result = await deletePipelineStageAction({ ok: false }, formData);
      if (!result.ok) setError(result.error ?? "Não foi possível excluir a etapa.");
    });
  }

  function removeRequirement(requirementId: string) {
    setError(null);
    const formData = new FormData();
    formData.set("requirementId", requirementId);
    startTransition(async () => {
      const result = await deleteStageRequirementAction({ ok: false }, formData);
      if (!result.ok) setError(result.error ?? "Não foi possível excluir o requisito.");
    });
  }

  function toggleRequiredForWin(requirementId: string, next: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await updateStageRequirementAction(requirementId, next);
      if (!result.ok) setError(result.error ?? "Não foi possível atualizar o requisito.");
    });
  }

  function removeAutoActivityRule() {
    setError(null);
    startTransition(async () => {
      const result = await deleteStageAutoActivityRuleAction(stage.id);
      if (!result.ok) setError(result.error ?? "Não foi possível remover a regra.");
    });
  }

  return (
    <div className="flex flex-col gap-2 border-b border-border-subtle px-4 py-3 last:border-0">
      <div className="flex items-center gap-2">
        <span
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: stage.color ?? "#0E6C5C" }}
          aria-hidden
        />
        <span className="flex-1 text-small font-semibold text-text">{stage.name}</span>
        {stage.isWon ? (
          <span className="rounded-full bg-success-bg px-2 py-0.5 text-meta font-medium text-success">Ganho</span>
        ) : null}
        {stage.isLost ? (
          <span className="rounded-full bg-danger-bg px-2 py-0.5 text-meta font-medium text-danger">Perda</span>
        ) : null}
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending || index === 0}
            aria-label={`Mover ${stage.name} para cima`}
            onClick={() => move(-1)}
          >
            <ArrowUp size={14} aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending || index === total - 1}
            aria-label={`Mover ${stage.name} para baixo`}
            onClick={() => move(1)}
          >
            <ArrowDown size={14} aria-hidden />
          </Button>
          <StageEditDialog stage={stage} />
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            aria-label={`Excluir etapa ${stage.name}`}
            onClick={remove}
          >
            <Trash2 size={14} aria-hidden />
          </Button>
        </div>
      </div>

      <div className="ml-4 flex flex-col gap-1.5">
        {stage.requirements.map((req) => (
          <div key={req.id} className="flex items-center gap-2 text-meta text-text-tertiary">
            <span className="flex-1">
              {req.label} <span className="text-text-muted">({req.fieldType})</span>
            </span>
            <label className="flex items-center gap-1.5" htmlFor={`req-win-${req.id}`}>
              <input
                id={`req-win-${req.id}`}
                type="checkbox"
                className="size-3.5"
                checked={req.requiredForWin}
                disabled={isPending}
                onChange={(e) => toggleRequiredForWin(req.id, e.target.checked)}
              />
              Obrigatório para ganhar
            </label>
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending}
              aria-label={`Excluir requisito ${req.label}`}
              onClick={() => removeRequirement(req.id)}
            >
              <Trash2 size={12} aria-hidden />
            </Button>
          </div>
        ))}
        <div>
          <AddRequirementDialog stageId={stage.id} stageName={stage.name} />
        </div>
      </div>

      {!stage.isWon && !stage.isLost ? (
        <div className="ml-4 flex items-center gap-2 text-meta text-text-tertiary">
          {stage.autoActivityRule ? (
            <span className="flex-1">
              Ao entrar aqui: cria &quot;{stage.autoActivityRule.title}&quot; ({stage.autoActivityRule.dueOffsetHours}h de prazo)
            </span>
          ) : (
            <span className="flex-1">Nenhuma atividade automática configurada.</span>
          )}
          <StageAutoActivityDialog stageId={stage.id} stageName={stage.name} rule={stage.autoActivityRule} />
          {stage.autoActivityRule ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending}
              aria-label={`Remover atividade automática de ${stage.name}`}
              onClick={removeAutoActivityRule}
            >
              <Trash2 size={12} aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
