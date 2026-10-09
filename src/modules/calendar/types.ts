/**
 * Tipos de B2 que as telas de atividade compartilham (servidor e cliente).
 * Sem importar nada de servidor: este arquivo vai para o navegador.
 */

export type CalendarLinkStatus =
  | "linked"
  | "missing_in_google"
  | "cancelled_in_google"
  | "needs_attention"
  /** Sem vínculo, mas uma inclusão no Google ficou com resultado incerto. */
  | "not_linked";

/**
 * Estado da última sincronização, GRAVADO no banco (sobrevive ao recarregar):
 * `pending` = o CRM mudou e o Google ainda não (temporário, pode tentar de
 * novo); `failed` = o Google recusou de forma definitiva; `uncertain` = não se
 * sabe se o Google aplicou (consultar antes de repetir).
 */
export type CalendarSyncState = "in_sync" | "pending" | "failed" | "uncertain";

/** O que a interface sabe do vínculo de uma atividade com o Google Agenda.
 * Nunca traz título, ids de agenda/evento, e-mail da conta nem token. */
export type ActivityCalendarInfo = {
  status: CalendarLinkStatus;
  /** O vínculo é da conexão do usuário logado. */
  isMine: boolean;
  durationMinutes: number;
  meetStatus: "pending" | "success" | "failed" | null;
  meetUrl: string | null;
  lastSyncedAt: string | null;
  syncState: CalendarSyncState;
  syncOperation: "create" | "update" | "delete" | "meet" | null;
};

/** Aviso sobre o Google Agenda que acompanha o resultado de uma ação de
 * atividade. A ação no CRM já aconteceu; isto diz o que ocorreu na agenda. */
export type CalendarNotice = {
  level: "success" | "warning";
  message: string;
  meetUrl?: string | null;
};

export type CalendarCapabilities = {
  /** Há provedor de agenda configurado neste ambiente. */
  enabled: boolean;
  /** O papel do usuário permite usar a própria agenda. */
  canUse: boolean;
  /** O usuário tem conexão ativa com uma agenda escolhida. */
  hasConnection: boolean;
};

export const NO_CALENDAR: CalendarCapabilities = { enabled: false, canUse: false, hasConnection: false };

export const DEFAULT_APPOINTMENT_MINUTES = 60;
export const MIN_APPOINTMENT_MINUTES = 15;
export const MAX_APPOINTMENT_MINUTES = 480;
