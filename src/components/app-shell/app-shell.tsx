import type { ReactNode } from "react";

import { Sidebar, type SidebarUser, type SidebarWorkspace } from "./sidebar";
import { MobileNav } from "./mobile-nav";

type AppShellProps = {
  children: ReactNode;
  activeWorkspace: SidebarWorkspace;
  workspaces: SidebarWorkspace[];
  overdueActivitiesCount?: number | undefined;
  user?: SidebarUser | undefined;
};

export function AppShell({ children, activeWorkspace, workspaces, overdueActivitiesCount, user }: AppShellProps) {
  const navProps = { activeWorkspace, workspaces, overdueActivitiesCount, user };

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas text-text">
      <Sidebar {...navProps} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav {...navProps} />
        {children}
      </div>
    </div>
  );
}
