import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { LEAD_PRIORITIES, LEAD_STATUSES } from "@/modules/leads/schema";
import type { TeamMember } from "@/modules/team/queries";

const STATUS_LABEL: Record<(typeof LEAD_STATUSES)[number], string> = {
  ativo: "Ativo",
  arquivado: "Arquivado",
};

const PRIORITY_LABEL: Record<(typeof LEAD_PRIORITIES)[number], string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
};

export type LeadFilterValues = {
  search: string;
  status: string;
  priority: string;
  assignedTo: string;
};

/** Select nativo (teclado e leitores de tela de graça) com o acabamento dos campos. */
function FilterSelect({
  name,
  label,
  defaultValue,
  children,
}: {
  name: string;
  label: string;
  defaultValue: string;
  children: ReactNode;
}) {
  const active = defaultValue !== "";
  return (
    <div className="relative max-md:min-w-[calc(50%-4px)] max-md:flex-1">
      <select
        name={name}
        defaultValue={defaultValue}
        aria-label={label}
        className={cn(
          "h-9 w-full cursor-pointer appearance-none rounded-input border bg-app pr-8 pl-3 text-body text-text transition-colors md:w-auto md:max-w-[220px]",
          "hover:border-border-strong focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary-ring focus-visible:outline-none",
          active ? "border-primary-border bg-primary-tint/40" : "border-border-input",
        )}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-text-muted"
      />
    </div>
  );
}

/**
 * GET simples — filtros viram searchParams da própria página, que decide
 * a consulta no servidor (nunca carrega tudo pra filtrar no navegador).
 * Sem JS de auto-submit: um clique em "Filtrar" aplica tudo de uma vez,
 * suficiente para o volume de um escritório só.
 */
export function LeadFilterBar({
  defaultValues,
  members,
  hasActiveFilters,
}: {
  defaultValues: LeadFilterValues;
  members: TeamMember[];
  hasActiveFilters: boolean;
}) {
  return (
    <form action="/leads" method="get" role="search" aria-label="Filtros de leads" className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[240px] flex-1 max-md:basis-full">
        <Search
          size={15}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-muted"
          aria-hidden
        />
        <Input
          name="q"
          type="search"
          defaultValue={defaultValues.search}
          placeholder="Buscar por contato ou resumo"
          className="pl-9"
          aria-label="Buscar leads"
        />
      </div>

      <FilterSelect name="status" label="Status" defaultValue={defaultValues.status}>
        <option value="">Todos os status</option>
        {LEAD_STATUSES.map((status) => (
          <option key={status} value={status}>
            {STATUS_LABEL[status]}
          </option>
        ))}
      </FilterSelect>

      <FilterSelect name="priority" label="Prioridade" defaultValue={defaultValues.priority}>
        <option value="">Toda prioridade</option>
        {LEAD_PRIORITIES.map((priority) => (
          <option key={priority} value={priority}>
            {PRIORITY_LABEL[priority]}
          </option>
        ))}
      </FilterSelect>

      <FilterSelect name="assignedTo" label="Responsável" defaultValue={defaultValues.assignedTo}>
        <option value="">Todo responsável</option>
        {members.map((member) => (
          <option key={member.userId} value={member.userId}>
            {member.fullName ?? member.email}
          </option>
        ))}
      </FilterSelect>

      <div className="flex items-center gap-1 max-md:basis-full">
        <Button type="submit" variant="secondary" className="max-md:flex-1">
          Filtrar
        </Button>
        {hasActiveFilters ? (
          <Button asChild variant="ghost" className="max-md:flex-1">
            <Link href="/leads">
              <X size={14} aria-hidden />
              Limpar filtros
            </Link>
          </Button>
        ) : null}
      </div>
    </form>
  );
}
