"use client";

import { useState, useTransition } from "react";
import { Check, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  completeActivityAction,
  deleteActivityAction,
  reassignActivityAction,
} from "@/modules/activities/actions";
import type { ActivityListItem } from "@/modules/activities/queries";
import type { TeamMember } from "@/modules/team/queries";
import { EditActivityDialog } from "./edit-activity-dialog";
import { RescheduleActivityDialog } from "./reschedule-activity-dialog";

export function ActivityRowActions({
  activity,
  members,
}: {
  activity: ActivityListItem;
  members: TeamMember[];
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const scope = {
    leadId: activity.leadId,
    ...(activity.opportunityId ? { opportunityId: activity.opportunityId } : {}),
  };

  function handleComplete() {
    setError(null);
    startTransition(async () => {
      const result = await completeActivityAction(activity.id, activity.lockVersion, scope);
      if (!result.ok) setError(result.error ?? "Não foi possível concluir.");
    });
  }

  function handleReassign(nextAssignedTo: string) {
    setError(null);
    startTransition(async () => {
      const result = await reassignActivityAction(activity.id, activity.lockVersion, nextAssignedTo || null, scope);
      if (!result.ok) setError(result.error ?? "Não foi possível transferir.");
    });
  }

  function handleDelete() {
    if (!window.confirm(`Excluir "${activity.title}"? Esta ação não pode ser desfeita.`)) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteActivityAction(activity.id, scope);
      if (!result.ok) setError(result.error ?? "Não foi possível excluir.");
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {activity.status === "pending" ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            aria-label={`Concluir ${activity.title}`}
            onClick={handleComplete}
          >
            <Check size={14} aria-hidden />
          </Button>
        ) : null}

        <label className="sr-only" htmlFor={`reassign-${activity.id}`}>
          Transferir {activity.title} para
        </label>
        <select
          id={`reassign-${activity.id}`}
          value={activity.assignedTo ?? ""}
          disabled={isPending}
          onChange={(e) => handleReassign(e.target.value)}
          className="h-7 rounded-input border border-border-input bg-surface px-1.5 text-meta text-text"
        >
          <option value="">Sem responsável</option>
          {members.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.fullName ?? member.email}
            </option>
          ))}
        </select>

        {activity.status === "pending" ? <RescheduleActivityDialog activity={activity} /> : null}
        <EditActivityDialog activity={activity} />
        <Button
          variant="ghost"
          size="sm"
          disabled={isPending}
          aria-label={`Excluir ${activity.title}`}
          onClick={handleDelete}
        >
          <Trash2 size={14} aria-hidden />
        </Button>
      </div>
      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
