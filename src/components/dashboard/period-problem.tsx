import Link from "next/link";
import { CalendarX2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { dashboardHref, type DashboardFilters } from "@/modules/dashboard/schema";
import { PeriodPicker } from "./period-picker";

export const UNAVAILABLE_PERIOD_MESSAGE =
  "O período personalizado ainda não está disponível neste ambiente: a atualização do banco de que ele depende não foi aplicada aqui. Os atalhos de 7, 30 e 90 dias funcionam normalmente.";
export const REJECTED_PERIOD_MESSAGE = "O banco não aceitou essas datas. Escolha o período de novo no calendário.";

/**
 * O endereço pede um período que não pode ser mostrado. Aparece o motivo e NENHUM número: indicadores de
 * outro período nunca ficam no lugar dos pedidos.
 */
export function PeriodProblem({ filters, today, message }: { filters: DashboardFilters; today: string; message: string }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <PeriodPicker filters={filters} today={today} notApplied />
      </div>
      <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-warning/40 bg-warning-bg p-4">
        <p className="m-0 flex items-center gap-2 text-lead font-bold text-warning">
          <CalendarX2 size={18} aria-hidden className="shrink-0" />
          Período não aplicado
        </p>
        <p className="m-0 max-w-[70ch] text-body text-text">{message}</p>
        <p className="m-0 text-meta text-text-tertiary">Nenhum indicador é mostrado no lugar do período pedido.</p>
        <Button asChild variant="secondary" size="sm">
          <Link href={dashboardHref(filters, { periodDays: 30, range: null, rangeError: null, selectedOpportunityId: null })}>
            Ver os últimos 30 dias
          </Link>
        </Button>
      </div>
    </>
  );
}
