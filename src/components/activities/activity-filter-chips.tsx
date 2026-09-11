import Link from "next/link";

import { cn } from "@/lib/cn";
import type { ActivityCounts, ActivityFilter } from "@/modules/activities/queries";

const CHIPS: { value: ActivityFilter | null; label: string; countKey: keyof ActivityCounts | null }[] = [
  { value: null, label: "Todas", countKey: null },
  { value: "overdue", label: "Atrasadas", countKey: "overdue" },
  { value: "today", label: "Hoje", countKey: "today" },
  { value: "tomorrow", label: "Amanhã", countKey: "tomorrow" },
  { value: "week", label: "Esta semana", countKey: "week" },
  { value: "unassigned", label: "Sem responsável", countKey: "unassigned" },
];

function href(filter: ActivityFilter | null, status: string): string {
  const params = new URLSearchParams();
  if (filter) params.set("filter", filter);
  if (status === "done") params.set("status", "done");
  const qs = params.toString();
  return qs ? `/atividades?${qs}` : "/atividades";
}

export function ActivityFilterChips({
  activeFilter,
  activeStatus,
  counts,
}: {
  activeFilter: string | null;
  activeStatus: string;
  counts: ActivityCounts;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {CHIPS.map((chip) => {
        const active = activeStatus !== "done" && activeFilter === (chip.value ?? "");
        const count = chip.countKey ? counts[chip.countKey] : null;
        return (
          <Link
            key={chip.label}
            href={href(chip.value, activeStatus) as never}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-meta font-medium no-underline transition-colors",
              active
                ? "border-primary bg-primary-tint text-primary"
                : "border-border bg-surface text-text-secondary hover:bg-app hover:no-underline",
            )}
          >
            {chip.label}
            {count !== null ? (
              <span
                className={cn(
                  "rounded-full px-1.5 text-label font-bold leading-[16px]",
                  active ? "bg-primary text-white" : "bg-app text-text-tertiary",
                )}
              >
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
      <Link
        href={href(null, "done") as never}
        className={cn(
          "rounded-full border px-3 py-1.5 text-meta font-medium no-underline transition-colors",
          activeStatus === "done"
            ? "border-primary bg-primary-tint text-primary"
            : "border-border bg-surface text-text-secondary hover:bg-app hover:no-underline",
        )}
      >
        Concluídas
      </Link>
    </div>
  );
}
