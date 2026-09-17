import type { Route } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/cn";
import { formatDue } from "@/lib/timezone";
import { ACTIVITY_TYPE_LABEL } from "@/components/activities/labels";
import type { Dashboard } from "@/modules/dashboard/queries";
import { daysSince, formatBRL } from "@/modules/dashboard/presentation";

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
      className="flex max-h-[560px] flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="atencao-titulo" className="m-0 text-body font-bold text-text">
          Oportunidades que exigem atenção
        </h2>
        <span className="text-meta text-text-muted">
          {attention.items.length < attention.total
            ? `mostrando ${attention.items.length} de ${attention.total}`
            : `${attention.total} agora`}
        </span>
      </div>

      {attention.items.length === 0 ? (
        <p className="m-0 text-body text-text-secondary">Nenhuma oportunidade aberta está parada, sem responsável ou com atraso.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 overflow-y-auto p-0 pr-1">
          {attention.items.map((item) => {
            const stalledFor = daysSince(item.stageEnteredAt, dashboard.generatedAt);
            const value =
              item.valueCents !== undefined
                ? item.valueCents === null
                  ? "Sem valor"
                  : formatBRL(item.valueCents)
                : item.valueBand;
            return (
              <li key={item.id}>
                <Link
                  href={hrefFor[item.id] ?? "/visao-geral"}
                  scroll={false}
                  aria-current={selectedId === item.id ? "true" : undefined}
                  className={cn(
                    "flex flex-col gap-1 rounded-card border px-3 py-2.5 text-text hover:no-underline",
                    selectedId === item.id ? "border-primary bg-surface-selected" : "border-border bg-surface hover:bg-surface-subtle",
                    item.isUnassigned && selectedId !== item.id && "border-dashed border-border-unassigned",
                  )}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-body font-bold">{item.contactName}</span>
                    {value !== undefined ? (
                      <span className="shrink-0 font-mono text-small text-text">{value}</span>
                    ) : null}
                  </span>
                  <span className="truncate text-meta text-text-secondary">
                    {item.legalArea} · {item.stageName}
                  </span>
                  <span className="flex items-baseline justify-between gap-2 text-meta">
                    <span className="text-text-secondary">{item.assignedToName ?? "Sem responsável"}</span>
                    <span className="flex gap-2">
                      {item.overdueActivitiesCount > 0 ? (
                        <span className="text-danger">
                          {item.overdueActivitiesCount} atrasada{item.overdueActivitiesCount === 1 ? "" : "s"}
                        </span>
                      ) : null}
                      {item.isStalled ? (
                        <span className="text-danger">parada há {stalledFor} dias</span>
                      ) : null}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 border-t border-dashed border-border-subtle pt-1.5 text-meta text-text-secondary">
                    <ArrowRight size={11} aria-hidden />
                    {item.nextAction
                      ? `${ACTIVITY_TYPE_LABEL[item.nextAction.type]}: ${item.nextAction.title} — ${formatDue(item.nextAction.dueAt, item.nextAction.hasTime)}`
                      : "Sem próxima atividade agendada"}
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
