"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/timezone";
import { ACTIVITY_TYPE_LABEL } from "@/components/activities/labels";
import { completeActivityAction } from "@/modules/activities/actions";
import type { AgendaItem } from "@/modules/dashboard/queries";

function AgendaRow({ item, canEdit }: { item: AgendaItem; canEdit: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const done = item.status === "done";

  function complete() {
    setError(null);
    startTransition(async () => {
      const result = await completeActivityAction(item.id, item.lockVersion, {
        leadId: item.leadId,
        ...(item.opportunityId ? { opportunityId: item.opportunityId } : {}),
      });
      if (!result.ok) {
        setError(result.error ?? "Não foi possível concluir.");
        return;
      }
      router.refresh();
    });
  }

  const when = item.hasTime ? formatTime(item.dueAt) : "Até o fim do dia";

  return (
    <li className="flex items-start gap-3 border-b border-border-subtle py-2.5 last:border-b-0">
      {canEdit && !done ? (
        <input
          type="checkbox"
          checked={false}
          disabled={pending}
          onChange={complete}
          aria-label={`Concluir "${item.title}"`}
          className="mt-0.5 size-4 shrink-0 accent-primary"
        />
      ) : (
        <span
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0 rounded-sm border",
            done ? "border-primary bg-primary" : "border-border-input bg-surface",
          )}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <Link href={`/leads/${item.leadId}`} className={cn("truncate text-body font-semibold text-text", done && "line-through text-text-tertiary")}>
          {ACTIVITY_TYPE_LABEL[item.type]}: {item.title} — {item.contactName}
        </Link>
        <span className="text-meta text-text-tertiary">
          {when} · {item.assignedToName ?? "Sem responsável"}
          {done ? " · concluída" : ""}
        </span>
        {error ? (
          <span role="alert" className="text-meta text-danger">
            {error}
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function AgendaToday({
  items,
  total,
  pending,
  canEdit,
}: {
  items: AgendaItem[];
  total: number;
  pending: number;
  canEdit: boolean;
}) {
  return (
    <section aria-labelledby="agenda-titulo" className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="agenda-titulo" className="m-0 text-body font-bold text-text">
          Agenda de hoje
        </h2>
        <span className="text-meta text-text-muted">
          {pending} pendente{pending === 1 ? "" : "s"} de {total}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="m-0 py-4 text-body text-text-secondary">Nada com prazo para hoje.</p>
      ) : (
        <ul className="m-0 max-h-[340px] list-none overflow-y-auto p-0">
          {items.map((item) => (
            <AgendaRow key={item.id} item={item} canEdit={canEdit} />
          ))}
        </ul>
      )}
      {items.length < total ? (
        <Link href="/atividades?filter=today" className="pt-1 text-meta">
          Mostrando {items.length} de {total} · ver pendentes de hoje na Central de Atividades
        </Link>
      ) : null}
    </section>
  );
}
