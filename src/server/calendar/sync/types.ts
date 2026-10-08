import type { CalendarEventsApi } from "@/server/calendar/events-api";
import type { CalendarEnvironment } from "@/server/calendar/environment";

/**
 * Portas da sincronização CRM → Google (B2, etapa 2). O orquestrador não
 * conhece Supabase nem HTTP: recebe um `SyncStore` (persistência) e um
 * `CalendarEventsApi` (Google). Em produção, o primeiro é o adaptador de
 * RPCs e o segundo, o provedor; nos testes, versões em memória.
 */

export type LinkStatus = "linked" | "missing_in_google" | "cancelled_in_google" | "unlinked" | "needs_attention";

export type LinkRecord = {
  id: string;
  connectionId: string;
  environment: CalendarEnvironment;
  calendarId: string;
  eventId: string;
  generation: number;
  status: LinkStatus;
  durationMinutes: number;
  baseEtag: string | null;
  baseTitle: string | null;
  baseStart: string | null;
  baseEnd: string | null;
  baseCancelled: boolean;
  baseHasMeet: boolean;
  baseCrmVersion: number | null;
  meetRequestId: string | null;
  meetStatus: "pending" | "success" | "failed" | null;
  meetUrl: string | null;
};

/** Estado gravado no vínculo ao fechar uma intenção. */
export type LinkState = {
  eventId: string;
  etag: string | null;
  title: string | null;
  start: string | null;
  end: string | null;
  cancelled: boolean;
  hasMeet: boolean;
  meetStatus?: "pending" | "success" | "failed" | undefined;
  meetUrl?: string | null | undefined;
  meetRequestId?: string | null | undefined;
  durationMinutes: number;
  crmVersion: number | null;
  linkStatus: LinkStatus;
};

export type EffectOperation = "create" | "update" | "delete" | "meet";

export type ConflictResolution = "google_prevails" | "crm_prevails" | "kept_google_event" | "needs_attention";

export interface SyncStore {
  getLink(activityId: string): Promise<LinkRecord | null>;
  beginEffect(params: {
    connectionId: string;
    activityId: string;
    operation: EffectOperation;
    expected: Record<string, unknown>;
  }): Promise<string>;
  resolveEffect(params: {
    intentId: string;
    status: "succeeded" | "failed" | "uncertain";
    errorCode?: string | undefined;
    state?: LinkState | undefined;
  }): Promise<string | null>;
  recordConflict(params: {
    linkId: string;
    field: "title" | "schedule" | "cancellation" | "meet";
    crmValue: unknown;
    googleValue: unknown;
    resolution: ConflictResolution;
  }): Promise<void>;
  /** Aplica o valor do Google à atividade (conflito em que o Google vence). */
  applyGoogleToActivity(params: { activityId: string; title?: string | undefined; dueAt?: string | undefined }): Promise<number>;
}

/** Atividade do CRM, como a camada de ação a leu na sessão do usuário. */
export type ActivitySnapshot = {
  id: string;
  title: string;
  /** Instante ISO do início. */
  dueAt: string;
  hasTime: boolean;
  type: string;
  lockVersion: number;
};

export type ConnectionContext = {
  connectionId: string;
  calendarId: string;
  environment: CalendarEnvironment;
  accessToken: string;
};

export type SyncDeps = {
  api: CalendarEventsApi;
  store: SyncStore;
  /** Ambiente em que o SERVIDOR está operando (nunca vindo do cliente). */
  environment: CalendarEnvironment;
};

export class CalendarSyncError extends Error {
  constructor(
    public readonly code:
      | "calendar_environment_mismatch"
      | "activity_not_appointment"
      | "invites_require_confirmation"
      | "invalid_duration"
      | "not_linked",
  ) {
    super(code);
    this.name = "CalendarSyncError";
  }
}
