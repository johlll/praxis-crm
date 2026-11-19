import { Check } from "lucide-react";

import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/timezone";
import { SERVICE_HORIZONTAL_MAX, type ServiceStepItem } from "@/modules/case-service/schema";

const STATE_TEXT = { completed: "concluída", current: "etapa atual", pending: "pendente" } as const;

/**
 * Marca de cada etapa — distinta SEM depender de cor: concluída tem ✓ preenchido; atual, um anel com ponto
 * e a palavra "atual"; pendente, um círculo vazio. O leitor de tela recebe o estado por extenso.
 */
function Mark({ state }: { state: ServiceStepItem["state"] }) {
  if (state === "completed") {
    return (
      <span aria-hidden className="relative z-10 flex size-[20px] shrink-0 items-center justify-center rounded-full bg-success text-on-solid">
        <Check size={13} strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-10 flex size-[20px] shrink-0 items-center justify-center rounded-full border-2 bg-surface",
        state === "current" ? "border-primary" : "border-border-strong",
      )}
    >
      {state === "current" ? <span className="size-2 rounded-full bg-primary" /> : null}
    </span>
  );
}

function completedLine(s: ServiceStepItem): string | null {
  if (s.state !== "completed" || !s.completedAt) return null;
  return `Concluída em ${formatDate(s.completedAt)}${s.completedByName ? ` por ${s.completedByName}` : ""}`;
}

/**
 * Andamento do serviço pelo ROTEIRO do caso: conclusões efetivamente registradas e a etapa atual escolhida.
 * Nada é deduzido da posição: uma etapa antes da atual sem registro de conclusão continua pendente.
 */
export function ServiceStepper({ steps, label }: { steps: ServiceStepItem[]; label: string }) {
  if (steps.length <= SERVICE_HORIZONTAL_MAX) {
    return (
      <ol aria-label={label} className="m-0 grid list-none p-0" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((s, i) => {
          const done = completedLine(s);
          return (
            <li
              key={s.id}
              className="relative flex min-w-0 flex-col items-center gap-1.5 text-center"
              aria-current={s.state === "current" ? "step" : undefined}
              title={done ?? undefined}
            >
              {i > 0 ? (
                <span
                  aria-hidden
                  // A linha só fica cheia entre duas etapas CONCLUÍDAS (registro dos dois lados), nunca por posição.
                  className={cn(
                    "absolute right-1/2 top-[9px] h-0.5 w-full",
                    s.state === "completed" && steps[i - 1]?.state === "completed" ? "bg-success" : "bg-border",
                  )}
                />
              ) : null}
              <Mark state={s.state} />
              <span
                className={cn(
                  // Hifenização em português antes de quebrar no meio da palavra (colunas estreitas da faixa).
                  "hyphens-auto px-0.5 text-meta leading-tight [overflow-wrap:break-word]",
                  s.state === "current" ? "font-bold text-text" : s.state === "completed" ? "text-text-secondary" : "text-text-tertiary",
                )}
              >
                {s.name}
                <span className="sr-only">
                  {" "}
                  ({STATE_TEXT[s.state]}
                  {done ? ` — ${done}` : ""})
                </span>
              </span>
              {s.state === "current" ? (
                <span aria-hidden className="rounded-full bg-primary-tint px-1.5 py-px text-label font-bold text-primary">
                  atual
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <ol aria-label={label} className="m-0 flex list-none flex-col p-0">
      {steps.map((s, i) => {
        const done = completedLine(s);
        return (
          <li key={s.id} className="relative flex items-start gap-2.5 pb-3 last:pb-0" aria-current={s.state === "current" ? "step" : undefined}>
            {i < steps.length - 1 ? (
              <span
                aria-hidden
                className={cn(
                  "absolute left-[9px] top-[20px] h-[calc(100%-20px)] w-0.5",
                  s.state === "completed" && steps[i + 1]?.state === "completed" ? "bg-success" : "bg-border",
                )}
              />
            ) : null}
            <Mark state={s.state} />
            <span className="flex min-w-0 flex-col gap-0.5 pt-px">
              <span
                className={cn(
                  "text-small leading-tight [overflow-wrap:anywhere]",
                  s.state === "current" ? "font-bold text-text" : s.state === "completed" ? "text-text-secondary" : "text-text-tertiary",
                )}
              >
                <span className="mr-1 tabular-nums text-text-muted">{s.position}.</span>
                {s.name}
                {s.state === "current" ? (
                  <span aria-hidden className="ml-1.5 rounded-full bg-primary-tint px-1.5 py-px text-label font-bold text-primary">
                    atual
                  </span>
                ) : null}
                <span className="sr-only"> ({STATE_TEXT[s.state]})</span>
              </span>
              {done ? <span className="text-meta text-text-tertiary">{done}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
