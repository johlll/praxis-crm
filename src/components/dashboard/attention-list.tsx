import type { Route } from "next";
import Link from "next/link";
import { AlarmClock, ArrowRight, Hourglass, ListChecks, UserX, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { formatDue } from "@/lib/timezone";
import { ACTIVITY_TYPE_LABEL } from "@/components/activities/labels";
import type { AttentionItem, Dashboard } from "@/modules/dashboard/queries";
import { daysSince, formatBRL } from "@/modules/dashboard/presentation";
import { PanelIcon } from "./panel-icon";

/** Sinal mais urgente do item, só para o ícone — o texto da linha diz todos. */
function signalOf(item: AttentionItem): { icon: LucideIcon; tone: string } {
  if (item.overdueActivitiesCount > 0) return { icon: AlarmClock, tone: "bg-danger-bg text-danger" };
  if (item.isStalled) return { icon: Hourglass, tone: "bg-warning-bg text-warning" };
  return { icon: UserX, tone: "bg-neutral-bg text-text-secondary" };
}

/**
 * Oportunidades abertas que exigem atenção agora (parada há mais de N
 * dias, sem responsável ou com atividade atrasada). O total vem do banco
 * sobre TODAS as abertas; a lista mostra as mais urgentes primeiro.
 */
export function AttentionList({
  dashboard,
  hrefFor,
  selectedId,
}: {
  dashboard: Dashboard;
  hrefFor: Record<string, Route>;
  selectedId: string | null;
}) {
  const { attention } = dashboard;

  return (
    <section
      id="atencao"
      aria-labelledby="atencao-titulo"
      className="flex max-h-[600px] min-h-0 min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4 lg:max-h-none lg:flex-1"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <PanelIcon icon={ListChecks} />
        <div className="flex min-w-0 flex-col">
          <h2 id="atencao-titulo" className="m-0 text-lead font-bold text-text">
            Oportunidades que exigem atenção
          </h2>
          <p className="m-0 text-meta text-text-muted">
            Paradas, sem responsável ou com atividade atrasada ·{" "}
            <span className="whitespace-nowrap">
              {attention.items.length < attention.total
                ? `mostrando ${attention.items.length} de ${attention.total}`
                : `${attention.total} agora`}
            </span>
          </p>
        </div>
      </div>

      {attention.items.length === 0 ? (
        <p className="m-0 text-body text-text-secondary">Nenhuma oportunidade aberta está parada, sem responsável ou com atraso.</p>
      ) : (
        <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-2 overflow-y-auto p-0 pr-1 lg:max-h-[30rem]">
          {attention.items.map((item) => {
            const stalledFor = daysSince(item.stageEnteredAt, dashboard.generatedAt);
            const value =
              item.valueCents !== undefined
                ? item.valueCents === null
                  ? "Sem valor"
                  : formatBRL(item.valueCents)
                : item.valueBand;
            const signal = signalOf(item);
            const Icon = signal.icon;
            return (
              <li key={item.id}>
                <Link
                  href={hrefFor[item.id] ?? "/visao-geral"}
                  scroll={false}
                  aria-current={selectedId === item.id ? "true" : undefined}
                  className={cn(
                    "flex items-start gap-3 rounded-card border px-3 py-2.5 text-text hover:no-underline",
                    selectedId === item.id ? "border-primary bg-surface-selected" : "border-border bg-surface hover:bg-surface-hover",
                    item.isUnassigned && selectedId !== item.id && "border-dashed border-border-unassigned",
                  )}
                >
                  <span aria-hidden className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[9px]", signal.tone)}>
                    <Icon size={15} strokeWidth={1.75} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-body font-bold">{item.contactName}</span>
                      {value !== undefined ? <span className="shrink-0 font-mono text-small text-text">{value}</span> : null}
                    </span>
                    <span className="truncate text-meta text-text-secondary">
                      {item.legalArea} · {item.stageName}
                    </span>
                    <span className="flex flex-wrap items-baseline justify-between gap-x-2 text-meta">
                      <span className="text-text-secondary">{item.assignedToName ?? "Sem responsável"}</span>
                      <span className="flex gap-2">
                        {item.overdueActivitiesCount > 0 ? (
                          <span className="text-danger">
                            {item.overdueActivitiesCount} atrasada{item.overdueActivitiesCount === 1 ? "" : "s"}
                          </span>
                        ) : null}
                        {item.isStalled ? <span className="text-danger">parada há {stalledFor} dias</span> : null}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 border-t border-dashed border-border-subtle pt-1.5 text-meta text-text-secondary">
                      <ArrowRight size={11} aria-hidden className="shrink-0" />
                      <span className="min-w-0">
                        {item.nextAction
                          ? `${ACTIVITY_TYPE_LABEL[item.nextAction.type]}: ${item.nextAction.title} — ${formatDue(item.nextAction.dueAt, item.nextAction.hasTime)}`
                          : "Sem próxima atividade agendada"}
                      </span>
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
