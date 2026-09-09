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
  // alcance de "seus + equipe" — get_lead() já responde como não
  // encontrado nesses três casos; a página trata os três do mesmo jeito,
  // sem distinguir "não existe" de "existe mas não é seu" (não revela
  // existência a quem não deveria nem saber).
  if (!lead) notFound();

  const canEdit = roleHasPermission(user.role, "lead.edit");
  const members = await listTeamMembers(workspaceId, user.id);

  return (
    <>
      <Topbar title={lead.contactName} subtitle={lead.legalArea} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[640px] flex-col gap-5">
          <Link href={`/contatos/${lead.contactId}`} className="text-meta text-primary hover:underline">
            Ver contato
          </Link>

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
        </div>
      </main>
    </>
  );
}
