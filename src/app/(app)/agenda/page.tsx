import type { Metadata } from "next";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { roleHasPermission } from "@/lib/roles";
import { firstDayOf, lastDayOf, resolveAgendaMonth, todayKey } from "@/lib/calendar-month";
import { listActivitiesInRange } from "@/modules/activities/queries";
import { listAllLeads } from "@/modules/leads/queries";
import { listTeamMembers } from "@/modules/team/queries";
import { MonthAgenda } from "@/components/agenda/month-agenda";
import { CalendarHealthNotices } from "@/components/calendar/calendar-health-notices";
import { loadCalendarHealthNotices } from "@/modules/calendar/automation";
import { scheduleOnDemandCalendarSync } from "@/modules/calendar/on-demand";

export const metadata: Metadata = {
  title: "Agenda — Praxis CRM Jurídico",
};

/**
 * Agenda mensal: calendário do mês + painel do dia selecionado.
 *
 * O mês (`?mes=AAAA-MM`) é validado aqui; sem ele, ou inválido, vale o mês
 * de hoje no fuso America/Sao_Paulo (calculado no servidor, nunca no fuso
 * da máquina nem do navegador). As atividades do mês inteiro vêm do banco
 * (list_activities_in_range, no alcance do usuário, paginadas até o fim);
 * falha de leitura vai para o error.tsx — nunca vira "nenhuma atividade".
 */
export default async function AgendaPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const canEdit = roleHasPermission(user.role, "activity.edit");

  const today = todayKey();
  const month = resolveAgendaMonth({ mes: params.mes, dia: params.dia }, today);

  const [{ items, dayCounts }, leadOptions, members] = await Promise.all([
    listActivitiesInRange(workspaceId, { from: firstDayOf(month), to: lastDayOf(month) }),
    // Seletor do "Nova atividade": todos os leads ativos, não só a 1ª página.
    canEdit ? listAllLeads(workspaceId, { status: "ativo" }) : Promise.resolve([]),
    listTeamMembers(workspaceId, user.id),
  ]);

  // Google Agenda (B2): abrir a agenda dispara a sincronização da PRÓPRIA
  // conexão depois da resposta (§9.2, item 3), e owner/admin veem se a
  // automática está atrasada (§9.3). Integração desligada: nada acontece.
  // Trocar de mês ou de dia não cria, reagenda nem exclui nada.
  if (roleHasPermission(user.role, "calendar.connect_own")) {
    await scheduleOnDemandCalendarSync({ userId: user.id, workspaceId });
  }
  const healthNotices = roleHasPermission(user.role, "calendar.manage") ? await loadCalendarHealthNotices(workspaceId) : [];

  return (
    <>
      <Topbar title="Agenda" subtitle="Compromissos e tarefas do mês, dia a dia" user={user} />
      <main className="flex-1 overflow-y-auto p-4 sm:p-5">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-4">
          <CalendarHealthNotices notices={healthNotices} />
          <MonthAgenda
            month={month}
            today={today}
            items={items}
            dayCounts={dayCounts}
            canEdit={canEdit}
            members={members}
            leadOptions={leadOptions}
          />
        </div>
      </main>
    </>
  );
}
