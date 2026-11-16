import type { ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CalendarCheck,
  Coins,
  FileText,
  Trophy,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";
import type { Dashboard, PeriodValue } from "@/modules/dashboard/queries";
import { computeDelta, formatBRL, formatDays, formatDelta, formatPercent } from "@/modules/dashboard/presentation";
import { PanelIcon } from "./panel-icon";

/**
 * Comparação com o período anterior, só onde o contrato da RPC a fornece.
 * Base anterior zero não vira percentual: "— sem base no período anterior".
 */
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
    <p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta text-text-muted" title={previousText}>
      <span
        className={cn(
          "inline-flex items-center gap-0.5 rounded-pill px-1.5 py-px font-semibold tabular",
          up ? "bg-primary-tint text-primary" : down ? "bg-danger-bg text-danger" : "bg-neutral-bg text-text-secondary",
        )}
      >
        {up || down ? <Icon size={11} strokeWidth={2.2} aria-hidden /> : null}
        {formatDelta(delta)}
      </span>{" "}
      vs período anterior
      <span className="sr-only"> ({previousText})</span>
    </p>
  );
}

/**
 * Cartão de indicador do período. Estrutura conferida pelos testes: o
 * rótulo e o valor são os dois primeiros <p> do cartão, e "período
 * anterior" só aparece aqui dentro.
 */
function KpiCard({
  icon,
  label,
  hint,
  description,
  value,
  format,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  description: string;
  value: PeriodValue<number>;
  format: (n: number) => string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface px-4 py-3.5" title={hint}>
      <p className="m-0 flex items-center gap-2.5 text-small leading-tight font-semibold text-text-secondary">
        <PanelIcon icon={icon} />
        {label}
      </p>
      <p className="m-0 mt-1 text-[22px] leading-tight font-bold tracking-[-0.4px] break-words text-text md:text-[25px]">
        {format(value.current)}
      </p>
      <DeltaLine value={value} format={format} />
      <p className="m-0 text-meta leading-snug text-text-muted">{description}</p>
    </div>
  );
}

const count = (n: number) => n.toLocaleString("pt-BR");

/** Indicadores do PERÍODO, cada um pela sua própria data, com comparação. */
export function PeriodKpis({ dashboard }: { dashboard: Dashboard }) {
  const m = dashboard.metrics;
  return (
    // Só base, md e lg: neste projeto md/lg são em px e o sm padrão em rem, e o
    // Tailwind emitiria o sm DEPOIS do lg (ele venceria nas telas largas).
    <div className={cn("grid grid-cols-2 gap-3", m.wonValueCents ? "md:grid-cols-3 lg:grid-cols-5" : "md:grid-cols-4")}>
      <KpiCard
        icon={UserPlus}
        label="Leads recebidos"
        hint="Leads criados no período (data de entrada do lead)."
        description="Pela data de entrada do lead"
        value={m.leadsReceived}
        format={count}
      />
      <KpiCard
        icon={CalendarCheck}
        label="Consultas realizadas"
        hint="Reuniões concluídas no período (data de conclusão da reunião)."
        description="Reuniões concluídas, pela data de conclusão"
        value={m.consultationsDone}
        format={count}
      />
      <KpiCard
        icon={FileText}
        label="Propostas enviadas"
        hint="Propostas com envio registrado no sistema no período (data do envio)."
        description="Com envio registrado, pela data do envio"
        value={m.proposalsSent}
        format={count}
      />
      <KpiCard
        icon={Trophy}
        label="Oportunidades ganhas"
        hint="Oportunidades marcadas como ganhas no período (data do ganho), inclusive de leads antigos."
        description="Pela data do ganho, inclusive de leads antigos"
        value={m.opportunitiesWon}
        format={count}
      />
      {m.wonValueCents ? (
        <KpiCard
          icon={Coins}
          label="Honorários das ganhas"
          hint="Soma do valor acordado registrado no ganho das oportunidades ganhas no período. Não é valor recebido."
          description="Valor acordado no ganho; não é valor recebido"
          value={m.wonValueCents}
          format={formatBRL}
        />
      ) : null}
    </div>
  );
}

function StripCell({ label, value, caption, tag }: { label: string; value: string; caption?: ReactNode; tag: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-4 py-3">
      <p className="m-0 flex items-center gap-1.5 text-meta text-text-tertiary">
        {label}
        <span className="rounded-pill bg-neutral-bg px-1.5 text-[9.5px] font-semibold tracking-[0.4px] text-text-tertiary uppercase">
          {tag}
        </span>
      </p>
      <p className="m-0 text-[17px] leading-tight font-bold text-text">{value}</p>
      {caption ? <p className="m-0 text-meta text-text-muted">{caption}</p> : null}
    </div>
  );
}

/**
 * Faixa complementar, logo abaixo dos principais: dois indicadores do
 * período (sem comparação percentual, com a base explícita) e as posições
 * atuais, que o banco não permite reconstruir no passado — por isso nunca
 * têm "vs anterior".
 */
export function SecondaryStrip({ dashboard }: { dashboard: Dashboard }) {
  const { cohort, metrics, positions } = dashboard;
  const conversion = formatPercent(cohort.leadsWithWon, cohort.leads);

  return (
    <div className="grid divide-y divide-border-subtle rounded-lg border border-border bg-surface md:grid-cols-2 md:divide-y-0 lg:grid-cols-4 lg:divide-x">
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
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-warning/15 text-warning">
        <AlertTriangle size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-body font-bold text-text">{headline}</p>
        <p className="m-0 text-meta text-text-secondary">
          {p.stalledOpportunities} parada{p.stalledOpportunities === 1 ? "" : "s"} há mais de {dashboard.stalledDays} dias ·{" "}
          {p.unassignedOpenOpportunities} sem responsável · {p.opportunitiesWithOverdue} com atividade atrasada
        </p>
      </div>
      <Link
        href="#atencao"
        className="shrink-0 rounded-md bg-warning px-3 py-1.5 text-small font-bold text-on-solid hover:text-on-solid hover:no-underline"
      >
        Revisar
      </Link>
    </div>
  );
}
