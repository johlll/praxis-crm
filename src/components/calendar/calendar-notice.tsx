"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import type { CalendarNotice } from "@/modules/calendar/types";

/** Aviso do que aconteceu no Google Agenda depois de uma ação de atividade. */
export function CalendarNoticeAlert({ notice }: { notice: CalendarNotice | null | undefined }) {
  if (!notice) return null;
  return (
    <Alert variant={notice.level === "warning" ? "warning" : "success"} data-testid="calendar-notice">
      <AlertDescription>
        {notice.message}
        {notice.meetUrl ? (
          <>
            {" "}
            <a href={notice.meetUrl} target="_blank" rel="noopener noreferrer" className="underline">
              Link do Meet
            </a>
          </>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
