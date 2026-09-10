import type { ReactNode } from "react";

import { Sidebar, type SidebarWorkspace } from "./sidebar";

type AppShellProps = {
  children: ReactNode;
  activeWorkspace: SidebarWorkspace;
  workspaces: SidebarWorkspace[];
  overdueActivitiesCount?: number | undefined;
};

export function AppShell({ children, activeWorkspace, workspaces, overdueActivitiesCount }: AppShellProps) {
  return (
    <div className="flex h-dvh overflow-hidden bg-app text-text">
      <Sidebar
        activeWorkspace={activeWorkspace}
        workspaces={workspaces}
        overdueActivitiesCount={overdueActivitiesCount}
      />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
