import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";
import { getShellContext } from "@/modules/shell/queries";
import { getActivityCounts } from "@/modules/activities/queries";
import { getCalendarCapabilities } from "@/modules/calendar/capabilities";
import { CalendarCapabilitiesProvider } from "@/components/calendar/calendar-capabilities";

/**
 * Sessão e workspace ativo resolvidos aqui, antes de qualquer página
 * interna renderizar — `requireMembershipOrRedirect()` (dentro de
 * getShellContext) manda para /entrar sem sessão, ou /onboarding com
 * sessão mas sem workspace algum.
 *
 * A6 — contador real da sidebar: só o número de atrasadas (o mais
 * acionável) vira badge no item "Atividades"; buscado a cada navegação
 * (este layout roda em toda page), então nunca fica velho por mais que
 * uma troca de rota.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { activeWorkspace, workspaces } = await getShellContext();
  const [activityCounts, calendarCapabilities] = await Promise.all([
    getActivityCounts(activeWorkspace.id),
    // Com a integração desligada devolve tudo falso sem tocar no banco.
    getCalendarCapabilities({ workspaceId: activeWorkspace.id, role: activeWorkspace.role }),
  ]);

  return (
    <AppShell activeWorkspace={activeWorkspace} workspaces={workspaces} overdueActivitiesCount={activityCounts.overdue}>
      <CalendarCapabilitiesProvider value={calendarCapabilities}>{children}</CalendarCapabilitiesProvider>
    </AppShell>
  );
}
