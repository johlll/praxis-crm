import { cache } from "react";

import { requireMembershipOrRedirect } from "@/server/authz/permissions";
import { createServerSupabaseClient } from "@/server/supabase/server";
import { initialsOf } from "@/lib/initials";
import { listMyWorkspaces, type WorkspaceOption } from "@/modules/workspace/queries";

export type ShellContext = {
  user: {
    id: string;
    fullName: string;
    initials: string;
    role: WorkspaceOption["role"];
  };
  activeWorkspace: WorkspaceOption;
  workspaces: WorkspaceOption[];
};

/**
 * Tudo que o AppShell (sidebar + topbar) precisa, buscado uma vez por
 * request — `cache()` do React garante que chamar isto de novo dentro da
 * mesma renderização (layout + cada page) reaproveita o resultado em vez
 * de repetir a consulta.
 */
export const getShellContext = cache(async (): Promise<ShellContext> => {
  const membership = await requireMembershipOrRedirect();
  const workspaces = await listMyWorkspaces();

  const activeWorkspace = workspaces.find((w) => w.id === membership.workspaceId) ?? {
    id: membership.workspaceId,
    name: "Workspace",
    slug: "",
    role: membership.role,
  };

  const supabase = await createServerSupabaseClient();
  const { data: profile } = await supabase
    .from("users")
    .select("full_name, email")
    .eq("id", membership.userId)
    .single();

  const fullName = profile?.full_name?.trim() || profile?.email || "Usuário";

  return {
    user: {
      id: membership.userId,
      fullName,
      initials: initialsOf(fullName),
      role: membership.role,
    },
    activeWorkspace,
    workspaces,
  };
});
