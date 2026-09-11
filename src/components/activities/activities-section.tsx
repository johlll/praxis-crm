import type { ActivityListItem } from "@/modules/activities/queries";
import type { TeamMember } from "@/modules/team/queries";
import { formatDue } from "@/lib/timezone";
import { ACTIVITY_TYPE_LABEL } from "./labels";
import { ActivityRowActions } from "./activity-row-actions";
import { CreateActivityDialog } from "./create-activity-dialog";

/**
 * Lista compacta de atividades, embutida no painel da oportunidade ou do
 * lead — mesma lógica de ActivityRowActions da Central, só com um layout
 * de lista em vez de tabela (mais estreito, cabe na coluna de detalhe).
 */
export function ActivitiesSection({
  leadId,
  opportunityId,
  activities,
  members,
  canEdit,
}: {
  leadId: string;
  opportunityId?: string;
  activities: ActivityListItem[];
  members: TeamMember[];
  canEdit: boolean;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-body font-semibold text-text">
          Atividades {activities.length > 0 ? `(${activities.length})` : ""}
        </h2>
        {canEdit ? (
          <CreateActivityDialog
            leadId={leadId}
            members={members}
            {...(opportunityId ? { opportunityId } : {})}
          />
        ) : null}
      </div>

      {activities.length === 0 ? (
        <p className="text-body text-text-tertiary">Nenhuma atividade ainda.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {activities.map((activity) => {
            const { isOverdue } = activity;
            return (
              <li key={activity.id} className="flex flex-col gap-1.5 rounded-input border border-border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className={activity.status === "done" ? "text-text-tertiary line-through" : "font-medium text-text"}>
                    {activity.title}
                  </span>
                  <span className="shrink-0 text-meta text-text-tertiary">{ACTIVITY_TYPE_LABEL[activity.type]}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className={isOverdue ? "text-meta font-semibold text-danger" : "text-meta text-text-tertiary"}>
                    {formatDue(activity.dueAt, activity.hasTime)}
                    {isOverdue ? " · atrasada" : ""}
                  </span>
                  <span className="text-meta text-text-tertiary">{activity.assignedToName ?? "Sem responsável"}</span>
                </div>
                {canEdit ? <ActivityRowActions activity={activity} members={members} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
