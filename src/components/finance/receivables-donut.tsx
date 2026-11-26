import { Coins } from "lucide-react";

import { PanelIcon } from "@/components/dashboard/panel-icon";
import { formatDayMonth, formatMoney } from "@/modules/finance/format";
import type { MonthView } from "@/modules/finance/ledger";
import { wholePercents } from "@/modules/traffic/report";

const SIZE = 200;
const RADIUS = 78;
const STROKE = 28;

/** Rosca dos honorários em aberto na data de referência. O desenho é decorativo: os números estão na lista. */
export function ReceivablesDonut({ view }: { view: MonthView }) {
  const { totalCents, upcomingCents, overdueCents } = view.receivable;
  const parts = [
    { key: "upcoming", label: "A vencer", cents: upcomingCents, color: "var(--color-chart1)" },
    { key: "overdue", label: "Em atraso", cents: overdueCents, color: "var(--color-chart4)" },
  ];
  const percents = wholePercents(parts.map((p) => p.cents));
  // Geometria pela fração exata (os rótulos é que são arredondados para somar 100).
  const lengths = parts.map((p) => (totalCents > 0 ? (p.cents * 100) / totalCents : 0));

  return (
    <section aria-labelledby="honorarios-titulo" className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start gap-2.5">
        <PanelIcon icon={Coins} />
        <div className="flex min-w-0 flex-col">
          <h2 id="honorarios-titulo" className="m-0 text-lead font-bold text-text">
            Honorários a receber
          </h2>
          <p className="m-0 text-meta text-text-muted">Posição em {formatDayMonth(view.reference)}</p>
        </div>
      </div>

      <div className="relative mx-auto w-full max-w-[216px]">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden className="block w-full">
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="var(--color-border-subtle)" strokeWidth={STROKE} />
          {parts.map((part, i) => {
            const before = lengths.slice(0, i).reduce((s, v) => s + v, 0);
            if (lengths[i] === 0) return null;
            const angle = ((before + lengths[i]! / 2) / 100) * 2 * Math.PI - Math.PI / 2;
            return (
              <g key={part.key}>
                <circle
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={RADIUS}
                  fill="none"
                  stroke={part.color}
                  strokeWidth={STROKE}
                  pathLength={100}
                  strokeDasharray={`${lengths[i]} ${100 - lengths[i]!}`}
                  strokeDashoffset={-before}
                  transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
                />
                {(percents[i] ?? 0) >= 9 ? (
                  <text
                    x={SIZE / 2 + RADIUS * Math.cos(angle)}
                    y={SIZE / 2 + RADIUS * Math.sin(angle)}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="fill-[var(--color-on-solid)] text-[11px] font-bold"
                  >
                    {percents[i]}%
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        <p className="absolute inset-0 m-0 flex flex-col items-center justify-center px-10 text-center">
          <span data-testid="finance-donut-total" className="tabular text-[19px] leading-tight font-bold break-words text-text">
            {formatMoney(totalCents)}
          </span>
          <span className="text-meta text-text-muted">em aberto</span>
        </p>
      </div>

      {totalCents === 0 ? (
        <p className="m-0 text-center text-small text-text-secondary">Nenhum honorário em aberto nesta data.</p>
      ) : null}

      <ul className="m-0 mt-auto flex list-none flex-col p-0">
        {parts.map((part, i) => (
          <li key={part.key} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border-subtle py-2.5 text-small">
            <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: part.color }} />
            <span className="flex-1 text-text-secondary">{part.label}</span>
            <span data-testid={`finance-donut-${part.key}`} className="tabular font-bold text-text">
              {formatMoney(part.cents)}
            </span>
            <span className="tabular w-10 text-right text-text-muted">{percents[i] === null ? "—" : `${percents[i]}%`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
