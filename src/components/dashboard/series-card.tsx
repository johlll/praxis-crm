"use client";

import { useState } from "react";
import { TrendingUp } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";

import { ChartDataTable } from "@/components/charts/chart-data-table";
import { ChartFrame } from "@/components/charts/chart-frame";
import { ChartTooltipCard, type ChartTooltipRow } from "@/components/charts/chart-tooltip";
import type { Dashboard } from "@/modules/dashboard/queries";
import { buildSeriesPoints, formatBRL, formatBRLShort, periodTexts, seriesIsEmpty, type SeriesPoint } from "@/modules/dashboard/presentation";
import { SegmentedControl } from "./funnel-card";
import { PanelIcon } from "./panel-icon";

type Serie = "ganho" | "previsto";

/** Altura mínima do gráfico, eixo incluído; ao lado de painéis mais altos ele ocupa o espaço que sobrar. */
const CHART_MIN_HEIGHT = 220;
const AXIS_TICK = { fill: "var(--color-text-muted)", fontSize: 10.5 };
/**
 * Entrada curta. O padrão do Recharts ("auto") já desliga a animação para
 * quem pede movimento reduzido no sistema, e no servidor.
 */
const ANIMATION_MS = 500;

const count = (n: number, one: string, many: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;

type Kind = "ganho-valor" | "ganho-quantidade" | "previsto";

function rowsFor(kind: Kind, point: SeriesPoint): ChartTooltipRow[] {
  if (kind === "ganho-quantidade") {
    return [{ key: "n", color: "var(--color-primary)", value: count(point.count, "oportunidade", "oportunidades"), label: point.count === 1 ? "ganha" : "ganhas" }];
  }
  const value = formatBRL(point.valueCents ?? 0);
  return kind === "previsto"
    ? [
        { key: "v", color: "var(--color-info)", value, label: "previsto" },
        { key: "n", value: count(point.count, "oportunidade", "oportunidades"), label: point.count === 1 ? "aberta" : "abertas" },
      ]
    : [
        { key: "v", color: "var(--color-primary)", value, label: "acordado no ganho" },
        { key: "n", value: count(point.count, "oportunidade", "oportunidades"), label: point.count === 1 ? "ganha" : "ganhas" },
      ];
}

type TooltipArgs = { active?: boolean | undefined; payload?: ReadonlyArray<{ payload?: unknown }> | undefined };

function SeriesTooltip({ active, payload, kind }: TooltipArgs & { kind: Kind }) {
  const point = payload?.[0]?.payload as (SeriesPoint & { y: number }) | undefined;
  if (!active || !point) return null;
  return <ChartTooltipCard title={point.range} rows={rowsFor(kind, point)} />;
}

function SeriesChart({ points, kind, title }: { points: SeriesPoint[]; kind: Kind; title: string }) {
  const money = kind !== "ganho-quantidade";
  const data = points.map((p) => ({ ...p, y: money ? (p.valueCents ?? 0) : p.count }));
  const yAxis = (
    <YAxis
      width={money ? 46 : 32}
      tickLine={false}
      axisLine={false}
      tick={AXIS_TICK}
      allowDecimals={false}
      tickFormatter={(v: number) => (money ? formatBRLShort(v) : v.toLocaleString("pt-BR"))}
    />
  );
  const xAxis = (
    <XAxis dataKey="tick" tickLine={false} axisLine={{ stroke: "var(--color-border)" }} tick={AXIS_TICK} tickMargin={8} minTickGap={6} />
  );
  const grid = <CartesianGrid vertical={false} stroke="var(--color-border-subtle)" />;
  const margin = { top: 14, right: 14, bottom: 0, left: 0 };

  return (
    <ChartFrame fill minHeight={CHART_MIN_HEIGHT}>
      {({ width, height }) =>
        kind === "previsto" ? (
          <BarChart width={width} height={height} data={data} margin={margin} title={title}>
            {grid}
            {xAxis}
            {yAxis}
            <Tooltip
              cursor={{ fill: "var(--color-surface-hover)" }}
              content={({ active, payload }) => <SeriesTooltip active={active} payload={payload} kind={kind} />}
            />
            <Bar dataKey="y" fill="var(--color-info)" maxBarSize={24} radius={[4, 4, 0, 0]} animationDuration={ANIMATION_MS} />
          </BarChart>
        ) : (
          <AreaChart width={width} height={height} data={data} margin={margin} title={title}>
            {grid}
            {xAxis}
            {yAxis}
            <Tooltip
              cursor={{ stroke: "var(--color-border-strong)", strokeWidth: 1 }}
              content={({ active, payload }) => <SeriesTooltip active={active} payload={payload} kind={kind} />}
            />
            <Area
              type="linear"
              dataKey="y"
              stroke="var(--color-primary)"
              strokeWidth={2}
              fill="var(--color-primary)"
              fillOpacity={0.1}
              // Marcador de 8 px preenchidos + anel de 2 px na cor da superfície (separa da linha).
              // fillOpacity explícito: sem ele o ponto herda os 10% da área e some.
              dot={{ r: 5, fill: "var(--color-primary)", fillOpacity: 1, stroke: "var(--color-surface)", strokeWidth: 2 }}
              activeDot={{ r: 6, fill: "var(--color-primary)", fillOpacity: 1, stroke: "var(--color-surface)", strokeWidth: 2 }}
              animationDuration={ANIMATION_MS}
            />
          </AreaChart>
        )
      }
    </ChartFrame>
  );
}

function SeriesTable({ points, kind }: { points: SeriesPoint[]; kind: Kind }) {
  const columns =
    kind === "ganho-quantidade"
      ? [
          { key: "faixa", label: "Faixa" },
          { key: "n", label: "Ganhas", numeric: true },
        ]
      : [
          { key: "faixa", label: "Faixa" },
          { key: "v", label: kind === "previsto" ? "Valor previsto" : "Valor acordado", numeric: true },
          { key: "n", label: kind === "previsto" ? "Abertas" : "Ganhas", numeric: true },
        ];
  return (
    <ChartDataTable
      caption={kind === "previsto" ? "Valor das oportunidades abertas por faixa de data prevista" : "Oportunidades ganhas por faixa de dias"}
      columns={columns}
      rows={points.map((p) => ({
        key: p.key,
        cells:
          kind === "ganho-quantidade"
            ? [p.range, p.count.toLocaleString("pt-BR")]
            : [p.range, formatBRL(p.valueCents ?? 0), p.count.toLocaleString("pt-BR")],
      }))}
    />
  );
}

/**
 * Ganhos do período por faixa de dias e — só para quem vê valores — a
 * previsão das abertas pela data prevista (posição atual). Atendimento e
 * visualizador veem a quantidade de ganhas, nunca valores ou previsões
 * (esses campos nem chegam no payload deles). Cada ponto é exatamente o
 * que o banco contou na faixa: nada é interpolado ou redistribuído.
 */
export function SeriesCard({ dashboard }: { dashboard: Dashboard }) {
  const [serie, setSerie] = useState<Serie>("ganho");
  const forecast = dashboard.series.forecast;
  const money = dashboard.series.won.some((b) => b.valueCents !== undefined);
  const days = dashboard.period.days;
  const unit = dashboard.series.bucketDays === 1 ? "por dia" : `a cada ${dashboard.series.bucketDays} dias`;

  const texts = periodTexts(dashboard.period);
  // Ganhos seguem as datas do período; a previsão é sempre a partir de HOJE, com a mesma quantidade de dias.
  const wonSpan = dashboard.period.custom ? texts.current : `Últimos ${days} dias`;
  const ahead = days === 1 ? "hoje" : `nos próximos ${days} dias`;

  const showForecast = serie === "previsto" && forecast;
  const kind: Kind = showForecast ? "previsto" : money ? "ganho-valor" : "ganho-quantidade";
  const points = buildSeriesPoints(showForecast ? forecast.buckets : dashboard.series.won);
  const empty = seriesIsEmpty(points);

  const caption = showForecast
    ? "Valor das oportunidades abertas com data prevista em cada faixa"
    : money
      ? "Valor acordado no ganho (não é valor recebido)"
      : "Quantidade de oportunidades ganhas em cada faixa";

  return (
    <section aria-labelledby="serie-titulo" className="flex h-full min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <PanelIcon icon={TrendingUp} />
          <div className="flex min-w-0 flex-col">
            <h2 id="serie-titulo" className="m-0 text-lead font-bold text-text">
              {money ? "Honorários e previsão" : "Oportunidades ganhas"}
            </h2>
            <p className="m-0 text-meta text-text-muted">
              {showForecast
                ? `${days === 1 ? "Hoje" : `Próximos ${days} dias`}, ${unit} · abertas pela data prevista (posição atual)`
                : `${wonSpan}, ${unit} · data do ganho`}
            </p>
          </div>
        </div>
        {forecast ? (
          <SegmentedControl
            label="Série exibida"
            value={serie}
            onChange={setSerie}
            options={[
              { value: "ganho", label: "Ganho" },
              { value: "previsto", label: "Previsto" },
            ]}
          />
        ) : null}
      </div>

      {empty ? (
        <p className="m-0 flex flex-1 items-center justify-center rounded-md bg-app px-3 py-10 text-center text-body text-text-secondary">
          {showForecast
            ? `Nenhuma oportunidade aberta com data prevista ${ahead}.`
            : `Nenhuma oportunidade ganha ${texts.inPeriod}.`}
        </p>
      ) : (
        <figure className="m-0 flex min-h-0 flex-1 flex-col gap-2">
          <SeriesChart
            points={points}
            kind={kind}
            title={showForecast ? "Gráfico de barras do valor previsto por faixa" : "Gráfico de área das oportunidades ganhas por faixa"}
          />
          <figcaption className="text-meta text-text-muted">{caption}</figcaption>
        </figure>
      )}

      {showForecast ? (
        <p className="m-0 text-meta text-text-muted">
          Fora do gráfico: {forecast.pastDue} com data prevista já vencida · {forecast.withoutDate} sem data prevista ·{" "}
          {forecast.withoutValue} sem valor informado.
        </p>
      ) : null}

      {empty ? null : <SeriesTable points={points} kind={kind} />}
    </section>
  );
}
