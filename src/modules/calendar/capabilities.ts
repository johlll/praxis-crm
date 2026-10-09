import { roleHasPermission, type Role } from "@/lib/roles";
import { getCalendarProvider } from "@/server/calendar/provider";
import { listCalendarConnections } from "@/modules/calendar/queries";
import { NO_CALENDAR, type CalendarCapabilities } from "@/modules/calendar/types";

/**
 * O que a interface pode oferecer ao usuário sobre o Google Agenda. Com a
 * integração desligada (sem provedor configurado) devolve tudo falso SEM
 * consultar o banco — as telas de atividade ficam exatamente como eram.
 */
export async function getCalendarCapabilities(params: {
  workspaceId: string;
  role: Role;
}): Promise<CalendarCapabilities> {
  const provider = await getCalendarProvider();
  if (!provider) return NO_CALENDAR;

  const canUse = roleHasPermission(params.role, "calendar.connect_own");
  if (!canUse) return { enabled: true, canUse: false, hasConnection: false };

  try {
    const connections = await listCalendarConnections(params.workspaceId);
    const hasConnection = connections.some((c) => c.isMine && c.status === "active" && c.calendarId !== null);
    return { enabled: true, canUse: true, hasConnection };
  } catch {
    // A leitura falhou: não oferece a agenda (as ações conferem tudo de novo no servidor).
    return { enabled: true, canUse: true, hasConnection: false };
  }
}
