"use client";

import { TrendingUp } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";

import { monthName } from "@/lib/civil-date";
import { ChartDataTable } from "@/components/charts/chart-data-table";
import { ChartFrame } from "@/components/charts/chart-frame";
import { ChartTooltipCard } from "@/components/charts/chart-tooltip";
import { PanelIcon } from "@/components/dashboard/panel-icon";
import { formatAxisMoney, formatDayMonth, formatMoney, formatShortDate } from "@/modules/finance/format";
import type { FlowDay, MonthView } from "@/modules/finance/ledger";

/**
 * Um ponto por dia, com a soma do que entrou e saiu NAQUELE dia. A curva "monotone" liga os pontos sem passar
 * acima ou abaixo deles (não cria picos nem valores negativos). Recebimentos: linha cheia; despesas: tracejada —
 * a identidade não depende só da cor, e a tabela traz todos os valores.
 */
const IN_COLOR = "var(--color-chart3)";
const OUT_COLOR = "var(--color-chart1)";
const OUT_DASH = "6 3";
const AXIS_TICK = { fill: "var(--color-text-muted)", fontSize: 10.5 };

function LegendItem({ color, dashed, label }: { color: string; dashed?: boolean; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <svg width="22" height="10" aria-hidden className="shrink-0">
        <line x1="0" y1="5" x2="22" y2="5" stroke={color} strokeWidth="2.5" strokeDasharray={dashed ? "5 3" : undefined} />
      </svg>
      <span>{label}</span>
    </li>
  );
}

export function CashFlowChart({ view }: { view: MonthView }) {
  const month = monthName(view.month);
  const moved = view.flow.filter((d) => d.receivedCents > 0 || d.paidCents > 0);

  return (
    <section aria-labelledby="fluxo-titulo" className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <PanelIcon icon={TrendingUp} />
          <div className="flex min-w-0 flex-col">
            <h2 id="fluxo-titulo" className="m-0 text-lead font-bold text-text">
              Fluxo de caixa realizado
            </h2>
            <p className="m-0 text-meta text-text-muted">
              Movimentação diária · {month}
              {view.phase === "current" && view.realizedEnd ? ` até ${formatDayMonth(view.realizedEnd)}` : ""} · previstos não entram
            </p>
          </div>
        </div>
        <ul aria-label="Legenda" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-meta text-text-secondary">
          <LegendItem color={IN_COLOR} label="Recebimentos" />
          <LegendItem color={OUT_COLOR} label="Despesas" dashed />
        </ul>
      </div>

      {moved.length === 0 ? (
        <p className="m-0 flex min-h-[230px] flex-1 items-center justify-center rounded-md bg-app px-3 text-center text-body text-text-secondary">
          {view.phase === "future" ? "Mês futuro: ainda não há movimentação realizada." : `Nenhum recebimento ou pagamento em ${month}.`}
        </p>
      ) : (
        <>
          <figure className="m-0 flex flex-1 flex-col">
            <ChartFrame fill minHeight={250}>
              {({ width, height }) => (
                <AreaChart
                  width={width}
                  height={height}
                  data={view.flow}
                  margin={{ top: 10, right: 10, bottom: 0, left: 0 }}
                  title={`Gráfico diário de recebimentos e despesas de ${month}`}
                >
                  <CartesianGrid vertical={false} stroke="var(--color-border-subtle)" strokeDasharray="3 4" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatShortDate}
                    tickLine={false}
                    axisLine={{ stroke: "var(--color-border)" }}
                    tick={AXIS_TICK}
                    tickMargin={8}
                    minTickGap={14}
                  />
                  <YAxis width={68} tickLine={false} axisLine={false} tick={AXIS_TICK} tickFormatter={formatAxisMoney} />
                  <Tooltip
                    cursor={{ stroke: "var(--color-border-strong)", strokeDasharray: "4 3" }}
                    content={({ active, payload }) => {
                      const day = payload?.[0]?.payload as FlowDay | undefined;
                      if (!active || !day) return null;
                      return (
                        <ChartTooltipCard
                          title={formatShortDate(day.date)}
                          rows={[
                            { key: "in", color: IN_COLOR, value: formatMoney(day.receivedCents), label: "recebimentos" },
                            { key: "out", color: OUT_COLOR, value: formatMoney(day.paidCents), label: "despesas" },
                          ]}
                        />
                      );
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="receivedCents"
                    stroke={IN_COLOR}
                    strokeWidth={2}
                    fill={IN_COLOR}
                    fillOpacity={0.18}
                    dot={false}
                    activeDot={{ r: 5, fill: IN_COLOR, stroke: "var(--color-surface)", strokeWidth: 2 }}
                    animationDuration={500}
                  />
                  <Area
                    type="monotone"
                    dataKey="paidCents"
                    stroke={OUT_COLOR}
                    strokeWidth={2}
                    strokeDasharray={OUT_DASH}
                    fill={OUT_COLOR}
                    fillOpacity={0.14}
                    dot={false}
                    activeDot={{ r: 5, fill: OUT_COLOR, stroke: "var(--color-surface)", strokeWidth: 2 }}
                    animationDuration={500}
                  />
                </AreaChart>
              )}
            </ChartFrame>
          </figure>
          <ChartDataTable
            caption={`Recebimentos e despesas por dia em ${month}; dias sem linha não tiveram movimentação`}
            columns={[
              { key: "dia", label: "Dia" },
              { key: "in", label: "Recebimentos", numeric: true },
              { key: "out", label: "Despesas", numeric: true },
            ]}
            rows={[
              ...moved.map((d) => ({
                key: d.date,
                cells: [formatShortDate(d.date), formatMoney(d.receivedCents), formatMoney(d.paidCents)],
              })),
              { key: "total", cells: ["Total do mês", formatMoney(view.totals.receivedCents), formatMoney(view.totals.paidCents)] },
            ]}
          />
        </>
      )}
    </section>
  );
}
