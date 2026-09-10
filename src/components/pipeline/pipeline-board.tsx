"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { PipelineBoardColumn, OpportunityCard as OpportunityCardData } from "@/modules/opportunities/queries";
import { formatDue } from "@/lib/timezone";
import { ACTIVITY_TYPE_LABEL } from "@/components/activities/labels";
import {
  checkStageRequirementsAction,
  moveOpportunityStageAction,
} from "@/modules/opportunities/actions";
import { StageAdvanceDialog } from "./stage-advance-dialog";
import { WonDialog } from "./won-dialog";
import { LostDialog } from "./lost-dialog";

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `${days} dia${days === 1 ? "" : "s"}`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours}h`;
  return "menos de 1h";
}

function OpportunityCardView({
  card,
  canEdit,
  stages,
  onMoveTo,
  onWon,
  onLost,
}: {
  card: OpportunityCardData;
  canEdit: boolean;
  stages: { id: string; name: string }[];
  onMoveTo: (card: OpportunityCardData, toStageId: string) => void;
  onWon: (card: OpportunityCardData) => void;
  onLost: (card: OpportunityCardData) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id,
    disabled: !canEdit,
  });

  return (
    <div
      ref={setNodeRef}
      className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-2.5 shadow-sm"
      style={{ opacity: isDragging ? 0.4 : 1 }}
    >
      <div className="flex items-start justify-between gap-2">
        <Link href={`/oportunidades/${card.id}`} className="font-medium text-text hover:underline">
          {card.contactName}
        </Link>
        {canEdit ? (
          <button
            type="button"
            aria-label={`Arrastar ${card.contactName}`}
            className="cursor-grab touch-none rounded p-0.5 text-text-tertiary hover:bg-app active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            ⠿
          </button>
        ) : null}
      </div>
      <p className="text-meta text-text-tertiary">{card.legalArea}</p>
      {card.valueCents !== undefined ? (
        <p className="font-mono text-meta text-text">{formatCents(card.valueCents)}</p>
      ) : card.valueBand !== undefined ? (
        <p className="text-meta text-text-tertiary">{card.valueBand}</p>
      ) : null}
      <p className="text-meta text-text-tertiary">{card.assignedToName ?? "Sem responsável"}</p>
      <p className="text-meta text-text-tertiary">
        {card.nextAction ? (
          <>
            {ACTIVITY_TYPE_LABEL[card.nextAction.type]} — {formatDue(card.nextAction.dueAt, card.nextAction.hasTime)}
          </>
        ) : (
          "Sem próxima ação"
        )}
        {card.overdueActivitiesCount > 0 ? (
          <span className="ml-1.5 rounded-full bg-danger-bg px-1.5 py-0.5 text-label font-bold text-danger">
            {card.overdueActivitiesCount} atrasada{card.overdueActivitiesCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </p>

      {canEdit ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <label className="sr-only" htmlFor={`move-${card.id}`}>
            Mover {card.contactName} para etapa
          </label>
          <select
            id={`move-${card.id}`}
            defaultValue=""
            onChange={(event) => {
              const toStageId = event.target.value;
              if (toStageId) onMoveTo(card, toStageId);
              event.target.value = "";
            }}
            className="h-7 rounded-input border border-border-input bg-surface px-1.5 text-meta text-text"
          >
            <option value="" disabled>
              Mover para…
            </option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
          <Button type="button" variant="ghost" size="sm" onClick={() => onWon(card)}>
            Ganhou
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => onLost(card)}>
            Perdeu
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function StageColumn({
  column,
  canEdit,
  stages,
  onMoveTo,
  onWon,
  onLost,
}: {
  column: PipelineBoardColumn;
  canEdit: boolean;
  stages: { id: string; name: string }[];
  onMoveTo: (card: OpportunityCardData, toStageId: string) => void;
  onWon: (card: OpportunityCardData) => void;
  onLost: (card: OpportunityCardData) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.stageId });

  return (
    <div
      ref={setNodeRef}
      className="flex w-[272px] shrink-0 flex-col gap-2 rounded-lg border border-border bg-surface-subtle p-2"
      style={{ outline: isOver ? "2px solid var(--color-primary-ring, #E1EEE9)" : undefined }}
    >
      <div className="flex flex-col gap-0.5 px-1">
        <div className="flex items-center justify-between">
          <h3 className="text-body font-semibold text-text">{column.stageName}</h3>
          <span className="text-meta text-text-tertiary">{column.count}</span>
        </div>
        <div className="flex items-center gap-2 text-meta text-text-tertiary">
          {column.valueSumCents !== undefined ? <span>{formatCents(column.valueSumCents)}</span> : null}
          <span>tempo médio: {formatDuration(column.avgSecondsInStage)}</span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {column.cards.map((card) => (
          <OpportunityCardView
            key={card.id}
            card={card}
            canEdit={canEdit}
            stages={stages}
            onMoveTo={onMoveTo}
            onWon={onWon}
            onLost={onLost}
          />
        ))}
      </div>
    </div>
  );
}

export function PipelineBoard({
  workspaceId,
  columns,
  canEdit,
}: {
  workspaceId: string;
  columns: PipelineBoardColumn[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [advanceTarget, setAdvanceTarget] = useState<{ card: OpportunityCardData; toStageId: string } | null>(null);
  const [wonTarget, setWonTarget] = useState<OpportunityCardData | null>(null);
  const [lostTarget, setLostTarget] = useState<OpportunityCardData | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  // Etapas terminais (is_won/is_lost) não aparecem como destino de
  // "mover para" — o servidor recusa esse movimento (stage_is_terminal);
  // ganhar/perder são ações próprias (botões "Ganhou"/"Perdeu"), não uma
  // coluna para onde arrastar.
  const stageOptions = useMemo(
    () =>
      columns
        .filter((c) => !c.isWon && !c.isLost)
        .map((c) => ({ id: c.stageId, name: c.stageName }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [columns],
  );

  function findCardStage(cardId: string): string | undefined {
    return columns.find((c) => c.cards.some((card) => card.id === cardId))?.stageId;
  }

  async function performMove(card: OpportunityCardData, toStageId: string, requirementValues: unknown[] = []) {
    setError(null);
    const fromStageId = findCardStage(card.id);
    if (!fromStageId) return;

    const fd = new FormData();
    fd.set("opportunityId", card.id);
    fd.set("fromStageId", fromStageId);
    fd.set("toStageId", toStageId);
    fd.set("lockVersion", String(card.lockVersion));
    fd.set("requirementValues", JSON.stringify(requirementValues));

    const result = await moveOpportunityStageAction({ ok: false }, fd);
    if (!result.ok) {
      setError(result.error ?? "Não foi possível mover a oportunidade.");
      router.refresh();
      return;
    }
    router.refresh();
  }

  function requestMove(card: OpportunityCardData, toStageId: string) {
    const fromStageId = findCardStage(card.id);
    if (!fromStageId || fromStageId === toStageId) return;

    startTransition(async () => {
      const pending = await checkStageRequirementsAction(card.id, toStageId);
      const missing = pending.filter((r) => !r.filled);
      if (missing.length > 0) {
        setAdvanceTarget({ card, toStageId });
        return;
      }
      await performMove(card, toStageId);
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    if (!event.over) return;
    const cardId = String(event.active.id);
    const toStageId = String(event.over.id);
    const card = columns.flatMap((c) => c.cards).find((c) => c.id === cardId);
    if (card) requestMove(card, toStageId);
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <DndContext id="pipeline-board" sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {columns.map((column) => (
            <StageColumn
              key={column.stageId}
              column={column}
              canEdit={canEdit}
              stages={stageOptions.filter((s) => s.id !== column.stageId)}
              onMoveTo={requestMove}
              onWon={setWonTarget}
              onLost={setLostTarget}
            />
          ))}
        </div>
      </DndContext>

      {advanceTarget ? (
        <StageAdvanceDialog
          opportunityId={advanceTarget.card.id}
          toStageId={advanceTarget.toStageId}
          open={true}
          onOpenChange={(open) => {
            if (!open) setAdvanceTarget(null);
          }}
          onConfirm={async (requirementValues) => {
            await performMove(advanceTarget.card, advanceTarget.toStageId, requirementValues);
            setAdvanceTarget(null);
          }}
        />
      ) : null}

      {wonTarget ? (
        <WonDialog
          opportunity={wonTarget}
          open={true}
          onOpenChange={(open) => {
            if (!open) setWonTarget(null);
          }}
          onDone={() => {
            setWonTarget(null);
            router.refresh();
          }}
        />
      ) : null}

      {lostTarget ? (
        <LostDialog
          opportunity={lostTarget}
          workspaceId={workspaceId}
          open={true}
          onOpenChange={(open) => {
            if (!open) setLostTarget(null);
          }}
          onDone={() => {
            setLostTarget(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
