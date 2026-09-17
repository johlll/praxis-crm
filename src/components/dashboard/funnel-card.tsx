"use client";

import { useState } from "react";
import type { Route } from "next";
import Link from "next/link";

import { cn } from "@/lib/cn";
import type { Dashboard } from "@/modules/dashboard/queries";
import { formatBRL, formatPercent } from "@/modules/dashboard/presentation";

type View = "periodo" | "agora";

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded-md border border-border bg-app p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-[6px] px-2.5 py-1 text-small font-medium",
            value === option.value ? "bg-surface text-text shadow-raised" : "text-text-secondary hover:text-text",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Bar({ value, max, tone }: { value: number; max: number; tone: "info" | "primary" }) {
  const width = max === 0 ? 0 : Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100));
  return (
    <div className="h-[22px] flex-1 overflow-hidden rounded-[5px] bg-neutral-bg" aria-hidden>
      <div className={cn("h-full rounded-[5px]", tone === "info" ? "bg-info" : "bg-primary")} style={{ width: `${width}%` }} />
    </div>
  );
}

/**
 * Duas leituras separadas das etapas REAIS do pipeline escolhido:
 * - "No período": coorte das oportunidades criadas no período; cada uma
 *   conta uma vez em cada etapa que alcançou (ou ultrapassou), sem somar
 *   reentradas; ganhas e perdas registradas à parte — quem não avançou está
 *   "em andamento", não perdido.
 * - "Agora": distribuição atual das abertas por etapa.
 */
export function FunnelCard({ dashboard, pipelineHrefs }: { dashboard: Dashboard; pipelineHrefs: Record<string, Route> }) {
  const [view, setView] = useState<View>("periodo");
  const funnel = dashboard.funnel;

  return (
    <section aria-labelledby="funil-titulo" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <h2 id="funil-titulo" className="m-0 text-body font-bold text-text">
            Funil por etapa{funnel ? ` · ${funnel.pipelineName}` : ""}
          </h2>
          <p className="m-0 text-meta text-text-muted">
            {view === "periodo"
              ? `Oportunidades criadas nos últimos ${dashboard.period.days} dias e até onde chegaram`
              : "Oportunidades abertas agora, por etapa"}
          </p>
        </div>
        <SegmentedControl
          label="Leitura do funil"
          value={view}
          onChange={setView}
          options={[
            { value: "periodo", label: "No período" },
            { value: "agora", label: "Agora" },
          ]}
        />
      </div>

      {dashboard.pipelines.length > 1 ? (
        <nav aria-label="Pipeline do funil" className="flex flex-wrap gap-1.5">
          {dashboard.pipelines.map((p) => (
            <Link
              key={p.id}
              href={pipelineHrefs[p.id] ?? "/visao-geral"}
              aria-current={funnel?.pipelineId === p.id ? "true" : undefined}
              className={cn(
                "rounded-pill border px-2.5 py-0.5 text-meta",
                funnel?.pipelineId === p.id ? "border-primary bg-primary-tint text-primary" : "border-border text-text-secondary",
              )}
            >
              {p.name}
            </Link>
          ))}
        </nav>
      ) : null}

      {!funnel ? (
        <p className="m-0 text-body text-text-secondary">Este escritório ainda não tem pipeline configurado.</p>
      ) : view === "periodo" ? (
        funnel.cohortSize === 0 ? (
          <p className="m-0 rounded-md bg-app px-3 py-6 text-center text-body text-text-secondary">
            Indisponível: nenhuma oportunidade foi criada neste pipeline no período, então não há avanço para medir.
          </p>
        ) : (
          <>
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {funnel.stages.map((stage, index) => {
                const previous = index === 0 ? funnel.cohortSize : funnel.stages[index - 1]!.reached;
                const rate = index === 0 ? null : formatPercent(stage.reached, previous);
                return (
                  <li key={stage.stageId} className="flex items-center gap-3">
                    <span className="w-[170px] shrink-0 truncate text-small text-text-secondary" title={stage.name}>
                      {stage.name}
                    </span>
                    <Bar value={stage.reached} max={funnel.cohortSize} tone="info" />
                    <span className="w-8 shrink-0 text-right tabular text-body font-bold text-text">{stage.reached}</span>
                    <span
                      className="w-[52px] shrink-0 text-right tabular text-meta text-text-tertiary"
                      title={rate ? "Alcançaram esta etapa, sobre as que alcançaram a anterior" : undefined}
                    >
                      {rate ?? ""}
                    </span>
                  </li>
                );
              })}
            </ol>
            <dl className="m-0 grid grid-cols-2 gap-2 border-t border-border-subtle pt-3 md:grid-cols-4">
              <div>
                <dt className="text-meta text-text-tertiary">Criadas no período</dt>
                <dd className="m-0 tabular text-body font-bold">{funnel.cohortSize}</dd>
              </div>
              <div>
                <dt className="text-meta text-text-tertiary">Ganhas</dt>
                <dd className="m-0 tabular text-body font-bold text-primary">
                  {funnel.cohortWon}{" "}
                  <span className="font-normal text-text-tertiary">({formatPercent(funnel.cohortWon, funnel.cohortSize)})</span>
                </dd>
              </div>
              <div>
                <dt className="text-meta text-text-tertiary">Perdas registradas</dt>
                <dd className="m-0 tabular text-body font-bold text-danger">{funnel.cohortLost}</dd>
              </div>
              <div>
                <dt className="text-meta text-text-tertiary">Em andamento</dt>
                <dd className="m-0 tabular text-body font-bold">{funnel.cohortOpen}</dd>
              </div>
            </dl>
            <p className="m-0 text-meta text-text-muted">
              Cada oportunidade conta uma vez por etapa alcançada, mesmo se voltou e reentrou. Ganhas podem sair de qualquer etapa.
            </p>
          </>
        )
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {funnel.stages.map((stage) => (
            <li key={stage.stageId} className="flex items-center gap-3">
              <span className="w-[170px] shrink-0 truncate text-small text-text-secondary" title={stage.name}>
                {stage.name}
              </span>
              <Bar value={stage.openNow} max={Math.max(...funnel.stages.map((s) => s.openNow))} tone="primary" />
              <span className="w-8 shrink-0 text-right tabular text-body font-bold text-text">{stage.openNow}</span>
              {stage.valueSumCents !== undefined ? (
                <span className="w-[92px] shrink-0 text-right tabular font-mono text-meta text-text-tertiary">
                  {formatBRL(stage.valueSumCents)}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
