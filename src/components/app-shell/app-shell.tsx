import type { ReactNode } from "react";

import { Sidebar, type SidebarWorkspace } from "./sidebar";

type AppShellProps = {
  children: ReactNode;
  activeWorkspace: SidebarWorkspace;
  workspaces: SidebarWorkspace[];
};

export function AppShell({ children, activeWorkspace, workspaces }: AppShellProps) {
  return (
    <div className="flex h-dvh overflow-hidden bg-app text-text">
      <Sidebar activeWorkspace={activeWorkspace} workspaces={workspaces} />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
