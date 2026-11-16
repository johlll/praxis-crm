"use client";

import {
  useMemo,
  useState,
  useTransition,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { ArrowRightLeft, CalendarClock, ChevronDown, CircleX, Clock, GripVertical, LoaderCircle, Trophy, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { initialsOf } from "@/lib/initials";
import { formatDue } from "@/lib/timezone";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { PipelineBoardColumn, OpportunityCard as OpportunityCardData } from "@/modules/opportunities/queries";
import { ACTIVITY_TYPE_LABEL } from "@/components/activities/labels";
import { checkStageRequirementsAction, moveOpportunityStageAction } from "@/modules/opportunities/actions";
import { StageAdvanceDialog } from "./stage-advance-dialog";
import { WonDialog } from "./won-dialog";
import { LostDialog } from "./lost-dialog";
import { mix, stageColor } from "./stage-tone";

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

/**
 * Um movimento em andamento. As fases seguem o MESMO fluxo de negócio da
 * mudança de etapa pelo menu (requisitos → move_opportunity_stage):
 *  - checking: consultando requisitos da etapa de destino;
 *  - requirements: requisito pendente, StageAdvanceDialog aberto (cartão
 *    volta para a etapa de origem até a confirmação);
 *  - saving: gravando no servidor;
 *  - confirmed: gravado; espera o quadro recarregado do servidor.
 * Enquanto houver movimento, nada mais se move (sem envio duplicado nem
 * lock_version velho). Falha ou cancelamento recoloca o cartão na origem.
 */
type MovePhase = "checking" | "requirements" | "saving" | "confirmed";
type MoveState = {
  card: OpportunityCardData;
  fromStageId: string;
  toStageId: string;
  phase: MovePhase;
  /** Quadro recebido quando o movimento terminou; trocou → dados novos chegaram. */
  settledColumns?: PipelineBoardColumn[];
};

// Onde o arraste NÃO começa (botões de ação, menus e campos); o nome do
// cliente e a alça podem iniciar o arraste.
const NO_DRAG_START = "button:not([data-drag-handle]), label, select, input, textarea, [role='menu'], [role='menuitem']";
// Onde o clique NÃO abre o detalhe pelo cartão (cada um tem ação própria;
// o link do nome navega sozinho).
const NO_CARD_CLICK = "button, a, label, select, input, textarea, [role='menu'], [role='menuitem']";

/** Setas esquerda/direita pulam de coluna em coluna (em vez de 25 px por vez). */
const columnKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const { collisionRect, droppableRects, droppableContainers } = context;
  if (!collisionRect) return undefined;
  if (event.code !== "ArrowRight" && event.code !== "ArrowLeft") return undefined;
  event.preventDefault();

  const centerX = collisionRect.left + collisionRect.width / 2;
  const rects = droppableContainers
    .getEnabled()
    .map((container) => droppableRects.get(container.id))
    .filter((rect): rect is NonNullable<typeof rect> => Boolean(rect))
    .sort((a, b) => a.left - b.left);

  const target =
    event.code === "ArrowRight"
      ? rects.find((rect) => rect.left > centerX)
      : [...rects].reverse().find((rect) => rect.left + rect.width < centerX);
  if (!target) return undefined;

  return {
    x: target.left + (target.width - collisionRect.width) / 2,
    y: Math.max(target.top + 48, collisionRect.top),
  };
};

/** Mouse/toque usam a posição do ponteiro; teclado cai na interseção. */
const collisionDetection: CollisionDetection = (args) => {
  const byPointer = pointerWithin(args);
  return byPointer.length > 0 ? byPointer : rectIntersection(args);
};

function CardBody({
  card,
  canEdit,
  pending,
  overlay = false,
  stages,
  disabled,
  onMoveTo,
  onWon,
  onLost,
  handle,
}: {
  card: OpportunityCardData;
  canEdit: boolean;
  pending: MovePhase | null;
  overlay?: boolean;
  stages: { id: string; name: string }[];
  disabled: boolean;
  onMoveTo?: (card: OpportunityCardData, toStageId: string) => void;
  onWon?: (card: OpportunityCardData) => void;
  onLost?: (card: OpportunityCardData) => void;
  handle?: ReactNode;
}) {
  const value =
    card.valueCents !== undefined ? formatCents(card.valueCents) : card.valueBand !== undefined ? card.valueBand : null;
  const pendingLabel =
    pending === "checking" ? "Conferindo requisitos…" : pending === "saving" ? "Movendo…" : pending === "confirmed" ? "Atualizando…" : null;

  return (
    <>
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          {overlay ? (
            <p className="m-0 truncate text-[13.5px] font-semibold text-text">{card.contactName}</p>
          ) : (
            <Link
              href={`/oportunidades/${card.id}`}
              draggable={false}
              className="block truncate text-[13.5px] font-semibold text-text hover:text-text hover:underline"
            >
              {card.contactName}
            </Link>
          )}
          <div className="mt-1 flex items-center gap-2">
            <span className="truncate rounded-[5px] border border-border bg-app px-1.5 py-px text-meta text-text-secondary">
              {card.legalArea}
            </span>
            {value ? (
              <span className="ml-auto shrink-0 text-small font-semibold text-text tabular">{value}</span>
            ) : null}
          </div>
        </div>
        {handle}
      </div>

      <div className="flex items-center gap-1.5 text-meta">
        {card.assignedToName ? (
          <>
            <span
              className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-surface-hover text-[8.5px] font-bold text-text-secondary"
              aria-hidden
            >
              {initialsOf(card.assignedToName)}
            </span>
            <span className="truncate text-text-secondary">{card.assignedToName}</span>
          </>
        ) : (
          <>
            <span className="size-[18px] shrink-0 rounded-full border border-dashed border-border-unassigned" aria-hidden />
            <span className="truncate text-text-muted">Sem responsável</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-meta text-text-muted">
        <CalendarClock size={13} strokeWidth={1.5} className="shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          {card.nextAction
            ? `${ACTIVITY_TYPE_LABEL[card.nextAction.type]} — ${formatDue(card.nextAction.dueAt, card.nextAction.hasTime)}`
            : "Sem próxima ação"}
        </span>
        {card.overdueActivitiesCount > 0 ? (
          <span className="ml-auto shrink-0 rounded-full bg-danger-bg px-1.5 py-0.5 text-label font-bold text-danger">
            {card.overdueActivitiesCount} atrasada{card.overdueActivitiesCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {pendingLabel ? (
        <p className="m-0 flex items-center gap-1.5 text-meta font-semibold text-accent" role="status">
          <LoaderCircle size={13} className="animate-spin" aria-hidden />
          {pendingLabel}
        </p>
      ) : null}

      {canEdit && !overlay ? (
        <div className="-mx-2.5 -mb-2.5 flex items-center gap-1 border-t border-border-subtle px-1.5 py-1">
          {/* Alternativa sem arrastar (teclado, leitor de tela, toque): o
              mesmo seletor nativo de sempre, com visual compacto. */}
          <label className="relative flex h-7 items-center rounded-md text-text-secondary transition-colors focus-within:bg-surface-hover hover:bg-surface-hover hover:text-text">
            <ArrowRightLeft size={13} strokeWidth={1.75} className="pointer-events-none absolute left-2" aria-hidden />
            <select
              aria-label={`Mover ${card.contactName} para etapa`}
              defaultValue=""
              disabled={disabled || stages.length === 0}
              onChange={(event) => {
                const toStageId = event.target.value;
                event.target.value = "";
                if (toStageId) onMoveTo?.(card, toStageId);
              }}
              className="h-7 w-[86px] cursor-pointer appearance-none rounded-md bg-transparent pr-5 pl-[25px] text-meta font-semibold text-inherit outline-none focus-visible:ring-2 focus-visible:ring-primary-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="" disabled>
                Mover…
              </option>
              {stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </select>
            <ChevronDown size={12} strokeWidth={1.75} className="pointer-events-none absolute right-1.5" aria-hidden />
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onWon?.(card)}
            className="ml-auto flex h-7 items-center gap-1 rounded-md px-1.5 text-meta font-semibold text-text-tertiary transition-colors hover:bg-success-bg hover:text-success disabled:pointer-events-none disabled:opacity-50"
          >
            <Trophy size={13} strokeWidth={1.75} aria-hidden />
            Ganhou
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onLost?.(card)}
            className="flex h-7 items-center gap-1 rounded-md px-1.5 text-meta font-semibold text-text-tertiary transition-colors hover:bg-danger-bg hover:text-danger disabled:pointer-events-none disabled:opacity-50"
          >
            <CircleX size={13} strokeWidth={1.75} aria-hidden />
            Perdeu
          </button>
        </div>
      ) : null}
    </>
  );
}

const CARD_CLASS =
  "relative flex flex-col gap-2 rounded-[10px] border border-border bg-surface p-2.5 shadow-card transition-[border-color,background-color,opacity] select-none [-webkit-touch-callout:none]";

function DraggableCard({
  card,
  stageId,
  canEdit,
  pending,
  busy,
  stages,
  onMoveTo,
  onWon,
  onLost,
}: {
  card: OpportunityCardData;
  stageId: string;
  canEdit: boolean;
  pending: MovePhase | null;
  busy: boolean;
  stages: { id: string; name: string }[];
  onMoveTo: (card: OpportunityCardData, toStageId: string) => void;
  onWon: (card: OpportunityCardData) => void;
  onLost: (card: OpportunityCardData) => void;
}) {
  const router = useRouter();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id,
    data: { stageId },
    disabled: !canEdit || busy,
  });

  // Mouse e toque podem começar o arraste em qualquer ponto do cartão,
  // menos nos botões/menus de ação; o teclado usa só a alça (que é o único
  // elemento focável de arraste — o cartão em si não vira "botão").
  const { onKeyDown: keyboardListener, ...pointerListeners } = listeners ?? {};
  const guardedPointerListeners = Object.fromEntries(
    Object.entries(pointerListeners).map(([name, handler]) => [
      name,
      (event: SyntheticEvent) => {
        if ((event.target as HTMLElement).closest(NO_DRAG_START)) return;
        (handler as (e: SyntheticEvent) => void)(event);
      },
    ]),
  );

  return (
    <div
      ref={setNodeRef}
      data-testid="pipeline-card"
      data-opportunity-id={card.id}
      {...(canEdit ? guardedPointerListeners : {})}
      onClick={(event) => {
        // Clique simples abre o detalhe. Depois de um arraste o dnd-kit
        // interrompe este clique, então soltar o cartão nunca navega.
        if ((event.target as HTMLElement).closest(NO_CARD_CLICK)) return;
        router.push(`/oportunidades/${card.id}`);
      }}
      className={cn(
        CARD_CLASS,
        "cursor-pointer hover:border-border-strong hover:bg-surface-hover",
        canEdit && !busy ? "md:cursor-grab" : "",
        isDragging ? "opacity-35" : "",
        pending ? "border-accent-border" : "",
        pending && pending !== "confirmed" ? "opacity-80" : "",
      )}
      style={{ touchAction: "manipulation" }}
    >
      <CardBody
        card={card}
        canEdit={canEdit}
        pending={pending}
        stages={stages}
        disabled={busy}
        onMoveTo={onMoveTo}
        onWon={onWon}
        onLost={onLost}
        handle={
          canEdit ? (
            <button
              type="button"
              data-drag-handle
              disabled={busy}
              aria-label={`Arrastar ${card.contactName}`}
              className="-mt-0.5 -mr-1 flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-text-disabled transition-colors hover:bg-app hover:text-text-secondary active:cursor-grabbing disabled:opacity-40"
              {...attributes}
              onKeyDown={keyboardListener as ((e: KeyboardEvent) => void) | undefined}
            >
              <GripVertical size={14} aria-hidden />
            </button>
          ) : null
        }
      />
    </div>
  );
}

function StageColumn({
  column,
  canEdit,
  busy,
  dragging,
  draggingFromStageId,
  stages,
  pendingFor,
  onMoveTo,
  onWon,
  onLost,
}: {
  column: PipelineBoardColumn & { displayCards: OpportunityCardData[] };
  canEdit: boolean;
  busy: boolean;
  dragging: boolean;
  draggingFromStageId: string | null;
  stages: { id: string; name: string }[];
  pendingFor: (cardId: string) => MovePhase | null;
  onMoveTo: (card: OpportunityCardData, toStageId: string) => void;
  onWon: (card: OpportunityCardData) => void;
  onLost: (card: OpportunityCardData) => void;
}) {
  // Etapas de ganho/perda não recebem cartão: o servidor recusa
  // (stage_is_terminal) e ganhar/perder têm fluxo próprio (botões).
  const terminal = column.isWon || column.isLost;
  const { setNodeRef, isOver } = useDroppable({ id: column.stageId, disabled: terminal || !canEdit });
  const validTarget = dragging && !terminal && draggingFromStageId !== column.stageId;
  const tone = stageColor(column.color, column.position);

  const highlighted = isOver && validTarget;
  const style: CSSProperties = {
    borderColor: highlighted ? mix(tone, 70, "var(--color-border)") : mix(tone, 24, "var(--color-border)"),
    background: highlighted ? mix(tone, 13, "var(--color-surface-subtle)") : mix(tone, 5, "var(--color-surface-subtle)"),
    boxShadow: highlighted ? `inset 0 0 0 1px ${mix(tone, 45, "transparent")}` : undefined,
  };

  return (
    <section
      ref={setNodeRef}
      aria-label={`Etapa ${column.stageName}`}
      data-testid="pipeline-column"
      data-stage-id={column.stageId}
      className="flex w-[82vw] max-w-[300px] shrink-0 snap-start flex-col overflow-hidden rounded-xl border transition-colors md:w-kanban-column md:max-w-none"
      style={style}
    >
      <header className="flex flex-col gap-1 px-3 pt-2.5 pb-2" style={{ background: mix(tone, 15, "var(--color-surface)") }}>
        <div className="flex items-center gap-2">
          <span className="size-2 shrink-0 rounded-full" style={{ background: tone }} aria-hidden />
          <h3 className="m-0 min-w-0 flex-1 truncate text-[13px] font-semibold text-text">{column.stageName}</h3>
          <span
            className="shrink-0 rounded-full bg-black/25 px-2 py-px text-meta font-semibold text-text-secondary tabular"
            aria-label={`${column.count} oportunidade${column.count === 1 ? "" : "s"}`}
          >
            {column.count}
          </span>
        </div>
        <p className="m-0 flex items-center gap-2 pl-4 text-meta whitespace-nowrap text-text-muted">
          {column.valueSumCents !== undefined ? (
            <span className="min-w-0 truncate font-semibold text-text-secondary tabular">{formatCents(column.valueSumCents)}</span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-1" title="Tempo médio das oportunidades nesta etapa">
            <Clock size={11} strokeWidth={1.75} aria-hidden />
            <span className="sr-only">tempo médio:</span>
            {formatDuration(column.avgSecondsInStage)}
          </span>
        </p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {column.displayCards.map((card) => (
          <DraggableCard
            key={card.id}
            card={card}
            stageId={column.stageId}
            canEdit={canEdit}
            pending={pendingFor(card.id)}
            busy={busy}
            stages={stages}
            onMoveTo={onMoveTo}
            onWon={onWon}
            onLost={onLost}
          />
        ))}
        {column.displayCards.length === 0 ? (
          <div
            className={cn(
              "flex min-h-[88px] flex-1 items-center justify-center rounded-[10px] border border-dashed px-3 text-center text-meta",
              validTarget ? "border-border-strong text-text-secondary" : "border-border text-text-muted",
            )}
          >
            {validTarget ? "Solte aqui para mover para esta etapa" : "Nenhuma oportunidade nesta etapa"}
          </div>
        ) : validTarget ? (
          <div className="flex min-h-[44px] shrink-0 items-center justify-center rounded-[10px] border border-dashed border-border-strong text-meta text-text-secondary">
            Solte aqui
          </div>
        ) : null}
      </div>
    </section>
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
  const [move, setMove] = useState<MoveState | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [wonTarget, setWonTarget] = useState<OpportunityCardData | null>(null);
  const [lostTarget, setLostTarget] = useState<OpportunityCardData | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Toque: segurar ~0,2 s para levantar o cartão; deslizar antes disso
    // rola a página/coluna normalmente.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnKeyboardCoordinates }),
  );

  // Um movimento "confirmed" vale até o quadro recarregado chegar (outra
  // referência de `columns`); daí em diante os dados do servidor mandam.
  const activeMove = move && !(move.phase === "confirmed" && move.settledColumns !== columns) ? move : null;
  const busy = activeMove !== null;

  // Etapas terminais (is_won/is_lost) não aparecem como destino de
  // "mover para" — o servidor recusa esse movimento (stage_is_terminal);
  // ganhar/perder são ações próprias (botões "Ganhou"/"Perdeu"), não uma
  // coluna para onde arrastar. Ordem do próprio pipeline.
  const stageOptions = useMemo(
    () =>
      [...columns]
        .sort((a, b) => a.position - b.position)
        .filter((c) => !c.isWon && !c.isLost)
        .map((c) => ({ id: c.stageId, name: c.stageName })),
    [columns],
  );

  const allCards = useMemo(() => columns.flatMap((c) => c.cards), [columns]);
  const stageNameById = useMemo(() => new Map(columns.map((c) => [c.stageId, c.stageName])), [columns]);

  // Posição exibida: a do servidor, exceto o cartão em movimento, que
  // aparece no destino enquanto confere/grava (marcado como pendente) e
  // volta à origem quando abre o pedido de requisitos, falha ou é cancelado.
  const displayColumns = useMemo(
    () =>
      columns.map((column) => {
        if (!activeMove || activeMove.phase === "requirements") return { ...column, displayCards: column.cards };
        const without = column.cards.filter((c) => c.id !== activeMove.card.id);
        if (column.stageId === activeMove.toStageId) {
          return { ...column, displayCards: [...without, activeMove.card] };
        }
        return { ...column, displayCards: without };
      }),
    [columns, activeMove],
  );

  function findCardStage(cardId: string): string | undefined {
    return columns.find((c) => c.cards.some((card) => card.id === cardId))?.stageId;
  }

  function fail(message: string) {
    setMove(null);
    setError(message);
    // Recarrega do servidor: em conflito, traz a etapa e o lock_version atuais.
    startTransition(() => router.refresh());
  }

  async function performMove(current: MoveState, requirementValues: unknown[] = []) {
    setMove({ ...current, phase: "saving" });

    const fd = new FormData();
    fd.set("opportunityId", current.card.id);
    fd.set("fromStageId", current.fromStageId);
    fd.set("toStageId", current.toStageId);
    fd.set("lockVersion", String(current.card.lockVersion));
    fd.set("requirementValues", JSON.stringify(requirementValues));

    let result: Awaited<ReturnType<typeof moveOpportunityStageAction>>;
    try {
      result = await moveOpportunityStageAction({ ok: false }, fd);
    } catch {
      fail("Não foi possível mover a oportunidade. Verifique a conexão e tente de novo.");
      return;
    }
    if (!result.ok) {
      fail(result.error ?? "Não foi possível mover a oportunidade.");
      return;
    }
    setMove({ ...current, phase: "confirmed", settledColumns: columns });
    startTransition(() => router.refresh());
  }

  function requestMove(card: OpportunityCardData, toStageId: string) {
    if (busy) return; // um movimento por vez — sem envio duplicado
    const fromStageId = findCardStage(card.id);
    if (!fromStageId || fromStageId === toStageId) return;
    if (!stageOptions.some((s) => s.id === toStageId)) return;

    setError(null);
    const current: MoveState = { card, fromStageId, toStageId, phase: "checking" };
    setMove(current);

    void (async () => {
      let check: Awaited<ReturnType<typeof checkStageRequirementsAction>>;
      try {
        check = await checkStageRequirementsAction(card.id, toStageId);
      } catch {
        fail("Não foi possível conferir os requisitos da etapa. Tente de novo.");
        return;
      }
      // Sem saber os requisitos, não move: "nenhum pendente" seria suposição.
      if (!check.ok) {
        fail(check.error);
        return;
      }
      if (check.requirements.some((r) => !r.filled)) {
        setMove({ ...current, phase: "requirements" });
        return;
      }
      await performMove(current);
    })();
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    if (!event.over) return;
    const card = allCards.find((c) => c.id === String(event.active.id));
    if (card) requestMove(card, String(event.over.id));
  }

  const activeCard = activeId ? allCards.find((c) => c.id === activeId) ?? null : null;
  const draggingFromStageId = activeId ? findCardStage(activeId) ?? null : null;

  const cardName = (id: string | number) => allCards.find((c) => c.id === String(id))?.contactName ?? "Oportunidade";
  const stageName = (id: string | number) => stageNameById.get(String(id)) ?? "etapa";
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Cartão de ${cardName(active.id)} levantado na etapa ${stageName(findCardStage(String(active.id)) ?? "")}.`,
    onDragOver: ({ active, over }) =>
      over ? `${cardName(active.id)} sobre a etapa ${stageName(over.id)}.` : `${cardName(active.id)} fora de uma etapa.`,
    onDragEnd: ({ active, over }) =>
      over ? `${cardName(active.id)} solto na etapa ${stageName(over.id)}.` : `${cardName(active.id)} solto fora de uma etapa; nada mudou.`,
    onDragCancel: ({ active }) => `Movimento de ${cardName(active.id)} cancelado; nada mudou.`,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {error ? (
        <Alert variant="danger" className="flex items-start gap-3 py-2.5">
          <AlertDescription className="flex-1">{error}</AlertDescription>
          <button
            type="button"
            aria-label="Fechar aviso"
            onClick={() => setError(null)}
            className="-my-0.5 rounded p-0.5 text-danger transition-colors hover:bg-black/20"
          >
            <X size={14} aria-hidden />
          </button>
        </Alert>
      ) : null}

      <DndContext
        id="pipeline-board"
        sensors={sensors}
        collisionDetection={collisionDetection}
        // Rolagem automática perto da borda mais contida: no celular a coluna
        // seguinte entra devagar o bastante para soltar no lugar certo.
        autoScroll={{ threshold: { x: 0.12, y: 0.15 }, acceleration: 5 }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              "Para mudar de etapa: pressione Espaço ou Enter para levantar o cartão, use as setas para a esquerda e para a direita para escolher a etapa e pressione Espaço ou Enter de novo para soltar. Esc cancela. Também é possível usar o botão Mover do cartão.",
          },
        }}
      >
        <div
          className={cn(
            "-mx-5 flex min-h-0 flex-1 gap-2.5 overflow-x-auto overscroll-x-contain px-5 pb-2",
            // Encaixe por coluna só para rolar com o dedo; durante o arraste
            // ele faria cada passo da rolagem automática pular uma coluna inteira.
            activeId ? "snap-none" : "snap-x snap-mandatory md:snap-none",
          )}
          data-testid="pipeline-board"
        >
          {displayColumns.map((column) => (
            <StageColumn
              key={column.stageId}
              column={column}
              canEdit={canEdit}
              busy={busy}
              dragging={activeId !== null}
              draggingFromStageId={draggingFromStageId}
              stages={stageOptions.filter((s) => s.id !== column.stageId)}
              pendingFor={(cardId) => (activeMove && activeMove.card.id === cardId ? activeMove.phase : null)}
              onMoveTo={requestMove}
              onWon={setWonTarget}
              onLost={setLostTarget}
            />
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeCard ? (
            <div
              className={cn(CARD_CLASS, "w-[82vw] max-w-[300px] cursor-grabbing border-accent-border bg-surface-hover shadow-raised md:w-[236px]")}
              style={{ transform: "rotate(1.5deg)" }}
            >
              <CardBody card={activeCard} canEdit={canEdit} pending={null} overlay stages={[]} disabled />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {activeMove && activeMove.phase === "requirements" ? (
        <StageAdvanceDialog
          opportunityId={activeMove.card.id}
          toStageId={activeMove.toStageId}
          open={true}
          onOpenChange={(open) => {
            // Fechar/cancelar sem confirmar: nada é gravado, cartão fica na origem.
            if (!open) setMove(null);
          }}
          onConfirm={async (requirementValues) => {
            await performMove(activeMove, requirementValues);
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
