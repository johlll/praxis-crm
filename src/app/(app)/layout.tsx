import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";
import { getShellContext } from "@/modules/shell/queries";
import { getActivityCounts } from "@/modules/activities/queries";

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
  const activityCounts = await getActivityCounts(activeWorkspace.id);

  return (
    <AppShell activeWorkspace={activeWorkspace} workspaces={workspaces} overdueActivitiesCount={activityCounts.overdue}>
      {children}
    </AppShell>
  );
}
