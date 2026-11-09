import type { Metadata } from "next";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { requireMembership, roleHasPermission } from "@/server/authz/permissions";
import { listPendingInvitations, listTeamMembers } from "@/modules/team/queries";
import { MemberRow } from "@/components/team/member-row";
import { PendingInvitationRow } from "@/components/team/pending-invitation-row";
import { InviteDialog } from "@/components/team/invite-dialog";
import { TransferOwnershipDialog } from "@/components/team/transfer-ownership-dialog";
import { EmptyState } from "@/components/feedback/empty-state";

export const metadata: Metadata = {
  title: "Equipe — Praxis CRM Jurídico",
};

export default async function EquipePage() {
  const { user, activeWorkspace } = await getShellContext();
  const membership = await requireMembership();
  const canManage = roleHasPermission(membership.role, "membership.manage");
  const canTransferOwnership = roleHasPermission(membership.role, "workspace.transfer_ownership");

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

          {canTransferOwnership ? (
            <section className="rounded-lg border border-border bg-surface">
              <div className="border-b border-border px-4 py-3">
                <h2 className="text-body font-semibold text-text">Posse do workspace</h2>
              </div>
              <div className="flex flex-col gap-3 p-4">
                <p className="m-0 text-small text-text-tertiary">
                  Você é o proprietário de {activeWorkspace.name}. Para passar a posse, escolha outro membro da equipe:
                  ele passa a ser Proprietário e você passa a ser Administrador. A transferência fica registrada na
                  auditoria.
                </p>
                {members.some((member) => !member.isCurrentUser) ? (
                  <div>
                    <TransferOwnershipDialog members={members} />
                  </div>
                ) : (
                  <p className="m-0 text-small text-text-muted">
                    Convide mais alguém para a equipe antes de transferir a posse.
                  </p>
                )}
              </div>
            </section>
          ) : null}
        </div>
      </main>
    </>
  );
}
