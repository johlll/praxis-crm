import type { Metadata } from "next";

import { Topbar } from "@/components/app-shell/topbar";
import { EmptyState } from "@/components/feedback/empty-state";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { roleHasPermission } from "@/lib/roles";
import { listAllActivities } from "@/modules/activities/queries";
import { listLeads } from "@/modules/leads/queries";
import { listTeamMembers } from "@/modules/team/queries";
import { WeekCalendar } from "@/components/activities/week-calendar";
import { CreateActivityDialog } from "@/components/activities/create-activity-dialog";

export const metadata: Metadata = {
  title: "Agenda — Praxis CRM Jurídico",
};

/**
 * Calendário semanal — SEMPRE a semana atual (segunda a domingo, fuso
 * America/Sao_Paulo). Sem navegação entre semanas nesta entrega
 * (simplificação registrada em A6-HANDOFF.md — fora do pedido explícito
 * desta fase, que só pede "calendário semanal").
 */
export default async function AgendaPage() {
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const canEdit = roleHasPermission(user.role, "activity.edit");

  const [{ items }, { items: leadOptions }, members] = await Promise.all([
    listAllActivities(workspaceId, { filter: "week", status: "all", sort: "due_at_asc" }),
    listLeads(workspaceId, { status: "ativo" }),
    listTeamMembers(workspaceId, user.id),
  ]);

  return (
    <>
      <Topbar title="Agenda" subtitle="Compromissos e tarefas desta semana" user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-4">
          {canEdit ? (
            <div className="flex justify-end">
              <CreateActivityDialog leadOptions={leadOptions} members={members} />
            </div>
          ) : null}

          {items.length === 0 ? (
            <EmptyState title="Nada agendado esta semana" description="As atividades com data nesta semana aparecem aqui." />
          ) : (
            <WeekCalendar items={items} members={members} canEdit={canEdit} />
          )}
        </div>
      </main>
    </>
  );
}
