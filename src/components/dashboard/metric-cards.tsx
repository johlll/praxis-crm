import { ArrowUp, ArrowDown, AlertTriangle } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/cn";
import type { Dashboard, PeriodValue } from "@/modules/dashboard/queries";
import { computeDelta, formatBRL, formatDays, formatDelta, formatPercent } from "@/modules/dashboard/presentation";

function DeltaLine({ value, format }: { value: PeriodValue<number>; format: (n: number) => string }) {
  const delta = computeDelta(value.current, value.previous);
  const previousText = `anterior: ${format(value.previous)}`;

  if (delta.kind === "none") {
    return (
      <p className="m-0 text-meta text-text-muted" title="O período anterior não tem base para comparar (zero).">
        — sem base no período anterior
      </p>
    );
  }

  const up = delta.percent > 0;
  const down = delta.percent < 0;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <p
      className={cn("m-0 flex items-center gap-1 text-meta", up ? "text-primary" : down ? "text-danger" : "text-text-muted")}
      title={previousText}
    >
      {up || down ? <Icon size={11} strokeWidth={2.2} aria-hidden /> : null}
      <span>
        {formatDelta(delta)} vs período anterior
        <span className="sr-only"> ({previousText})</span>
      </span>
    </p>
  );
}

function KpiCard({
  label,
  hint,
  value,
  format,
}: {
  label: string;
  hint: string;
  value: PeriodValue<number>;
  format: (n: number) => string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface px-3.5 py-3" title={hint}>
      <p className="m-0 truncate text-label font-semibold tracking-[1.3px] text-text-tertiary uppercase">{label}</p>
      <p className="m-0 tabular text-[22px] leading-tight font-bold text-text">{format(value.current)}</p>
      <DeltaLine value={value} format={format} />
    </div>
  );
}

const count = (n: number) => n.toLocaleString("pt-BR");

/** Indicadores do PERÍODO, cada um pela sua própria data, com comparação. */
export function PeriodKpis({ dashboard }: { dashboard: Dashboard }) {
  const m = dashboard.metrics;
  return (
    <div
      className={cn(
        "grid gap-3 sm:grid-cols-2",
        m.wonValueCents ? "lg:grid-cols-5" : "lg:grid-cols-4",
      )}
    >
      <KpiCard label="Leads recebidos" hint="Leads criados no período (data de entrada do lead)." value={m.leadsReceived} format={count} />
      <KpiCard
        label="Consultas realizadas"
        hint="Reuniões concluídas no período (data de conclusão da reunião)."
        value={m.consultationsDone}
        format={count}
      />
      <KpiCard
        label="Propostas enviadas"
        hint="Propostas com envio registrado no sistema no período (data do envio)."
        value={m.proposalsSent}
        format={count}
      />
      <KpiCard
        label="Oportunidades ganhas"
        hint="Oportunidades marcadas como ganhas no período (data do ganho), inclusive de leads antigos."
        value={m.opportunitiesWon}
        format={count}
      />
      {m.wonValueCents ? (
        <KpiCard
          label="Honorários das ganhas"
          hint="Soma do valor acordado registrado no ganho das oportunidades ganhas no período. Não é valor recebido."
          value={m.wonValueCents}
          format={formatBRL}
        />
      ) : null}
    </div>
  );
}

function StripCell({ label, value, caption, tag }: { label: string; value: string; caption?: string; tag: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3.5 py-3">
      <p className="m-0 flex items-center gap-1.5 text-meta text-text-tertiary">
        {label}
        <span className="rounded-pill bg-neutral-bg px-1.5 text-[9.5px] font-semibold tracking-[0.4px] text-text-tertiary uppercase">
          {tag}
        </span>
      </p>
      <p className="m-0 tabular text-[15px] font-bold text-text">{value}</p>
      {caption ? <p className="m-0 text-meta text-text-muted">{caption}</p> : null}
    </div>
  );
}

/**
 * Faixa secundária: dois indicadores do período (sem comparação
 * percentual, com a base explícita) e as posições atuais, que o banco não
 * permite reconstruir no passado — por isso nunca têm "vs anterior".
 */
export function SecondaryStrip({ dashboard }: { dashboard: Dashboard }) {
  const { cohort, metrics, positions } = dashboard;
  const conversion = formatPercent(cohort.leadsWithWon, cohort.leads);

  return (
    <div className="grid divide-y divide-border-subtle rounded-lg border border-border bg-surface sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
      <StripCell
        tag="Período"
        label="Conversão dos leads recebidos"
        value={conversion ?? "—"}
        caption={
          cohort.leads === 0
            ? "Nenhum lead recebido no período"
            : `${cohort.leadsWithWon} de ${cohort.leads} leads do período já têm oportunidade ganha`
        }
      />
      <StripCell
        tag="Período"
        label="Tempo até o ganho"
        value={formatDays(metrics.daysToWin.current)}
        caption={`Média da entrada do lead ao ganho · anterior: ${formatDays(metrics.daysToWin.previous)}`}
      />
      <StripCell tag="Agora" label="Oportunidades abertas" value={positions.openOpportunities.toLocaleString("pt-BR")} />
      {positions.openValueCents !== undefined ? (
        <StripCell
          tag="Agora"
          label="Valor em negociação"
          value={formatBRL(positions.openValueCents)}
          {...(positions.openWithoutValue
            ? { caption: `${positions.openWithoutValue} aberta${positions.openWithoutValue === 1 ? "" : "s"} sem valor informado` }
            : {})}
        />
      ) : (
        <StripCell tag="Agora" label="Atividades atrasadas" value={positions.overdueActivities.toLocaleString("pt-BR")} />
      )}
    </div>
  );
}

export function AttentionBanner({ dashboard }: { dashboard: Dashboard }) {
  const p = dashboard.positions;
  if (p.attentionOpportunities === 0) {
    return (
      <div className="flex items-center rounded-lg border border-border bg-surface px-4 py-3 text-body text-text-secondary">
        Nenhuma oportunidade aberta exige atenção agora.
      </div>
    );
  }

  const n = p.attentionOpportunities;
  const headline =
    p.attentionValueCents !== undefined
      ? `${formatBRL(p.attentionValueCents)} em ${n} oportunidade${n === 1 ? "" : "s"} que precisa${n === 1 ? "" : "m"} de atenção`
      : `${n} oportunidade${n === 1 ? "" : "s"} precisa${n === 1 ? "" : "m"} de atenção`;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning-bg px-4 py-3">
      <AlertTriangle size={16} className="shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="m-0 text-body font-bold text-text">{headline}</p>
        <p className="m-0 text-meta text-text-secondary">
          {p.stalledOpportunities} parada{p.stalledOpportunities === 1 ? "" : "s"} há mais de {dashboard.stalledDays} dias ·{" "}
          {p.unassignedOpenOpportunities} sem responsável · {p.opportunitiesWithOverdue} com atividade atrasada
        </p>
      </div>
      <Link
        href="#atencao"
        className="shrink-0 rounded-md bg-warning px-3 py-1.5 text-small font-bold text-white hover:text-white hover:no-underline"
      >
        Revisar
      </Link>
    </div>
  );
}
