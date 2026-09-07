import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";
import { getShellContext } from "@/modules/shell/queries";

/**
 * Sessão e workspace ativo resolvidos aqui, antes de qualquer página
 * interna renderizar — `requireMembershipOrRedirect()` (dentro de
 * getShellContext) manda para /entrar sem sessão, ou /onboarding com
 * sessão mas sem workspace algum.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { activeWorkspace, workspaces } = await getShellContext();

  return (
    <AppShell activeWorkspace={activeWorkspace} workspaces={workspaces}>
      {children}
    </AppShell>
  );
}
