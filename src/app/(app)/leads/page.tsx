import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Users as UsersIcon } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/feedback/empty-state";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { listLeads, type LeadStatus, type LeadPriority } from "@/modules/leads/queries";
import { listTeamMembers } from "@/modules/team/queries";
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
  const page = Number(params.page) > 0 ? Number(params.page) : 1;

  const [{ items, total, pageSize }, members] = await Promise.all([
    listLeads(workspaceId, {
      search: params.q,
      status: (params.status as LeadStatus) || undefined,
      priority: (params.priority as LeadPriority) || undefined,
      assignedTo: params.assignedTo,
      page,
    }),
    listTeamMembers(workspaceId, user.id),
  ]);

  const hasActiveFilters = Boolean(params.q || params.status || params.priority || params.assignedTo);

  return (
    <>
      <Topbar title="Leads" subtitle={`${total} ${total === 1 ? "lead" : "leads"}`} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <LeadFilterBar
              defaultValues={{
                search: params.q ?? "",
                status: params.status ?? "",
                priority: params.priority ?? "",
                assignedTo: params.assignedTo ?? "",
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
                  q: params.q,
                  status: params.status,
                  priority: params.priority,
                  assignedTo: params.assignedTo,
                }}
              />
            </>
          )}
        </div>
      </main>
    </>
  );
}
