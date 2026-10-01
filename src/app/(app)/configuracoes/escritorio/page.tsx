import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { requireMembership, roleHasPermission } from "@/server/authz/permissions";
import { getWorkspaceLegalProfile } from "@/modules/workspace/queries";
import { WorkspaceLegalProfileForm } from "@/components/settings/workspace-legal-profile-form";

export const metadata: Metadata = {
  title: "Escritório — Praxis CRM Jurídico",
};

export default async function EscritorioPage() {
  const { user, activeWorkspace } = await getShellContext();
  const membership = await requireMembership();

  // Só owner/admin edita; os demais nem enxergam esta tela (mesmo padrão
  // de Pipelines/Simulador na página-índice de Configurações).
  if (!roleHasPermission(membership.role, "workspace_legal_profile.manage")) notFound();

  const profile = await getWorkspaceLegalProfile(activeWorkspace.id);

  return (
    <>
      <Topbar title="Escritório" subtitle="Dados exibidos no cabeçalho do PDF de proposta" user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-[520px] rounded-lg border border-border bg-surface p-4">
          <WorkspaceLegalProfileForm workspaceId={activeWorkspace.id} profile={profile} />
        </div>
      </main>
    </>
  );
}
