"use client";

import { CalendarCheck, TriangleAlert, Video } from "lucide-react";

import type { ActivityCalendarInfo } from "@/modules/calendar/types";

const STATUS_TEXT: Record<ActivityCalendarInfo["status"], string> = {
  linked: "No Google Agenda",
  needs_attention: "Google Agenda: pendente",
  cancelled_in_google: "Cancelado no Google Agenda",
  missing_in_google: "Evento não encontrado no Google Agenda",
};

/** Selo discreto do estado do compromisso na agenda (e o link do Meet). */
export function CalendarBadge({ info }: { info: ActivityCalendarInfo | null | undefined }) {
  if (!info) return null;
  const problem = info.status !== "linked";
  const Icon = problem ? TriangleAlert : CalendarCheck;

  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-label">
      <span
        className={problem ? "inline-flex items-center gap-1 text-warning" : "inline-flex items-center gap-1 text-text-tertiary"}
        data-testid="calendar-badge"
      >
        <Icon size={12} aria-hidden />
        {STATUS_TEXT[info.status]}
        {info.isMine ? "" : " · agenda de outra pessoa"}
      </span>
      {info.meetUrl ? (
        <a
          href={info.meetUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          <Video size={12} aria-hidden />
          Entrar no Meet
        </a>
      ) : info.meetStatus === "pending" ? (
        <span className="inline-flex items-center gap-1 text-text-tertiary">
          <Video size={12} aria-hidden />
          Meet sendo criado…
        </span>
      ) : null}
    </span>
  );
}
