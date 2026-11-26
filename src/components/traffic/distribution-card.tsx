import { PieChart } from "lucide-react";

import { PanelIcon } from "@/components/dashboard/panel-icon";
import { formatMoney } from "@/modules/traffic/format";
import type { PlatformShare } from "@/modules/traffic/report";
import type { Platform } from "@/modules/traffic/schema";
import { PLATFORM_COLOR, PlatformMark } from "./platform-mark";

const NAME: Record<Platform, string> = { meta: "Meta Ads", google: "Google Ads" };

/** Participação de cada plataforma no investimento FILTRADO. A barra é decorativa: os números estão na lista. */
export function DistributionCard({ distribution, totalCents }: { distribution: PlatformShare[]; totalCents: number }) {
  const segments = distribution.filter((s) => s.selected && s.investmentCents > 0);

  return (
    <section aria-labelledby="verba-titulo" className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start gap-2.5">
        <PanelIcon icon={PieChart} />
        <div className="flex min-w-0 flex-col">
          <h2 id="verba-titulo" className="m-0 text-lead font-bold text-text">
            Distribuição da verba
          </h2>
          <p className="m-0 text-meta text-text-muted">Participação no investimento filtrado</p>
        </div>
      </div>

      {segments.length === 0 ? (
        <p className="m-0 rounded-md bg-app px-3 py-3 text-center text-small text-text-secondary">
          Sem investimento no período: não há participação para mostrar.
        </p>
      ) : (
        <div aria-hidden className="flex h-9 gap-0.5 overflow-hidden rounded-md">
          {segments.map((s) => (
            <div
              key={s.platform}
              className="flex min-w-1 items-center justify-center text-small font-bold text-on-solid"
              style={{ flex: `${s.investmentCents} 0 0%`, background: PLATFORM_COLOR[s.platform] }}
            >
              {(s.percent ?? 0) >= 12 ? `${s.percent}%` : null}
            </div>
          ))}
        </div>
      )}

      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {distribution.map((s) => (
          <li key={s.platform} data-testid={`traffic-share-${s.platform}`} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-small">
            <PlatformMark platform={s.platform} />
            <span className="min-w-0 flex-1 text-text-secondary">{NAME[s.platform]}</span>
            {s.selected ? (
              <>
                <span className="tabular font-semibold text-text">{formatMoney(s.investmentCents)}</span>
                <span className="tabular w-10 text-right text-text-muted">{s.percent === null ? "—" : `${s.percent}%`}</span>
              </>
            ) : (
              <span className="text-text-muted">fora do filtro</span>
            )}
          </li>
        ))}
      </ul>

      <p className="m-0 mt-auto flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-3">
        <span className="text-body text-text-secondary">Total investido</span>
        <span data-testid="traffic-share-total" className="tabular text-lead font-bold text-text">
          {formatMoney(totalCents)}
        </span>
      </p>
    </section>
  );
}
