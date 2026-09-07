import type { ReactNode } from "react";
import { Inbox, type LucideIcon } from "lucide-react";

type EmptyStateProps = {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
};

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-border bg-surface px-6 py-12 text-center">
      <div
        className="flex size-10 items-center justify-center rounded-card bg-primary-tint text-primary"
        aria-hidden
      >
        <Icon size={18} />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-body font-semibold text-text">{title}</p>
        {description ? (
          <p className="max-w-[420px] text-meta text-text-tertiary">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
