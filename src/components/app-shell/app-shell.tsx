import type { ReactNode } from "react";

import { Sidebar } from "./sidebar";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh overflow-hidden bg-app text-text">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
