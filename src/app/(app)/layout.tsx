import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";

/**
 * Layout das telas internas. A partir de A2 este layout também resolve a
 * sessão e o workspace ativo antes de renderizar qualquer coisa.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
