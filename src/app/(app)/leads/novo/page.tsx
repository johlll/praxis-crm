import type { Metadata } from "next";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { roleHasPermission } from "@/lib/roles";
import { listContactOptions } from "@/modules/leads/queries";
import { listTeamMembers } from "@/modules/team/queries";
import { CreateLeadForm } from "@/components/leads/create-lead-form";

export const metadata: Metadata = {
  title: "Novo lead — Praxis CRM Jurídico",
};

export default async function NovoLeadPage({
  searchParams,
}: {
  searchParams: Promise<{ contactId?: string }>;
}) {
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const params = await searchParams;

  const [contacts, members] = await Promise.all([
    listContactOptions(workspaceId),
    listTeamMembers(workspaceId, user.id),
  ]);

  return (
    <>
      <Topbar title="Novo lead" user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-[560px]">
          <CreateLeadForm
            contacts={contacts}
            members={members}
            canSetValue={roleHasPermission(user.role, "lead.view_value")}
            defaultContactId={params.contactId}
          />
        </div>
      </main>
    </>
  );
}
