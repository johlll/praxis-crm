import { CalendarX, FlaskConical } from "lucide-react";

import { formatDay, formatRange } from "@/modules/traffic/format";
import { buildTrafficReport, type TrafficDataset } from "@/modules/traffic/report";
import { resolvePeriod, type TrafficFilters } from "@/modules/traffic/schema";
import { CampaignsTable } from "./campaigns-table";
import { ConnectAccountsButton, NoConnectionState } from "./connection";
import { DistributionCard } from "./distribution-card";
import { EvolutionCard } from "./evolution-card";
import { TrafficKpis } from "./kpi-cards";
import { TrafficFiltersShell } from "./traffic-filters";

/**
 * Corpo da página. `dataset` só existe na demonstração: sem ele, o escritório não tem conta conectada e a tela
 * não mostra filtro nem número. Os outros estados ficam separados: período recusado, sem resultados e (nas
 * rotas) carregando e falha.
 */
export function TrafficView({ dataset, filters, today }: { dataset: TrafficDataset | null; filters: TrafficFilters; today: string }) {
  if (!dataset) return <NoConnectionState />;

  const period = resolvePeriod(filters, today);

  return (
    <>
      <div
        role="note"
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-purple/30 bg-purple-bg px-3 py-2 text-small text-purple"
      >
        <p className="m-0 flex min-w-0 flex-[1_1_240px] items-start gap-2">
          <FlaskConical size={14} aria-hidden className="mt-0.5 shrink-0" />
          <span>
            <strong>Dados demonstrativos.</strong> Campanhas e números fictícios; nenhuma conta do Meta ou do Google está conectada.
          </span>
        </p>
        <ConnectAccountsButton />
      </div>

      <TrafficFiltersShell
        filters={filters}
        today={today}
        range={period.ok ? { from: period.current.from, to: period.current.to } : null}
        error={period.ok ? null : period.error}
      >
        {period.ok ? (
          <Results dataset={dataset} filters={filters} period={period} />
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface px-5 py-10 text-center">
            <CalendarX size={22} aria-hidden className="text-text-muted" />
            <p className="m-0 text-lead font-bold text-text">Período inválido</p>
            <p className="m-0 text-body text-text-secondary">Corrija as datas acima. Nenhum número é mostrado até lá.</p>
          </div>
        )}
      </TrafficFiltersShell>
    </>
  );
}

function Results({
  dataset,
  filters,
  period,
}: {
  dataset: TrafficDataset;
  filters: TrafficFilters;
  period: Extract<ReturnType<typeof resolvePeriod>, { ok: true }>;
}) {
  const { current, previous } = period;
  const report = buildTrafficReport(dataset, filters.platforms, current, previous);
  const days = `${current.days} ${current.days === 1 ? "dia" : "dias"}`;

  return (
    <>
      <div className="flex flex-col gap-1 text-meta text-text-tertiary">
        <p data-testid="traffic-period" className="m-0">
          <strong className="font-semibold text-text-secondary">{formatRange(current.from, current.to)}</strong> ({days}) · comparado com{" "}
          {formatRange(previous.from, previous.to)}
        </p>
        {report.coverageNotice ? (
          <p className="m-0 text-warning">
            Os dados de demonstração começam em {formatDay(report.coverageNotice.dataStartsAt)}. Antes disso não há dado, o que não é o
            mesmo que zero.
          </p>
        ) : null}
      </div>

      {report.rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface px-5 py-10 text-center">
          <CalendarX size={22} aria-hidden className="text-text-muted" />
          <h2 className="m-0 text-lead font-bold text-text">Sem resultados no período</h2>
          <p className="m-0 max-w-[480px] text-body text-text-secondary">
            Nenhuma campanha tem dados nas datas e plataformas selecionadas. Escolha outro período ou outra plataforma.
          </p>
        </div>
      ) : (
        <>
          <TrafficKpis report={report} />
          <div className="grid grid-cols-1 gap-4 @min-[900px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <EvolutionCard series={report.series} bucketDays={report.bucketDays} />
            <DistributionCard distribution={report.distribution} totalCents={report.totals.investmentCents} />
          </div>
          <CampaignsTable rows={report.rows} totals={report.totals} period={current} platforms={filters.platforms} />
        </>
      )}
    </>
  );
}
