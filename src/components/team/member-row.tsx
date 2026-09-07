"use client";

import { useTransition } from "react";
import { MoreHorizontal } from "lucide-react";

import { initialsOf } from "@/lib/initials";
import { ROLES, ROLE_LABEL, type Role } from "@/lib/roles";
import type { TeamMember } from "@/modules/team/queries";
import {
  removeMembershipAction,
  updateMembershipRoleAction,
} from "@/modules/team/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type MemberRowProps = {
  member: TeamMember;
  canManage: boolean;
};

export function MemberRow({ member, canManage }: MemberRowProps) {
  const [isPending, startTransition] = useTransition();

  function changeRole(role: Role) {
    if (role === member.role) return;
    const formData = new FormData();
    formData.set("membershipId", member.membershipId);
    formData.set("role", role);
    startTransition(() => {
      void updateMembershipRoleAction(formData);
    });
  }

  function remove() {
    const formData = new FormData();
    formData.set("membershipId", member.membershipId);
    startTransition(() => {
      void removeMembershipAction(formData);
    });
  }

  return (
    <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3 last:border-0">
      <div
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary-tint text-meta font-bold text-primary"
        aria-hidden
      >
        {initialsOf(member.fullName ?? member.email)}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-small font-semibold text-text">
          {member.fullName ?? member.email}
          {member.isCurrentUser ? (
            <span className="ml-1.5 font-normal text-text-muted">(você)</span>
          ) : null}
        </span>
        <span className="truncate text-meta text-text-tertiary">{member.email}</span>
      </div>

      {canManage ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending}
              aria-label={`Ações para ${member.fullName ?? member.email}`}
            >
              {ROLE_LABEL[member.role]}
              <MoreHorizontal size={14} aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Alterar papel</DropdownMenuLabel>
            {ROLES.map((role) => (
              <DropdownMenuItem key={role} onSelect={() => changeRole(role)}>
                {ROLE_LABEL[role]}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="danger" onSelect={remove}>
              Remover da equipe
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="text-small text-text-tertiary">{ROLE_LABEL[member.role]}</span>
      )}
    </div>
  );
}
