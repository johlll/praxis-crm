"use client";

import { TrendingUp } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";

import { ChartDataTable } from "@/components/charts/chart-data-table";
import { ChartFrame } from "@/components/charts/chart-frame";
import { ChartTooltipCard } from "@/components/charts/chart-tooltip";
import { PanelIcon } from "@/components/dashboard/panel-icon";
import { formatCount, formatDayShort } from "@/modules/traffic/format";
import type { SeriesBucket } from "@/modules/traffic/report";

/**
 * Duas contagens no MESMO eixo. A identidade não depende só da cor: leads é linha cheia com pontos cheios;
 * contratos é linha tracejada com pontos vazados. A legenda repete o traço e a tabela traz todos os números.
 */
const LEADS_COLOR = "var(--color-chart4)";
const CONTRACTS_COLOR = "var(--color-neutral)";
const CONTRACTS_DASH = "6 4";
const AXIS_TICK = { fill: "var(--color-text-muted)", fontSize: 10.5 };

const bucketRange = (b: SeriesBucket) => (b.from === b.to ? formatDayShort(b.from) : `${formatDayShort(b.from)}–${formatDayShort(b.to)}`);
const bucketTitle = (b: SeriesBucket) => `${bucketRange(b)}${b.partial ? ` (faixa parcial: ${b.days} ${b.days === 1 ? "dia" : "dias"})` : ""}`;

function LegendItem({ color, dashed, label }: { color: string; dashed?: boolean; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <svg width="22" height="10" aria-hidden className="shrink-0">
        <line x1="0" y1="5" x2="22" y2="5" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "5 3" : undefined} />
        <circle cx="11" cy="5" r="3.5" fill={dashed ? "var(--color-surface)" : color} stroke={color} strokeWidth="1.5" />
      </svg>
      <span>{label}</span>
    </li>
  );
}

export function EvolutionCard({ series, bucketDays }: { series: SeriesBucket[]; bucketDays: number }) {
  const data = series.map((b) => ({ ...b, tick: formatDayShort(b.from) }));
  const unit = bucketDays === 1 ? "por dia" : `em faixas de ${bucketDays} dias`;

  return (
    <section aria-labelledby="evolucao-titulo" className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <PanelIcon icon={TrendingUp} />
          <div className="flex min-w-0 flex-col">
            <h2 id="evolucao-titulo" className="m-0 text-lead font-bold text-text">
              Evolução de resultados
            </h2>
            <p className="m-0 text-meta text-text-muted">Soma {unit}, dentro do período selecionado</p>
          </div>
        </div>
        <ul aria-label="Legenda" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-meta text-text-secondary">
          <LegendItem color={LEADS_COLOR} label="Leads qualificados" />
          <LegendItem color={CONTRACTS_COLOR} label="Contratos" dashed />
        </ul>
      </div>

      <figure className="m-0 flex flex-1 flex-col">
        <ChartFrame fill minHeight={230}>
          {({ width, height }) => (
            <AreaChart
              width={width}
              height={height}
              data={data}
              margin={{ top: 10, right: 12, bottom: 0, left: 0 }}
              title="Gráfico de leads qualificados e contratos por faixa de datas"
            >
              <CartesianGrid vertical={false} stroke="var(--color-border-subtle)" />
              <XAxis dataKey="tick" tickLine={false} axisLine={{ stroke: "var(--color-border)" }} tick={AXIS_TICK} tickMargin={8} minTickGap={10} />
              <YAxis width={30} tickLine={false} axisLine={false} tick={AXIS_TICK} allowDecimals={false} />
              <Tooltip
                cursor={{ stroke: "var(--color-border-strong)", strokeWidth: 1 }}
                content={({ active, payload }) => {
                  const point = payload?.[0]?.payload as SeriesBucket | undefined;
                  if (!active || !point) return null;
                  return (
                    <ChartTooltipCard
                      title={bucketTitle(point)}
                      rows={[
                        { key: "l", color: LEADS_COLOR, value: formatCount(point.qualifiedLeads), label: "leads qualificados" },
                        { key: "c", color: CONTRACTS_COLOR, value: formatCount(point.contracts), label: "contratos" },
                      ]}
                    />
                  );
                }}
              />
              <Area
                type="linear"
                dataKey="qualifiedLeads"
                stroke={LEADS_COLOR}
                strokeWidth={2}
                fill={LEADS_COLOR}
                fillOpacity={0.12}
                dot={{ r: 4.5, fill: LEADS_COLOR, fillOpacity: 1, stroke: "var(--color-surface)", strokeWidth: 2 }}
                activeDot={{ r: 6, fill: LEADS_COLOR, fillOpacity: 1, stroke: "var(--color-surface)", strokeWidth: 2 }}
                animationDuration={500}
              />
              <Area
                type="linear"
                dataKey="contracts"
                stroke={CONTRACTS_COLOR}
                strokeWidth={2}
                strokeDasharray={CONTRACTS_DASH}
                fill={CONTRACTS_COLOR}
                fillOpacity={0.05}
                dot={{ r: 4, fill: "var(--color-surface)", fillOpacity: 1, stroke: CONTRACTS_COLOR, strokeWidth: 1.75, strokeDasharray: "0" }}
                activeDot={{ r: 6, fill: CONTRACTS_COLOR, fillOpacity: 1, stroke: "var(--color-surface)", strokeWidth: 2 }}
                animationDuration={500}
              />
            </AreaChart>
          )}
        </ChartFrame>
      </figure>

      <ChartDataTable
        caption="Leads qualificados e contratos por faixa de datas"
        columns={[
          { key: "faixa", label: "Faixa" },
          { key: "l", label: "Leads qualificados", numeric: true },
          { key: "c", label: "Contratos", numeric: true },
        ]}
        rows={series.map((b) => ({ key: b.from, cells: [bucketTitle(b), formatCount(b.qualifiedLeads), formatCount(b.contracts)] }))}
      />
    </section>
  );
}
