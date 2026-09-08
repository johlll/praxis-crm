import type { Metadata } from "next";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { requireMembership, roleHasPermission } from "@/server/authz/permissions";
import { listPendingInvitations, listTeamMembers } from "@/modules/team/queries";
import { MemberRow } from "@/components/team/member-row";
import { PendingInvitationRow } from "@/components/team/pending-invitation-row";
import { InviteDialog } from "@/components/team/invite-dialog";
import { EmptyState } from "@/components/feedback/empty-state";

export const metadata: Metadata = {
  title: "Equipe — Praxis CRM Jurídico",
};

export default async function EquipePage() {
  const { user, activeWorkspace } = await getShellContext();
  const membership = await requireMembership();
  const canManage = roleHasPermission(membership.role, "membership.manage");

  const members = await listTeamMembers(activeWorkspace.id, membership.userId);
  const invitations = canManage ? await listPendingInvitations(activeWorkspace.id) : [];

  return (
    <>
      <Topbar
        title="Equipe"
        subtitle={`${members.length} ${members.length === 1 ? "membro" : "membros"} em ${activeWorkspace.name}`}
        user={user}
      />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[720px] flex-col gap-5">
          <section className="rounded-lg border border-border bg-surface">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-body font-semibold text-text">Membros</h2>
              {canManage ? <InviteDialog /> : null}
            </div>
            {members.map((member) => (
              <MemberRow key={member.membershipId} member={member} canManage={canManage} />
            ))}
          </section>

          {canManage ? (
            <section className="rounded-lg border border-border bg-surface">
              <div className="border-b border-border px-4 py-3">
                <h2 className="text-body font-semibold text-text">Convites pendentes</h2>
              </div>
              {invitations.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    title="Nenhum convite pendente"
                    description="Convites cancelados, expirados ou aceitos não aparecem aqui."
                  />
                </div>
              ) : (
                invitations.map((invitation) => (
                  <PendingInvitationRow key={invitation.id} invitation={invitation} />
                ))
              )}
            </section>
          ) : null}
        </div>
      </main>
    </>
  );
}
