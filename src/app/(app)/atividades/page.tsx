import type { Metadata } from "next";
import { CheckSquare } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { EmptyState } from "@/components/feedback/empty-state";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { roleHasPermission } from "@/lib/roles";
import { listActivities } from "@/modules/activities/queries";
import { listActivitiesFiltersSchema } from "@/modules/activities/schema";
import { listLeads } from "@/modules/leads/queries";
import { listTeamMembers } from "@/modules/team/queries";
import { ActivityFilterChips } from "@/components/activities/activity-filter-chips";
import { ActivityListTable } from "@/components/activities/activity-list-table";
import { ActivitiesPagination } from "@/components/activities/activities-pagination";
import { CreateActivityDialog } from "@/components/activities/create-activity-dialog";

export const metadata: Metadata = {
  title: "Central de Atividades — Praxis CRM Jurídico",
};

type SearchParams = {
  filter?: string;
  status?: string;
  page?: string;
};

export default async function AtividadesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const params = await searchParams;

  // Filtro vem de query string editável à mão — entrada fora do formato
  // esperado vira "sem filtro" (mesmo tratamento de /leads), nunca um
  // erro cru repassado à RPC.
  const parsedFilters = listActivitiesFiltersSchema.safeParse({
    filter: params.filter ?? "",
    status: params.status ?? "pending",
    page: params.page ?? "1",
  });
  const filters = parsedFilters.success
    ? parsedFilters.data
    : { filter: "" as const, status: "pending" as const, sort: "due_at_asc" as const, page: 1 };

  const canEdit = roleHasPermission(user.role, "activity.edit");

  const [{ items, total, pageSize, counts }, { items: leadOptions }, members] = await Promise.all([
    listActivities(workspaceId, {
      filter: filters.filter || undefined,
      status: filters.status || undefined,
      page: filters.page,
    }),
    listLeads(workspaceId, { status: "ativo" }),
    listTeamMembers(workspaceId, user.id),
  ]);

  const hasActiveFilter = Boolean(filters.filter) || filters.status === "done";

  return (
    <>
      <Topbar title="Central de Atividades" subtitle={`${total} ${total === 1 ? "atividade" : "atividades"}`} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <ActivityFilterChips
              activeFilter={filters.filter || null}
              activeStatus={filters.status ?? "pending"}
              counts={counts}
            />
            {canEdit ? <CreateActivityDialog leadOptions={leadOptions} members={members} /> : null}
          </div>

          {items.length === 0 ? (
            <EmptyState
              icon={CheckSquare}
              title={hasActiveFilter ? "Nenhuma atividade neste filtro" : "Nenhuma atividade ainda"}
              description={
                hasActiveFilter
                  ? "Tente outro filtro."
                  : "Crie a primeira atividade vinculada a um lead ou oportunidade."
              }
            />
          ) : (
            <>
              <ActivityListTable items={items} members={members} canEdit={canEdit} />
              <ActivitiesPagination
                page={filters.page}
                total={total}
                pageSize={pageSize}
                currentParams={{ filter: filters.filter, status: filters.status }}
              />
            </>
          )}
        </div>
      </main>
    </>
  );
}
