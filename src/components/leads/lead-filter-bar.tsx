import Link from "next/link";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
    <form action="/leads" method="get" className="flex flex-wrap items-end gap-3">
      <div className="relative min-w-[220px] flex-1">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
          aria-hidden
        />
        <Input
          name="q"
          type="search"
          defaultValue={defaultValues.search}
          placeholder="Contato ou resumo"
          className="pl-8"
          aria-label="Buscar leads"
        />
      </div>

      <select
        name="status"
        defaultValue={defaultValues.status}
        aria-label="Status"
        className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
      >
        <option value="">Todos os status</option>
        {LEAD_STATUSES.map((status) => (
          <option key={status} value={status}>
            {STATUS_LABEL[status]}
          </option>
        ))}
      </select>

      <select
        name="priority"
        defaultValue={defaultValues.priority}
        aria-label="Prioridade"
        className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
      >
        <option value="">Toda prioridade</option>
        {LEAD_PRIORITIES.map((priority) => (
          <option key={priority} value={priority}>
            {PRIORITY_LABEL[priority]}
          </option>
        ))}
      </select>

      <select
        name="assignedTo"
        defaultValue={defaultValues.assignedTo}
        aria-label="Responsável"
        className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
      >
        <option value="">Todo responsável</option>
        {members.map((member) => (
          <option key={member.userId} value={member.userId}>
            {member.fullName ?? member.email}
          </option>
        ))}
      </select>

      <Button type="submit" variant="secondary" size="sm">
        Filtrar
      </Button>
      {hasActiveFilters ? (
        <Button asChild variant="ghost" size="sm">
          <Link href="/leads">Limpar filtros</Link>
        </Button>
      ) : null}
    </form>
  );
}
