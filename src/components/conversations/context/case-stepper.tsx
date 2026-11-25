import { cn } from "@/lib/cn";
import type { Step } from "@/modules/conversations/case-display";

const STATE_TEXT = { previous: "etapa anterior", current: "etapa atual", next: "etapa seguinte" } as const;

/** Até este número de etapas a faixa é horizontal (como na referência); acima, lista vertical. */
const HORIZONTAL_MAX = 4;

function Dot({ state }: { state: Step["state"] }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-10 flex size-[18px] shrink-0 items-center justify-center rounded-full border-2 bg-surface",
        state === "current" && "border-primary",
        state === "previous" && "border-border-strong",
        state === "next" && "border-border",
      )}
    >
      {state === "current" ? <span className="size-2 rounded-full bg-primary" /> : null}
      {state === "previous" ? <span className="size-1.5 rounded-full bg-border-strong" /> : null}
    </span>
  );
}

/**
 * Andamento visual por POSIÇÃO no funil comercial. Anterior e seguinte são só a ordem das etapas: o banco não
 * registra "etapa concluída", então não há marca de conclusão (✓) em lugar nenhum.
 */
export function CaseStepper({ steps, label }: { steps: Step[]; label: string }) {
  const currentIdx = steps.findIndex((s) => s.state === "current");

  if (steps.length <= HORIZONTAL_MAX) {
    return (
      <ol aria-label={label} className="m-0 grid list-none p-0" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((s, i) => (
          <li key={s.id} className="relative flex min-w-0 flex-col items-center gap-1.5 text-center" aria-current={s.state === "current" ? "step" : undefined}>
            {i > 0 ? (
              <span
                aria-hidden
                className={cn("absolute right-1/2 top-[8px] h-0.5 w-full", i <= currentIdx ? "bg-border-strong" : "bg-border")}
              />
            ) : null}
            <Dot state={s.state} />
            <span
              className={cn(
                "px-0.5 text-meta leading-tight [overflow-wrap:anywhere]",
                s.state === "current" ? "font-bold text-text" : "text-text-tertiary",
              )}
            >
              {s.name}
              <span className="sr-only"> ({STATE_TEXT[s.state]})</span>
            </span>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <ol aria-label={label} className="m-0 flex list-none flex-col p-0">
      {steps.map((s, i) => (
        <li key={s.id} className="relative flex items-start gap-2.5 pb-2.5 last:pb-0" aria-current={s.state === "current" ? "step" : undefined}>
          {i < steps.length - 1 ? (
            <span aria-hidden className="absolute left-[8px] top-[18px] h-[calc(100%-18px)] w-0.5 bg-border" />
          ) : null}
          <Dot state={s.state} />
          <span
            className={cn(
              "min-w-0 pt-px text-small leading-tight [overflow-wrap:anywhere]",
              s.state === "current" ? "font-bold text-text" : "text-text-tertiary",
            )}
          >
            {s.name}
            {s.state === "current" ? (
              <span className="ml-1.5 rounded-full bg-primary-tint px-1.5 py-px text-label font-bold text-primary">atual</span>
            ) : null}
            <span className="sr-only"> ({STATE_TEXT[s.state]})</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
