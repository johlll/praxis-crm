import Link from "next/link";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CLIENT_STATUSES } from "@/modules/clients/queries";

const STATUS_LABEL: Record<(typeof CLIENT_STATUSES)[number], string> = {
  ativo: "Ativo",
  encerrado: "Encerrado",
  suspenso: "Suspenso",
};

export type ClientFilterValues = {
  search: string;
  status: string;
};

/** Mesmo padrão de LeadFilterBar (A4): GET simples, sem auto-submit. */
export function ClientFilterBar({
  defaultValues,
  hasActiveFilters,
}: {
  defaultValues: ClientFilterValues;
  hasActiveFilters: boolean;
}) {
  return (
    <form action="/clientes" method="get" className="flex flex-wrap items-end gap-3">
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
          placeholder="Nome do contato"
          className="pl-8"
          aria-label="Buscar clientes"
        />
      </div>

      <select
        name="status"
        defaultValue={defaultValues.status}
        aria-label="Status"
        className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
      >
        <option value="">Todos os status</option>
        {CLIENT_STATUSES.map((status) => (
          <option key={status} value={status}>
            {STATUS_LABEL[status]}
          </option>
        ))}
      </select>

      <Button type="submit" variant="secondary" size="sm">
        Filtrar
      </Button>
      {hasActiveFilters ? (
        <Button asChild variant="ghost" size="sm">
          <Link href="/clientes">Limpar filtros</Link>
        </Button>
      ) : null}
    </form>
  );
}
