import { ArrowDown, ArrowUp, Coins, FileSignature, MessageCircle, Users, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { PanelIcon } from "@/components/dashboard/panel-icon";
import { formatChange, formatCount, formatMoney } from "@/modules/traffic/format";
import type { Comparison, Metrics, TrafficReport } from "@/modules/traffic/report";

const CARDS: readonly {
  key: keyof Metrics;
  label: string;
  icon: LucideIcon;
  description: string;
  format: (n: number) => string;
  /** Mais gasto não é "melhor" nem "pior": a variação do investimento fica neutra. */
  neutral?: boolean;
}[] = [
  {
    key: "investmentCents",
    label: "Investimento",
    icon: Coins,
    description: "Gasto com anúncios no período",
    format: formatMoney,
    neutral: true,
  },
  {
    key: "conversations",
    label: "Conversas",
    icon: MessageCircle,
    description: "Informadas pela plataforma; não são as conversas do CRM",
    format: formatCount,
  },
  {
    key: "qualifiedLeads",
    label: "Leads qualificados",
    icon: Users,
    description: "Mesmo número usado no CPL",
    format: formatCount,
  },
  {
    key: "contracts",
    label: "Contratos",
    icon: FileSignature,
    description: "Métrica própria; não é deduzida de oportunidade ganha",
    format: formatCount,
  },
];

function ChangeLine({ comparison, neutral, format }: { comparison: Comparison; neutral: boolean; format: (n: number) => string }) {
  if (comparison.kind === "no_base") {
    return (
      <p className="m-0 text-meta text-text-muted">
        — sem base de comparação
        <span className="sr-only">
          {comparison.reason === "previous_zero" ? " (o período anterior foi zero)" : " (não há dados de todo o período anterior)"}
        </span>
      </p>
    );
  }
  const up = comparison.percent > 0;
  const down = comparison.percent < 0;
  const Icon = up ? ArrowUp : ArrowDown;
  const tone = neutral || (!up && !down) ? "bg-neutral-bg text-text-secondary" : up ? "bg-primary-tint text-primary" : "bg-danger-bg text-danger";
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta text-text-muted" title={`anterior: ${format(comparison.previous)}`}>
      <span className={cn("inline-flex items-center gap-0.5 rounded-pill px-1.5 py-px font-semibold tabular", tone)}>
        {up || down ? <Icon size={11} strokeWidth={2.2} aria-hidden /> : null}
        {formatChange(comparison)}
      </span>{" "}
      vs. período anterior
      <span className="sr-only"> (anterior: {format(comparison.previous)})</span>
    </p>
  );
}

export function TrafficKpis({ report }: { report: Pick<TrafficReport, "totals" | "comparison"> }) {
  return (
    <ul aria-label="Indicadores do período" className="m-0 grid list-none grid-cols-2 gap-3 p-0 @min-[740px]:grid-cols-4">
      {CARDS.map((card) => (
        <li key={card.key} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface px-3.5 py-3.5">
          <p className="m-0 flex items-center gap-2.5 text-small leading-tight font-semibold text-text-secondary">
            <PanelIcon icon={card.icon} />
            {card.label}
          </p>
          <p
            data-testid={`traffic-kpi-${card.key}`}
            className="tabular m-0 mt-1 text-[19px] leading-tight font-bold tracking-[-0.4px] break-words text-text @min-[480px]:text-[24px] @min-[740px]:text-[19px] @min-[940px]:text-[24px]"
          >
            {card.format(report.totals[card.key])}
          </p>
          <ChangeLine comparison={report.comparison[card.key]} neutral={card.neutral === true} format={card.format} />
          <p className="m-0 text-meta leading-snug text-text-muted">{card.description}</p>
        </li>
      ))}
    </ul>
  );
}
