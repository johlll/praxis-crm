import { AUTOMATION_STATUS_LABEL, type AutomationStatus } from "@/modules/automations/schema";

const STATUS_CLASS: Record<AutomationStatus, string> = {
  draft: "border border-border bg-surface text-text-secondary",
  active: "bg-success-bg text-success",
  paused: "bg-warning-bg text-warning",
  archived: "border border-border bg-surface text-text-tertiary",
};

/** Estado da regra: rascunho, ativa, pausada ou arquivada. */
export function AutomationStatusBadge({ status }: { status: AutomationStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-meta font-medium ${STATUS_CLASS[status]}`}>
      {AUTOMATION_STATUS_LABEL[status]}
    </span>
  );
}
