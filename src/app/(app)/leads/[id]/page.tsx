import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { roleHasPermission } from "@/lib/roles";
import { getLeadDetail } from "@/modules/leads/queries";
import { listTeamMembers } from "@/modules/team/queries";
import { LeadBasicFieldsForm } from "@/components/leads/lead-basic-fields-form";
import { AssignLeadForm } from "@/components/leads/assign-lead-form";
import { LeadStatusToggle } from "@/components/leads/lead-status-toggle";
import { listOpportunities, getOpportunity, listPipelineStages } from "@/modules/opportunities/queries";
import { LeadOpportunitiesSection } from "@/components/pipeline/create-opportunity-form";
import { listActivities } from "@/modules/activities/queries";
import { ActivitiesSection } from "@/components/activities/activities-section";
import { OpportunityDetailPanel } from "@/components/pipeline/opportunity-detail-panel";
import { StageProgressBar } from "@/components/leads/stage-progress-bar";
import { listConversations } from "@/modules/conversations/queries";
import { listProposalsForLead } from "@/modules/proposals/queries";
import { getConflictCheck } from "@/modules/conflict-checks/queries";
import { getLeadTimelinePage } from "@/modules/timeline/queries";
import { LeadTimeline } from "@/components/leads/lead-timeline";
import { LeadComposer } from "@/components/leads/lead-composer";
import { ProposalsSection } from "@/components/leads/proposals-section";
import { ConflictCheckPanel } from "@/components/leads/conflict-check-panel";
import { LeadProfileTabs } from "@/components/leads/lead-profile-tabs";
import { EmptyState } from "@/components/feedback/empty-state";
import { Button } from "@/components/ui/button";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const lead = await getLeadDetail(id);
  return { title: lead ? `${lead.contactName} — Lead — Praxis CRM Jurídico` : "Lead — Praxis CRM Jurídico" };
}

export default async function LeadDetalhePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const lead = await getLeadDetail(id);

  // Contato inexistente, de outro workspace, ou (advogado) fora do
  // alcance "seus + sem responsável" — get_lead() já responde como não
  // encontrado nesses três casos; a página trata os três do mesmo jeito,
  // sem distinguir "não existe" de "existe mas não é seu" (não revela
  // existência a quem não deveria nem saber).
  if (!lead) notFound();

  const canEdit = roleHasPermission(user.role, "lead.edit");
  const canEditOpportunities = roleHasPermission(user.role, "opportunity.edit");
  const canEditActivities = roleHasPermission(user.role, "activity.edit");
  const canEditProposals = roleHasPermission(user.role, "proposal.edit");
  const canEditConflictCheck = roleHasPermission(user.role, "conflict_check.edit");
  const canEditLeadNotes = roleHasPermission(user.role, "lead_note.edit");

  const [
    members,
    { items: opportunities },
    { items: allActivities },
    { items: conversations },
    proposals,
    conflictCheck,
    timeline,
  ] = await Promise.all([
    listTeamMembers(workspaceId, user.id),
    listOpportunities(workspaceId, { leadId: id }),
    listActivities(workspaceId, { leadId: id }),
    listConversations(workspaceId, { leadId: id }),
    listProposalsForLead(id),
    getConflictCheck(id),
    getLeadTimelinePage(id),
  ]);

  // "Ver cliente" (item 1 do pedido da A8) — o vínculo de cliente da
  // oportunidade mais recente entre as já carregadas acima (não uma
  // segunda consulta); listOpportunities() ordena created_at_desc por
  // padrão, então o primeiro achado já é o mais recente.
  const clientId = opportunities.find((o) => o.clientId)?.clientId ?? null;

  // Oportunidade "ativa" do Perfil 360 (docs/decisoes/a9-perfil-360.md §2):
  // a aberta mais recente, ou — sem nenhuma aberta — a mais recente por
  // created_at. Um lead pode ter mais de uma oportunidade ao longo do
  // tempo; o painel de contexto só tem espaço para uma, as demais
  // continuam listadas em LeadOpportunitiesSection.
  const primaryOpportunityItem = opportunities.find((o) => o.status === "open") ?? opportunities[0] ?? null;

  const [primaryOpportunity, primaryOpportunityActivities] = primaryOpportunityItem
    ? await Promise.all([
        getOpportunity(primaryOpportunityItem.id),
        listActivities(workspaceId, { leadId: id, opportunityId: primaryOpportunityItem.id, status: "pending" }),
      ])
    : [null, { items: [] }];

  const stages = primaryOpportunity ? await listPipelineStages(primaryOpportunity.pipelineId) : [];

  const firstConversationId = conversations[0]?.id ?? null;

  // Uma única ActivitiesSection (todas as atividades do LEAD, não só de
  // uma oportunidade) reaproveitada em duas abas — nunca duas instâncias
  // visíveis ao mesmo tempo (tabs são mutuamente exclusivas), então não
  // duplica o botão "Nova atividade" nem a consulta.
  const activitiesSection = (
    <ActivitiesSection leadId={lead.id} activities={allActivities} members={members} canEdit={canEditActivities} />
  );

  return (
    <>
      <Topbar title={lead.contactName} subtitle={lead.legalArea} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[640px] flex-col gap-5">
          <div className="flex items-center gap-3">
            <Link href={`/contatos/${lead.contactId}`} className="text-meta text-primary hover:underline">
              Ver contato
            </Link>
            {clientId ? (
              <Link href={`/clientes/${clientId}`} className="text-meta text-primary hover:underline">
                Ver cliente
              </Link>
            ) : null}
          </div>

          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-3 text-body font-semibold text-text">Dados do lead</h2>
            <LeadBasicFieldsForm lead={lead} readOnly={!canEdit} />
          </section>

          {canEdit ? (
            <section className="rounded-lg border border-border bg-surface p-4">
              <h2 className="mb-3 text-body font-semibold text-text">Responsável</h2>
              <AssignLeadForm lead={lead} members={members} />
            </section>
          ) : null}

          {canEdit ? (
            <section className="rounded-lg border border-border bg-surface p-4">
              <h2 className="mb-3 text-body font-semibold text-text">Status</h2>
              <LeadStatusToggle lead={lead} />
            </section>
          ) : null}

          <LeadProfileTabs
            visao={
              <div className="flex flex-col gap-4">
                {canEditLeadNotes ? (
                  <LeadComposer leadId={lead.id} members={members} conversationId={firstConversationId} />
                ) : null}

                {primaryOpportunity ? (
                  <section className="rounded-lg border border-border bg-surface p-4">
                    <StageProgressBar stages={stages} currentStageId={primaryOpportunity.stageId} />
                  </section>
                ) : null}

                {primaryOpportunity ? (
                  <OpportunityDetailPanel
                    opportunity={primaryOpportunity}
                    canEdit={canEditOpportunities}
                    activities={primaryOpportunityActivities.items}
                    members={members}
                    canEditActivities={canEditActivities}
                    showClientLink={false}
                    showActivities={false}
                  />
                ) : null}

                <ConflictCheckPanel leadId={lead.id} conflictCheck={conflictCheck} canEdit={canEditConflictCheck} />

                <section className="rounded-lg border border-border bg-surface p-4">
                  <h2 className="mb-3 text-body font-semibold text-text">Linha do tempo</h2>
                  <LeadTimeline
                    leadId={lead.id}
                    initialItems={timeline.items}
                    initialHasMore={timeline.hasMore}
                    members={members}
                  />
                </section>
              </div>
            }
            conversas={
              conversations.length === 0 ? (
                <EmptyState
                  title="Nenhuma conversa vinculada"
                  description="Conversas de WhatsApp ligadas a este lead aparecem aqui."
                />
              ) : (
                <ul className="flex flex-col gap-3">
                  {conversations.map((c) => (
                    <li key={c.id} className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-body font-semibold text-text">{c.waId}</span>
                        {c.lastMessageText ? (
                          <span className="truncate text-meta text-text-secondary">{c.lastMessageText}</span>
                        ) : null}
                      </div>
                      <Link href={`/conversas/${c.id}`} className="ml-auto shrink-0">
                        <Button type="button" variant="secondary" size="sm">
                          Abrir conversa
                        </Button>
                      </Link>
                    </li>
                  ))}
                </ul>
              )
            }
            atividades={activitiesSection}
            arquivos={
              <EmptyState
                title="Envio de arquivos ainda não está disponível"
                description="Upload de documentos entra na fase B4, condicionado ao piloto — não faz parte desta fase."
              />
            }
            propostas={
              <ProposalsSection
                leadId={lead.id}
                opportunityId={primaryOpportunityItem?.status === "open" ? primaryOpportunityItem.id : null}
                proposals={proposals}
                canEdit={canEditProposals}
              />
            }
            historico={
              <LeadTimeline
                leadId={lead.id}
                initialItems={timeline.items}
                initialHasMore={timeline.hasMore}
                members={members}
                showFilters={false}
              />
            }
          />

          <LeadOpportunitiesSection leadId={lead.id} opportunities={opportunities} canEdit={canEditOpportunities} />
        </div>
      </main>
    </>
  );
}
