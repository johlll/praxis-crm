"use client";

import { useState } from "react";
import type { Route } from "next";
import Link from "next/link";
import { Funnel } from "lucide-react";

import { cn } from "@/lib/cn";
import type { Dashboard } from "@/modules/dashboard/queries";
import { formatBRL, formatPercent, periodTexts } from "@/modules/dashboard/presentation";
import { PanelIcon } from "./panel-icon";

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

/**
 * Barra horizontal de UMA etapa: comprimento = valor ÷ máximo da leitura
 * (a coorte inteira em "No período"; a maior etapa em "Agora"). A trilha
 * ao fundo é o máximo; nada é forçado a diminuir de uma etapa para a outra.
 */
function Bar({ value, max, tone }: { value: number; max: number; tone: "info" | "primary" }) {
  const width = max === 0 ? 0 : Math.max(value > 0 ? 1.5 : 0, (value / max) * 100);
  return (
    <div className="h-3.5 min-w-0 flex-1 overflow-hidden rounded-[4px] bg-app" aria-hidden>
      <div
        className={cn("h-full rounded-r-[4px]", tone === "info" ? "bg-info" : "bg-primary")}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

/** Número de ordem da etapa no pipeline (a ordem é a atual, como no Kanban). */
function StageIndex({ index }: { index: number }) {
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border-strong text-[10px] font-semibold text-text-tertiary tabular"
    >
      {index + 1}
    </span>
  );
}

const ROW = "grid grid-cols-[minmax(0,1fr)_2.5rem_3.5rem] items-center gap-x-3 gap-y-1.5 md:grid-cols-[minmax(0,13.5rem)_minmax(0,1fr)_2.5rem_3.5rem]";

/**
 * Duas leituras separadas das etapas REAIS do pipeline escolhido:
 * - "No período": coorte das oportunidades criadas no período; cada uma
 *   conta uma vez em cada etapa por onde REALMENTE passou (etapa atual e
 *   origem/destino das transições registradas), sem somar reentradas e
 *   sem inferir passagem por etapa pulada. A taxa ao lado é a mesma
 *   população: das que passaram por aquela etapa, quantas seguiram
 *   adiante. Ganhas e perdas registradas à parte — quem não avançou está
 *   "em andamento", não perdido.
 * - "Agora": distribuição atual das abertas por etapa.
 *
 * Barras horizontais, não segmentos encadeados: o pipeline padrão tem oito
 * etapas com nomes longos, e o nome inteiro de cada uma precisa caber.
 */
export function FunnelCard({ dashboard, pipelineHrefs }: { dashboard: Dashboard; pipelineHrefs: Record<string, Route> }) {
  const [view, setView] = useState<View>("periodo");
  const funnel = dashboard.funnel;

  return (
    <section aria-labelledby="funil-titulo" className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <PanelIcon icon={Funnel} />
          <div className="flex min-w-0 flex-col">
            <h2 id="funil-titulo" className="m-0 text-lead font-bold text-text">
              Funil por etapa{funnel ? ` · ${funnel.pipelineName}` : ""}
            </h2>
            <p className="m-0 text-meta text-text-muted">
              {view === "periodo"
                ? `Oportunidades criadas ${periodTexts(dashboard.period).inPeriod} e as etapas por onde passaram`
                : "Oportunidades abertas agora, por etapa"}
            </p>
          </div>
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
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
              <div className="flex min-w-0 flex-col gap-2">
                <div aria-hidden className={cn(ROW, "text-label font-semibold tracking-[1px] text-text-tertiary uppercase")}>
                  <span className="max-md:hidden">Etapa</span>
                  <span />
                  <span className="text-right">Pass.</span>
                  <span className="text-right">Seguiu</span>
                </div>
                <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
                  {funnel.stages.map((stage, index) => {
                    // Taxa de avanço da própria etapa: numerador (seguiram
                    // adiante) e denominador (passaram por ela) são o mesmo
                    // conjunto de oportunidades, então nunca passa de 100% e
                    // não compara duas contagens independentes.
                    const rate = formatPercent(stage.advanced, stage.visited);
                    return (
                      <li key={stage.stageId} className={ROW}>
                        <span className="flex min-w-0 items-center gap-2 max-md:col-span-3">
                          <StageIndex index={index} />
                          <span className="min-w-0 text-small leading-tight text-text-secondary" title={stage.name}>
                            {stage.name}
                          </span>
                        </span>
                        <Bar value={stage.visited} max={funnel.cohortSize} tone="info" />
                        <span
                          className="text-right tabular text-body font-bold text-text"
                          title={`${stage.visited} de ${funnel.cohortSize} passaram por esta etapa`}
                        >
                          {stage.visited}
                        </span>
                        <span
                          className="text-right tabular text-meta text-text-tertiary"
                          title={
                            rate
                              ? `${stage.advanced} das ${stage.visited} que passaram por esta etapa seguiram adiante (etapa posterior ou ganho registrado)`
                              : undefined
                          }
                        >
                          {rate ?? ""}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>

              <CohortSummary
                size={funnel.cohortSize}
                won={funnel.cohortWon}
                lost={funnel.cohortLost}
                open={funnel.cohortOpen}
              />
            </div>
            <p className="m-0 text-meta text-text-muted">
              <strong className="font-semibold">Pass.</strong> = passaram por esta etapa, contando uma vez cada, mesmo se voltaram e
              reentraram. Etapa pulada não conta como passagem. <strong className="font-semibold">Seguiu</strong> = das que passaram por
              esta etapa, quantas seguiram adiante (etapa posterior ou ganho registrado) — a taxa é sempre sobre a mesma população.
            </p>
          </>
        )
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
          {funnel.stages.map((stage, index) => (
            <li
              key={stage.stageId}
              className={cn(
                "grid items-center gap-x-3 gap-y-1.5",
                stage.valueSumCents !== undefined
                  ? "grid-cols-[minmax(0,1fr)_2.5rem_6.5rem] md:grid-cols-[minmax(0,13.5rem)_minmax(0,1fr)_2.5rem_6.5rem]"
                  : "grid-cols-[minmax(0,1fr)_2.5rem] md:grid-cols-[minmax(0,13.5rem)_minmax(0,1fr)_2.5rem]",
              )}
            >
              <span className={cn("flex min-w-0 items-center gap-2", stage.valueSumCents !== undefined ? "max-md:col-span-3" : "max-md:col-span-2")}>
                <StageIndex index={index} />
                <span className="min-w-0 text-small leading-tight text-text-secondary" title={stage.name}>
                  {stage.name}
                </span>
              </span>
              <Bar value={stage.openNow} max={Math.max(...funnel.stages.map((s) => s.openNow))} tone="primary" />
              <span className="text-right tabular text-body font-bold text-text">{stage.openNow}</span>
              {stage.valueSumCents !== undefined ? (
                <span className="text-right tabular font-mono text-meta text-text-tertiary">{formatBRL(stage.valueSumCents)}</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Destino da coorte: ganhas, perdas registradas e em andamento somam a
 * coorte inteira (todo registro tem exatamente um desses estados). A barra
 * fina repete a mesma divisão; os números estão na lista logo abaixo dela.
 */
function CohortSummary({ size, won, lost, open }: { size: number; won: number; lost: number; open: number }) {
  const parts = [
    { key: "won", value: won, swatch: "bg-primary" },
    { key: "lost", value: lost, swatch: "bg-danger" },
    { key: "open", value: open, swatch: "bg-neutral" },
  ].filter((part) => part.value > 0);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border-subtle bg-app px-4 py-3.5">
      <div aria-hidden className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full">
        {parts.map((part) => (
          <span key={part.key} className={cn("h-full first:rounded-l-full last:rounded-r-full", part.swatch)} style={{ flexGrow: part.value, flexBasis: 0 }} />
        ))}
      </div>
      <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-3 lg:grid-cols-1">
        <div className="col-span-2 lg:col-span-1">
          <dt className="text-meta text-text-tertiary">Criadas no período</dt>
          <dd className="m-0 text-[22px] leading-tight font-bold text-text">{size}</dd>
        </div>
        <div className="flex items-start gap-2">
          <span aria-hidden className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
          <div>
            <dt className="text-meta text-text-tertiary">Ganhas</dt>
            <dd className="m-0 tabular text-body font-bold text-primary">
              {won} <span className="font-normal text-text-tertiary">({formatPercent(won, size)})</span>
            </dd>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <span aria-hidden className="mt-1 size-2 shrink-0 rounded-full bg-danger" />
          <div>
            <dt className="text-meta text-text-tertiary">Perdas registradas</dt>
            <dd className="m-0 tabular text-body font-bold text-danger">{lost}</dd>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <span aria-hidden className="mt-1 size-2 shrink-0 rounded-full bg-neutral" />
          <div>
            <dt className="text-meta text-text-tertiary">Em andamento</dt>
            <dd className="m-0 tabular text-body font-bold text-text">{open}</dd>
          </div>
        </div>
      </dl>
    </div>
  );
}
