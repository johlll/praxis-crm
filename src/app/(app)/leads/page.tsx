import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Users as UsersIcon } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/feedback/empty-state";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { listLeads } from "@/modules/leads/queries";
import { listTeamMembers } from "@/modules/team/queries";
import { listLeadsFiltersSchema } from "@/modules/leads/schema";
import { LeadFilterBar } from "@/components/leads/lead-filter-bar";
import { LeadListTable } from "@/components/leads/lead-list-table";
import { LeadsPagination } from "@/components/leads/leads-pagination";

export const metadata: Metadata = {
  title: "Leads — Praxis CRM Jurídico",
};

type SearchParams = {
  q?: string;
  status?: string;
  priority?: string;
  assignedTo?: string;
  page?: string;
};

export default async function LeadsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const params = await searchParams;

  // Filtros vêm de query string editável à mão — nunca confiados sem
  // validação, mesmo sendo "só" leitura: um enum/uuid inválido aqui não
  // pode virar erro cru repassado ao RPC. Entrada fora do formato
  // esperado é tratada como "sem filtro" (fallback seguro), não como
  // falha da página.
  const parsedFilters = listLeadsFiltersSchema.safeParse({
    search: params.q ?? "",
    status: params.status ?? "",
    priority: params.priority ?? "",
    assignedTo: params.assignedTo ?? "",
    legalArea: "",
    page: params.page ?? "1",
  });
  const filters = parsedFilters.success
    ? parsedFilters.data
    : { search: "", status: "" as const, priority: "" as const, assignedTo: "", legalArea: "", sort: "created_at_desc" as const, page: 1 };
  const page = filters.page;

  const [{ items, total, pageSize }, members] = await Promise.all([
    listLeads(workspaceId, {
      search: filters.search || undefined,
      status: filters.status || undefined,
      priority: filters.priority || undefined,
      assignedTo: filters.assignedTo || undefined,
      page,
    }),
    listTeamMembers(workspaceId, user.id),
  ]);

  const hasActiveFilters = Boolean(filters.search || filters.status || filters.priority || filters.assignedTo);

  return (
    <>
      <Topbar title="Leads" subtitle={`${total} ${total === 1 ? "lead" : "leads"}`} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <LeadFilterBar
              defaultValues={{
                search: filters.search ?? "",
                status: filters.status ?? "",
                priority: filters.priority ?? "",
                assignedTo: filters.assignedTo ?? "",
              }}
              members={members}
              hasActiveFilters={hasActiveFilters}
            />
            <Button asChild size="sm" className="shrink-0">
              <Link href="/leads/novo">
                <Plus size={14} aria-hidden />
                Novo lead
              </Link>
            </Button>
          </div>

          {items.length === 0 ? (
            <EmptyState
              icon={UsersIcon}
              title={hasActiveFilters ? "Nenhum lead encontrado" : "Nenhum lead ainda"}
              description={
                hasActiveFilters
                  ? "Tente outro filtro ou limpe a busca."
                  : "Cadastre o primeiro lead vinculado a um contato."
              }
            />
          ) : (
            <>
              <LeadListTable items={items} />
              <LeadsPagination
                page={page}
                total={total}
                pageSize={pageSize}
                currentParams={{
                  q: filters.search,
                  status: filters.status,
                  priority: filters.priority,
                  assignedTo: filters.assignedTo,
                }}
              />
            </>
          )}
        </div>
      </main>
    </>
  );
}
