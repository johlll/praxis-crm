import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { roleHasPermission } from "@/lib/roles";
import { getOpportunity } from "@/modules/opportunities/queries";
import { listActivities } from "@/modules/activities/queries";
import { listTeamMembers } from "@/modules/team/queries";
import { OpportunityDetailPanel } from "@/components/pipeline/opportunity-detail-panel";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const opportunity = await getOpportunity(id);
  return {
    title: opportunity ? `${opportunity.contactName} — Oportunidade — Praxis CRM Jurídico` : "Oportunidade — Praxis CRM Jurídico",
  };
}

export default async function OportunidadeDetalhePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const opportunity = await getOpportunity(id);

  // get_opportunity() já responde "não encontrado" para inexistente, de
  // outro workspace, ou (advogado/atendimento) fora do alcance "seus +
  // sem responsável" — a página trata os três do mesmo jeito.
  if (!opportunity) notFound();

  const canEdit = roleHasPermission(user.role, "opportunity.edit");
  const canEditActivities = roleHasPermission(user.role, "activity.edit");

  const [{ items: activities }, members] = await Promise.all([
    listActivities(workspaceId, { opportunityId: id, status: "pending" }),
    listTeamMembers(workspaceId, user.id),
  ]);

  return (
    <>
      <Topbar title={opportunity.contactName} subtitle={opportunity.legalArea} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[640px] flex-col gap-5">
          <div className="flex gap-3">
            <Link href={`/leads/${opportunity.leadId}`} className="text-meta text-primary hover:underline">
              Ver lead
            </Link>
            <Link href="/pipeline" className="text-meta text-primary hover:underline">
              Voltar ao pipeline
            </Link>
          </div>
          <OpportunityDetailPanel
            opportunity={opportunity}
            canEdit={canEdit}
            activities={activities}
            members={members}
            canEditActivities={canEditActivities}
          />
        </div>
      </main>
    </>
  );
}
