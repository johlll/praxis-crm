import type { InboundConflict, InboundLink, InboundState } from "@/server/calendar/sync/inbound-types";
import type { LinkStatus } from "@/server/calendar/sync/types";

/**
 * Google → CRM, por campo, contra a BASE da última sincronização (§6.3/6.4).
 * Função pura: nenhuma chamada externa.
 *
 *  - mudou só no Google → aplica no CRM;
 *  - mudou nos dois, para valores diferentes → conflito: o Google prevalece e
 *    o valor do CRM é GRAVADO (nunca descartado em silêncio);
 *  - mudou só no CRM → nada é aplicado aqui e a base desse campo NÃO avança
 *    (a mudança do CRM continua pendente para a sincronização de saída);
 *  - igual à base → nada (é o eco de uma escrita do próprio CRM: sem laço).
 *
 * O CRM só conhece o INÍCIO do compromisso; a duração é a real do evento.
 */

export type GoogleSnapshot = {
  etag: string;
  cancelled: boolean;
  title: string | null;
  start: string | null;
  end: string | null;
  hasMeet: boolean;
  meetStatus: "pending" | "success" | "failed" | null;
  meetUrl: string | null;
};

export type InboundPlan = {
  /** Valores do Google a aplicar na atividade. */
  title?: string | undefined;
  dueAt?: string | undefined;
  conflicts: InboundConflict[];
  state: InboundState;
};

const sameInstant = (a: string | null, b: string | null): boolean =>
  a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b));

const addMinutes = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

function durationOf(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

function baseState(link: InboundLink, etag: string, linkStatus: LinkStatus, changed: string[]): InboundState {
  return {
    etag,
    title: link.baseTitle,
    start: link.baseStart,
    end: link.baseEnd,
    cancelled: link.baseCancelled,
    hasMeet: link.baseHasMeet,
    meetStatus: link.meetStatus,
    meetUrl: link.meetUrl,
    durationMinutes: link.durationMinutes,
    linkStatus,
    changed,
  };
}

/** Só a base avança para o `etag` novo e o vínculo muda de estado (sem tocar o CRM). */
export function planStatusOnly(link: InboundLink, etag: string, linkStatus: LinkStatus, changed: string[] = []): InboundPlan {
  return { conflicts: [], state: baseState(link, etag, linkStatus, changed) };
}

export function planInbound(link: InboundLink, google: GoogleSnapshot): InboundPlan {
  const activity = link.activity;
  const base = { title: link.baseTitle, start: link.baseStart, end: link.baseEnd };

  // Cancelado no Google: a atividade NÃO é apagada; uma edição do CRM desde a
  // base fica registrada como conflito.
  if (google.cancelled) {
    const conflicts: InboundConflict[] = [];
    if (activity && (activity.title !== base.title || !sameInstant(activity.dueAt, base.start))) {
      conflicts.push({
        field: "cancellation",
        crmValue: { title: activity.title, start: activity.dueAt },
        googleValue: { cancelled: true },
      });
    }
    return {
      conflicts,
      state: { ...baseState(link, google.etag, "cancelled_in_google", ["cancellation"]), cancelled: true },
    };
  }

  const conflicts: InboundConflict[] = [];
  const changed: string[] = [];
  let title: string | undefined;
  let dueAt: string | undefined;

  // Título.
  const googleTitleChanged = google.title !== base.title;
  if (googleTitleChanged) {
    changed.push("title");
    const crmTitleChanged = activity !== null && activity.title !== base.title;
    if (google.title && activity) {
      if (!crmTitleChanged) title = google.title;
      else if (activity.title !== google.title) {
        title = google.title;
        conflicts.push({ field: "title", crmValue: activity.title, googleValue: google.title });
      }
    }
  }

  // Horário: início e fim juntos. O CRM só tem o início.
  const googleScheduleChanged = !sameInstant(google.start, base.start) || !sameInstant(google.end, base.end);
  const googleStartChanged = !sameInstant(google.start, base.start);
  if (googleScheduleChanged) changed.push("schedule");
  if (googleStartChanged && google.start && activity) {
    const crmStartChanged = !sameInstant(activity.dueAt, base.start);
    if (!crmStartChanged) dueAt = google.start;
    else if (!sameInstant(activity.dueAt, google.start)) {
      dueAt = google.start;
      conflicts.push({
        field: "schedule",
        crmValue: { start: activity.dueAt, end: addMinutes(activity.dueAt, link.durationMinutes) },
        googleValue: { start: google.start, end: google.end },
      });
    }
  }

  // Meet: o que o Google tem é adotado (removido lá = removido aqui; nunca
  // recriado sozinho).
  if (google.hasMeet !== link.baseHasMeet || google.meetUrl !== link.meetUrl || google.meetStatus !== link.meetStatus) {
    changed.push("meet");
  }

  return {
    title,
    dueAt,
    conflicts,
    state: {
      etag: google.etag,
      title: googleTitleChanged ? google.title : base.title,
      start: googleScheduleChanged ? google.start : base.start,
      end: googleScheduleChanged ? google.end : base.end,
      cancelled: false,
      hasMeet: google.hasMeet,
      meetStatus: google.meetStatus,
      meetUrl: google.meetUrl,
      // Duração REAL do evento, mesmo fora de 15–480 (regra da etapa 2).
      durationMinutes: googleScheduleChanged ? (durationOf(google.start, google.end) ?? link.durationMinutes) : link.durationMinutes,
      linkStatus: "linked",
      changed,
    },
  };
}
