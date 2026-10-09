import { Alert, AlertDescription } from "@/components/ui/alert";
import type { HealthNotice } from "@/modules/calendar/health";

/** Detector 2 (§9.3): avisos de sincronização atrasada para owner/admin. */
export function CalendarHealthNotices({ notices }: { notices: HealthNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="calendar-health">
      {notices.map((notice) => (
        <Alert key={notice.message} variant={notice.level === "warning" ? "warning" : "default"}>
          <AlertDescription>{notice.message}</AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
