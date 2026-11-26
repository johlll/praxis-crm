import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpFromLine, Scale, Wallet, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { PanelIcon } from "@/components/dashboard/panel-icon";
import { comparisonTarget, formatDayMonth, formatMoney, formatPercentChange, NO_BASE_REASON } from "@/modules/finance/format";
import type { Comparison, MonthView } from "@/modules/finance/ledger";

/** Como ler a variação: melhor para cima (receita, resultado) ou sem juízo (despesa, a receber). */
type Tone = "higher_is_better" | "expense" | "neutral";

function ChangeLine({ comparison, target, tone }: { comparison: Comparison; target: string; tone: Tone }) {
  if (comparison.kind === "no_base") {
    return (
      <p className="m-0 text-meta text-text-muted">
        — sem base de comparação ({NO_BASE_REASON[comparison.reason]}
        {comparison.reason === "negative" ? `: ${formatMoney(comparison.previousCents)}` : ""})
      </p>
    );
  }
  const up = comparison.percent > 0;
  const down = comparison.percent < 0;
  const Icon = up ? ArrowUp : ArrowDown;
  const color =
    !up && !down
      ? "bg-neutral-bg text-text-secondary"
      : tone === "expense"
        ? "bg-info-bg text-info"
        : tone === "neutral"
          ? "bg-neutral-bg text-text-secondary"
          : up
            ? "bg-primary-tint text-primary"
            : "bg-danger-bg text-danger";
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta text-text-muted">
      <span className={cn("tabular inline-flex items-center gap-0.5 rounded-pill px-1.5 py-px font-semibold", color)}>
        {up || down ? <Icon size={11} strokeWidth={2.2} aria-hidden /> : null}
        {formatPercentChange(comparison.percent)}
      </span>{" "}
      <span>
        vs. {target} ({formatMoney(comparison.previousCents)})
      </span>
    </p>
  );
}

type Card = {
  key: string;
  label: string;
  icon: LucideIcon;
  cents: number;
  comparison: Comparison;
  target: string;
  tone: Tone;
  description: string;
};

export function FinanceCards({ view }: { view: MonthView }) {
  const target = comparisonTarget(view);
  const reference = formatDayMonth(view.reference);
  const realized = view.phase === "future" ? "Mês futuro: nada realizado ainda" : null;
  const cards: Card[] = [
    {
      key: "received",
      label: "Recebido",
      icon: ArrowDownToLine,
      cents: view.totals.receivedCents,
      comparison: view.comparison.received,
      target,
      tone: "higher_is_better",
      description: realized ?? "Pela data do recebimento",
    },
    {
      key: "paid",
      label: "Despesas pagas",
      icon: ArrowUpFromLine,
      cents: view.totals.paidCents,
      comparison: view.comparison.paid,
      target,
      tone: "expense",
      description: realized ?? "Pela data do pagamento",
    },
    {
      key: "result",
      label: "Resultado do mês",
      icon: Scale,
      cents: view.totals.resultCents,
      comparison: view.comparison.result,
      target,
      tone: "higher_is_better",
      description: realized ?? "Recebido menos despesas pagas",
    },
    {
      key: "receivable",
      label: "A receber",
      icon: Wallet,
      cents: view.receivable.totalCents,
      comparison: view.comparison.receivable,
      target: view.comparisonWindow ? `posição em ${formatDayMonth(view.comparisonWindow.to)}` : "",
      tone: "neutral",
      description: `Posição em ${reference}: lançado e ainda não recebido`,
    },
  ];

  return (
    <ul aria-label="Resumo do mês" className="m-0 grid list-none grid-cols-1 gap-3 p-0 @min-[420px]:grid-cols-2 @min-[880px]:grid-cols-4">
      {cards.map((card) => (
        <li key={card.key} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface px-4 py-3.5">
          <p className="m-0 flex items-center gap-2.5 text-small leading-tight font-semibold text-text-secondary">
            <PanelIcon icon={card.icon} />
            {card.label}
          </p>
          <p
            data-testid={`finance-card-${card.key}`}
            className={cn(
              "tabular m-0 mt-1 text-[22px] leading-tight font-bold tracking-[-0.4px] break-words @min-[1060px]:text-[25px]",
              card.cents < 0 ? "text-danger" : "text-text",
            )}
          >
            {formatMoney(card.cents)}
          </p>
          <ChangeLine comparison={card.comparison} target={card.target} tone={card.tone} />
          <p className="m-0 text-meta leading-snug text-text-muted">{card.description}</p>
        </li>
      ))}
    </ul>
  );
}
