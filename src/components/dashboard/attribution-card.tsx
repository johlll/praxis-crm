"use client";

import { useEffect, useState } from "react";
import type { Route } from "next";
import Link from "next/link";
import { ChartPie } from "lucide-react";
import { Pie, PieChart, Tooltip, useActiveTooltipDataPoints } from "recharts";

import { cn } from "@/lib/cn";
import { ChartFrame } from "@/components/charts/chart-frame";
import type { DashboardAttribution } from "@/modules/attribution/queries";
import { ATTRIBUTION_MODEL_LABEL, ATTRIBUTION_MODELS, NO_SOURCE_FILTER } from "@/modules/forms/schema";
import { buildOriginBreakdown, formatPercent, type OriginColor } from "@/modules/dashboard/presentation";
import { PanelIcon } from "./panel-icon";

/** Paleta categórica validada (tokens chart1…chart6) + neutro de "sem origem". */
const FILL: Record<OriginColor, string> = {
  chart1: "var(--color-chart1)",
  chart2: "var(--color-chart2)",
  chart3: "var(--color-chart3)",
  chart4: "var(--color-chart4)",
  chart5: "var(--color-chart5)",
  chart6: "var(--color-chart6)",
  neutral: "var(--color-neutral)",
};
const SWATCH: Record<OriginColor, string> = {
  chart1: "bg-chart1",
  chart2: "bg-chart2",
  chart3: "bg-chart3",
  chart4: "bg-chart4",
  chart5: "bg-chart5",
  chart6: "bg-chart6",
  neutral: "bg-neutral",
};

const DONUT_SIZE = 156;
const RING = 22;

type Slice = { key: string; name: string; value: number; share: number; fill: string };

/**
 * Centro da rosca: o total das criadas; com uma fatia apontada (mouse ou
 * teclado), o número e a parcela dela — e a linha correspondente da
 * tabela-legenda acende ao lado. Sem caixa flutuante: nada sai do cartão.
 */
function DonutCenter({ total, onActive }: { total: number; onActive: (key: string | null) => void }) {
  const active = useActiveTooltipDataPoints<Slice>();
  const slice = active?.[0];
  const activeKey = slice?.key ?? null;
  useEffect(() => onActive(activeKey), [activeKey, onActive]);

  const c = DONUT_SIZE / 2;
  return (
    <g pointerEvents="none">
      <text x={c} y={c + 2} textAnchor="middle" fill="var(--color-text)" style={{ fontSize: 22, fontWeight: 700 }}>
        {(slice ? slice.value : total).toLocaleString("pt-BR")}
      </text>
      <text x={c} y={c + 19} textAnchor="middle" fill="var(--color-text-muted)" style={{ fontSize: 11 }}>
        {slice ? `${formatPercent(slice.value, total)} das criadas` : total === 1 ? "criada" : "criadas"}
      </text>
    </g>
  );
}

/** Reserva antes de medir (servidor, sem JavaScript): o anel vazio com o total. */
function DonutPlaceholder({ total }: { total: number }) {
  return (
    <div aria-hidden className="absolute inset-[2px] flex flex-col items-center justify-center rounded-full border-border-subtle" style={{ borderWidth: RING }}>
      <span className="text-[22px] leading-none font-bold text-text">{total.toLocaleString("pt-BR")}</span>
      <span className="mt-1 text-meta leading-tight text-text-muted">{total === 1 ? "criada" : "criadas"}</span>
    </div>
  );
}

/**
 * Origem das oportunidades por modelo de atribuição (A11).
 *
 * Duas honestidades que a tela precisa manter à vista:
 *
 *  1. a UNIDADE é a oportunidade, não o lead. Um lead pode ter várias
 *     oportunidades com origens diferentes; contar "leads por origem"
 *     trocaria a unidade no meio do caminho sem avisar.
 *  2. o NÚMERO MUDA conforme o modelo — e isso é dito com todas as
 *     letras, porque é a diferença entre "quem trouxe" e "quem fechou".
 *
 * A rosca mostra só as CRIADAS no período: cada uma está em exatamente uma
 * origem do modelo escolhido, então as fatias somam o total do centro.
 * "Ganhas" (ganhas no período, outra população) fica só na tabela.
 *
 * O filtro de origem é coerente com o modelo escolhido: filtrar "X" no
 * primeiro toque mantém as oportunidades cujo primeiro toque tem origem
 * X; no último toque, cujo último toque tem origem X.
 */
export function AttributionCard({
  attribution,
  modelHrefs,
  sourceHrefs,
  clearSourceHref,
}: {
  attribution: DashboardAttribution;
  modelHrefs: Record<string, Route>;
  sourceHrefs: Record<string, Route>;
  clearSourceHref: Route;
}) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const breakdown = buildOriginBreakdown(attribution.sources);
  const total = breakdown.totalCreated;
  const isSelected = (source: string | null) => (attribution.source ?? null) === (source ?? NO_SOURCE_FILTER);
  const selectedKey = breakdown.rows.find((row) => isSelected(row.source))?.segmentKey ?? null;

  const slices: Slice[] = breakdown.segments.map((segment) => {
    const dim = selectedKey !== null && segment.key !== selectedKey;
    return {
      key: segment.key,
      name: segment.label,
      value: segment.created,
      share: segment.share,
      // Com uma origem filtrada, as outras fatias recuam (continuam visíveis e na tabela).
      fill: dim ? `color-mix(in srgb, ${FILL[segment.color]} 30%, var(--color-surface))` : FILL[segment.color],
    };
  });

  return (
    <section aria-labelledby="origem-titulo" className="flex h-full min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex min-w-0 items-start gap-2.5">
        <PanelIcon icon={ChartPie} />
        <div className="flex min-w-0 flex-col">
          <h2 id="origem-titulo" className="m-0 text-lead font-bold text-text">
            Origem das oportunidades
          </h2>
          <p className="m-0 text-meta text-text-muted">
            Unidade: oportunidade. O número muda conforme o modelo escolhido — é o mesmo dado lido de outro jeito, não uma
            correção do anterior.
          </p>
        </div>
      </div>

      <nav aria-label="Modelo de atribuição" className="flex flex-wrap gap-1.5">
        {ATTRIBUTION_MODELS.map((model) => (
          <Link
            key={model}
            href={modelHrefs[model] ?? "/visao-geral"}
            aria-current={attribution.model === model ? "true" : undefined}
            className={cn(
              "rounded-pill border px-2.5 py-0.5 text-meta",
              attribution.model === model ? "border-primary bg-primary-tint text-primary" : "border-border text-text-secondary",
            )}
          >
            {ATTRIBUTION_MODEL_LABEL[model]}
          </Link>
        ))}
      </nav>

      {attribution.model === "conversion" ? (
        <p className="m-0 rounded-md bg-app px-3 py-2 text-meta text-text-secondary">
          Conversão conta apenas a interação que nasceu na própria oportunidade. Uma interação corrigida para cá depois
          aparece no primeiro e no último toque, nunca aqui.
        </p>
      ) : null}

      {attribution.sources.length === 0 ? (
        <p className="m-0 flex flex-1 items-center justify-center rounded-md bg-app px-3 py-6 text-center text-body text-text-secondary">
          Nenhuma oportunidade com origem registrada neste período.
        </p>
      ) : (
        <div className="@container flex flex-1 flex-col gap-3">
          <div className="flex flex-col items-center gap-4 @md:flex-row @md:items-start">
            {breakdown.showDonut ? (
              <figure className="relative m-0 shrink-0" style={{ width: DONUT_SIZE, height: DONUT_SIZE }}>
                <figcaption className="sr-only">
                  {`${total} oportunidades criadas, divididas por origem; os números de cada origem estão na tabela.`}
                </figcaption>
                <ChartFrame height={DONUT_SIZE} placeholder={<DonutPlaceholder total={total} />}>
                  {({ width }) => (
                    <PieChart width={Math.min(width, DONUT_SIZE)} height={DONUT_SIZE} title="Gráfico de rosca das oportunidades criadas por origem">
                      {/* O tooltip só guarda a fatia ativa (mouse/teclado); quem mostra é o centro e a tabela. */}
                      <Tooltip content={() => null} cursor={false} />
                      <Pie
                        data={slices}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={DONUT_SIZE / 2 - 2 - RING}
                        outerRadius={DONUT_SIZE / 2 - 2}
                        startAngle={90}
                        endAngle={-270}
                        stroke="var(--color-surface)"
                        strokeWidth={2}
                        animationDuration={500}
                      />
                      <DonutCenter total={total} onActive={setHoveredKey} />
                    </PieChart>
                  )}
                </ChartFrame>
              </figure>
            ) : (
              <p className="m-0 w-full rounded-md bg-app px-3 py-3 text-center text-small text-text-secondary">
                {total === 0
                  ? "Nenhuma oportunidade criada no período; a tabela mostra as ganhas por origem."
                  : `Todas as ${total.toLocaleString("pt-BR")} oportunidades criadas no período estão em uma única origem.`}
              </p>
            )}

            <div className="w-full min-w-0 overflow-x-auto">
              <table className="w-full border-collapse text-small">
                <thead>
                  <tr className="text-left text-label font-semibold tracking-[1px] text-text-tertiary uppercase">
                    <th scope="col" className="py-1.5 pr-2 font-semibold">Origem</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-semibold">Criadas</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-semibold">
                      <span aria-hidden>%</span>
                      <span className="sr-only">Parcela das criadas</span>
                    </th>
                    <th scope="col" className="py-1.5 pl-2 text-right font-semibold">Ganhas</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.rows.map((row) => {
                    const key = row.source ?? NO_SOURCE_FILTER;
                    const selected = isSelected(row.source);
                    const hovered = hoveredKey !== null && row.segmentKey === hoveredKey;
                    return (
                      <tr key={key} className={cn("border-t border-border-subtle transition-colors", hovered && "bg-surface-hover")}>
                        <th scope="row" className="py-1.5 pr-2 text-left font-semibold">
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              aria-hidden
                              className={cn(
                                "size-2.5 shrink-0 rounded-[3px]",
                                row.color ? SWATCH[row.color] : "border border-border-strong",
                              )}
                            />
                            <Link
                              href={sourceHrefs[key] ?? "/visao-geral"}
                              aria-current={selected ? "true" : undefined}
                              className={cn("min-w-0 break-words", selected ? "text-primary" : undefined)}
                            >
                              {row.label}
                            </Link>
                          </span>
                        </th>
                        <td className="px-2 py-1.5 text-right tabular">{row.created}</td>
                        <td className="px-2 py-1.5 text-right tabular text-text-tertiary">
                          {formatPercent(row.created, total) ?? "—"}
                        </td>
                        <td className="py-1.5 pl-2 text-right tabular">{row.won}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
        <p className="m-0 text-meta text-text-muted">
          {attribution.unattributedCreated > 0
            ? `${attribution.unattributedCreated} de ${total} criadas no período sem interação elegível ("Não atribuído").`
            : "Todas as oportunidades criadas no período têm interação elegível."}
        </p>
        {attribution.source ? (
          <Link href={clearSourceHref} className="text-meta text-primary">
            Limpar origem
          </Link>
        ) : null}
      </div>
    </section>
  );
}
