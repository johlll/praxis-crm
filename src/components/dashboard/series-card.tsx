"use client";

import { useState } from "react";

import type { Dashboard, SeriesBucket } from "@/modules/dashboard/queries";
import { bucketLabel, formatBRL, formatBRLShort } from "@/modules/dashboard/presentation";
import { SegmentedControl } from "./funnel-card";

type Serie = "ganho" | "previsto";

function Bars({ buckets, money, caption }: { buckets: SeriesBucket[]; money: boolean; caption: string }) {
  const values = buckets.map((b) => (money ? (b.valueCents ?? 0) : b.count));
  const max = Math.max(0, ...values);

  return (
    <figure className="m-0 flex flex-col gap-2">
      <div className="flex h-[150px] items-end gap-3" role="list" aria-label={caption}>
        {buckets.map((bucket, index) => {
          const value = values[index]!;
          const height = max === 0 ? 0 : Math.max(value > 0 ? 6 : 0, Math.round((value / max) * 110));
          const label = bucketLabel(bucket.startDate, bucket.lastDate);
          const full = money
            ? `${label}: ${formatBRL(value)} em ${bucket.count} oportunidade${bucket.count === 1 ? "" : "s"}`
            : `${label}: ${bucket.count} oportunidade${bucket.count === 1 ? "" : "s"}`;
          return (
            <div key={bucket.startDate} role="listitem" aria-label={full} title={full} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <span className="tabular text-meta font-semibold text-text-secondary" aria-hidden>
                {money ? formatBRLShort(value) : value}
              </span>
              <div className="w-full max-w-[28px] rounded-t-[4px] bg-primary" style={{ height }} aria-hidden />
              <span className="truncate text-[10.5px] text-text-tertiary" aria-hidden>
                {label}
              </span>
            </div>
          );
        })}
      </div>
      <figcaption className="text-meta text-text-muted">{caption}</figcaption>
    </figure>
  );
}

/**
 * Ganhos do período por faixa de dias e — só para quem vê valores — a
 * previsão das abertas pela data prevista (posição atual). Atendimento e
 * visualizador veem a quantidade de ganhas, nunca valores ou previsões
 * (esses campos nem chegam no payload deles).
 */
export function SeriesCard({ dashboard }: { dashboard: Dashboard }) {
  const [serie, setSerie] = useState<Serie>("ganho");
  const forecast = dashboard.series.forecast;
  const money = dashboard.series.won.some((b) => b.valueCents !== undefined);
  const days = dashboard.period.days;
  const unit = dashboard.series.bucketDays === 1 ? "por dia" : `a cada ${dashboard.series.bucketDays} dias`;

  return (
    <section aria-labelledby="serie-titulo" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <h2 id="serie-titulo" className="m-0 text-body font-bold text-text">
            {money ? "Honorários e previsão" : "Oportunidades ganhas"}
          </h2>
          <p className="m-0 text-meta text-text-muted">
            {serie === "ganho"
              ? `Últimos ${days} dias, ${unit} · data do ganho`
              : `Próximos ${days} dias, ${unit} · abertas pela data prevista (posição atual)`}
          </p>
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

      {serie === "previsto" && forecast ? (
        <>
          <Bars buckets={forecast.buckets} money caption="Valor das oportunidades abertas com data prevista em cada faixa" />
          <p className="m-0 text-meta text-text-muted">
            Fora do gráfico: {forecast.pastDue} com data prevista já vencida · {forecast.withoutDate} sem data prevista ·{" "}
            {forecast.withoutValue} sem valor informado.
          </p>
        </>
      ) : (
        <Bars
          buckets={dashboard.series.won}
          money={money}
          caption={
            money
              ? "Valor acordado no ganho (não é valor recebido)"
              : "Quantidade de oportunidades ganhas em cada faixa"
          }
        />
      )}
    </section>
  );
}
