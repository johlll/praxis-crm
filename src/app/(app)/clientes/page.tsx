import type { Metadata } from "next";
import { Users as UsersIcon } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { EmptyState } from "@/components/feedback/empty-state";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { listClients } from "@/modules/clients/queries";
import { listClientsFiltersSchema } from "@/modules/clients/schema";
import { ClientFilterBar } from "@/components/clients/client-filter-bar";
import { ClientListTable } from "@/components/clients/client-list-table";
import { ClientsPagination } from "@/components/clients/clients-pagination";

export const metadata: Metadata = {
  title: "Clientes — Praxis CRM Jurídico",
};

type SearchParams = {
  q?: string;
  status?: string;
  page?: string;
};

export default async function ClientesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const params = await searchParams;

  // Mesmo tratamento de listLeadsFiltersSchema (A4): entrada de query
  // string fora do formato esperado vira "sem filtro", nunca um erro cru
  // repassado ao RPC.
  const parsedFilters = listClientsFiltersSchema.safeParse({
    search: params.q ?? "",
    status: params.status ?? "",
    page: params.page ?? "1",
  });
  const filters = parsedFilters.success
    ? parsedFilters.data
    : { search: "", status: "" as const, sort: "created_at_desc" as const, page: 1 };
  const page = filters.page;

  const { items, total, pageSize } = await listClients(workspaceId, {
    search: filters.search || undefined,
    status: filters.status || undefined,
    page,
  });

  const hasActiveFilters = Boolean(filters.search || filters.status);

  return (
    <>
      <Topbar title="Clientes" subtitle={`${total} ${total === 1 ? "cliente" : "clientes"}`} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
          <ClientFilterBar
            defaultValues={{ search: filters.search ?? "", status: filters.status ?? "" }}
            hasActiveFilters={hasActiveFilters}
          />

          {items.length === 0 ? (
            <EmptyState
              icon={UsersIcon}
              title={hasActiveFilters ? "Nenhum cliente encontrado" : "Nenhum cliente ainda"}
              description={
                hasActiveFilters
                  ? "Tente outro filtro ou limpe a busca."
                  : "Clientes aparecem aqui automaticamente quando uma oportunidade é marcada como ganha."
              }
            />
          ) : (
            <>
              <ClientListTable items={items} />
              <ClientsPagination
                page={page}
                total={total}
                pageSize={pageSize}
                currentParams={{ q: filters.search, status: filters.status }}
              />
            </>
          )}
        </div>
      </main>
    </>
  );
}
