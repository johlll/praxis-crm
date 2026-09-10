"use client";

import Link from "next/link";

import type { ActivityListItem } from "@/modules/activities/queries";
import type { TeamMember } from "@/modules/team/queries";
import { formatDue } from "@/lib/timezone";
import { ACTIVITY_TYPE_LABEL, PRIORITY_LABEL } from "./labels";
import { ActivityRowActions } from "./activity-row-actions";

const PRIORITY_DOT: Record<ActivityListItem["priority"], string> = {
  baixa: "bg-text-tertiary",
  media: "bg-warning",
  alta: "bg-danger",
};

export function ActivityListTable({
  items,
  members,
  canEdit,
}: {
  items: ActivityListItem[];
  members: TeamMember[];
  canEdit: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-left text-body">
        <thead>
          <tr className="border-b border-border text-meta text-text-tertiary">
            <th className="px-4 py-2.5 font-medium">Atividade</th>
            <th className="px-4 py-2.5 font-medium">Lead</th>
            <th className="px-4 py-2.5 font-medium">Vencimento</th>
            <th className="px-4 py-2.5 font-medium">Responsável</th>
            {canEdit ? <th className="px-4 py-2.5 font-medium">Ações</th> : null}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const { isOverdue } = item;
            return (
              <tr key={item.id} className="border-b border-border last:border-0 hover:bg-app">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-2 shrink-0 rounded-full ${PRIORITY_DOT[item.priority]}`}
                      aria-label={`Prioridade ${PRIORITY_LABEL[item.priority]}`}
                      title={`Prioridade ${PRIORITY_LABEL[item.priority]}`}
                    />
                    <div className="flex flex-col">
                      <span className={item.status === "done" ? "text-text-tertiary line-through" : "font-medium text-text"}>
                        {item.title}
                      </span>
                      <span className="text-meta text-text-tertiary">{ACTIVITY_TYPE_LABEL[item.type]}</span>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-text-secondary">
                  <Link href={`/leads/${item.leadId}`} className="hover:underline">
                    {item.contactName}
                  </Link>
                  {item.opportunityId ? (
                    <>
                      {" · "}
                      <Link href={`/oportunidades/${item.opportunityId}`} className="text-meta text-primary hover:underline">
                        oportunidade
                      </Link>
                    </>
                  ) : null}
                </td>
                <td className={`px-4 py-2.5 ${isOverdue ? "font-semibold text-danger" : "text-text-secondary"}`}>
                  {formatDue(item.dueAt, item.hasTime)}
                  {isOverdue ? " · atrasada" : ""}
                </td>
                <td className="px-4 py-2.5 text-text-secondary">{item.assignedToName ?? "Sem responsável"}</td>
                {canEdit ? (
                  <td className="px-4 py-2.5">
                    <ActivityRowActions activity={item} members={members} />
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
