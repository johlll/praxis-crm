import type { CalendarEventsApi } from "@/server/calendar/events-api";
import type { CalendarEnvironment } from "@/server/calendar/environment";
import type { LinkStatus } from "@/server/calendar/sync/types";

/**
 * Portas da sincronização Google → CRM (B2, etapa 3). Como na etapa 2, o
 * orquestrador não conhece Supabase nem HTTP: recebe um `InboundStore`
 * (RPCs; em teste, memória) e a API de eventos.
 *
 * Roda SEM sessão de usuário (agendador e webhook): toda operação age em
 * nome do DONO da conexão (`actorUserId`), e o banco confere dono, ambiente
 * e alcance por dentro.
 */

/** (conexão, agenda) com vínculo ativo no ambiente. */
export type SyncTarget = {
  connectionId: string;
  workspaceId: string;
  userId: string;
  connectionStatus: "active" | "needs_reauth" | "disconnected";
  calendarId: string;
  hasSyncToken: boolean;
  lastRunAt: string | null;
  fullSyncAt: string | null;
  dirtyAt: string | null;
  leaseUntil: string | null;
};

export type ChannelStatus = "creating" | "active" | "retiring" | "stopped" | "polling_only";

export type ChannelRecord = {
  channelId: string;
  connectionId: string;
  workspaceId: string;
  userId: string;
  connectionStatus: "active" | "needs_reauth" | "disconnected";
  calendarId: string;
  status: ChannelStatus;
  resourceId: string | null;
  expiresAt: string | null;
  renewAt: string | null;
  syncReceivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SyncLease = { leaseId: string; syncToken: string | null; fullSyncAt: string | null };

/** Vínculo da agenda, com a base e a atividade ATUAL (lidas juntas). */
export type InboundLink = {
  id: string;
  activityId: string | null;
  connectionId: string;
  environment: CalendarEnvironment;
  calendarId: string;
  eventId: string;
  status: LinkStatus;
  durationMinutes: number;
  baseEtag: string | null;
  baseTitle: string | null;
  baseStart: string | null;
  baseEnd: string | null;
  baseCancelled: boolean;
  baseHasMeet: boolean;
  meetStatus: "pending" | "success" | "failed" | null;
  meetUrl: string | null;
  activity: { title: string; dueAt: string; hasTime: boolean; type: string; lockVersion: number } | null;
};

/** Nova base do vínculo depois de aplicar o que veio do Google. */
export type InboundState = {
  etag: string;
  title: string | null;
  start: string | null;
  end: string | null;
  cancelled: boolean;
  hasMeet: boolean;
  meetStatus: "pending" | "success" | "failed" | null;
  meetUrl: string | null;
  durationMinutes: number;
  linkStatus: LinkStatus;
  /** Só os NOMES dos campos que mudaram no Google (auditoria sem valores). */
  changed: string[];
};

export type InboundConflict = { field: "title" | "schedule" | "cancellation"; crmValue: unknown; googleValue: unknown };

export type ApplyInboundResult =
  | { status: "applied"; lockVersion: number | null }
  /** A base mudou desde a leitura (outra operação gravou): reler. */
  | { status: "stale_link" }
  /** A atividade mudou no CRM desde a leitura: reler e reavaliar. */
  | { status: "stale_activity" }
  /** O dono da conexão não alcança mais a atividade: nada aplicado, vínculo para atenção. */
  | { status: "not_authorized" };

export type NotificationResult = "accepted" | "ignored" | "rejected";

export interface InboundStore {
  listMaintenance(): Promise<{ targets: SyncTarget[]; channels: ChannelRecord[] }>;

  claimSync(actorUserId: string, connectionId: string, calendarId: string, leaseSeconds?: number): Promise<SyncLease | null>;
  resetSyncToken(actorUserId: string, leaseId: string): Promise<boolean>;
  finishSync(
    actorUserId: string,
    leaseId: string,
    outcome: "success" | "failed" | "access_lost",
    opts: { syncToken?: string | undefined; full: boolean; error?: string | undefined },
  ): Promise<boolean>;

  listLinks(actorUserId: string, connectionId: string, calendarId: string): Promise<InboundLink[]>;
  applyInbound(
    actorUserId: string,
    params: {
      linkId: string;
      expectedBaseEtag: string | null;
      expectedVersion: number | null;
      title?: string | undefined;
      dueAt?: string | undefined;
      conflicts: InboundConflict[];
      state: InboundState;
    },
  ): Promise<ApplyInboundResult>;

  markNeedsReauth(actorUserId: string, connectionId: string, reason: string): Promise<void>;

  beginChannel(actorUserId: string, params: { connectionId: string; calendarId: string; channelId: string; tokenHash: string }): Promise<void>;
  activateChannel(
    actorUserId: string,
    params: { channelId: string; resourceId: string; expiresAt: string; renewAt: string | null; pollingOnly: boolean },
  ): Promise<void>;
  claimChannelRenewal(actorUserId: string, channelId: string): Promise<boolean>;
  stopChannel(actorUserId: string, channelId: string, reason: string): Promise<void>;

  recordNotification(params: {
    channelId: string;
    tokenHash: string;
    resourceId: string | null;
    resourceState: string;
    messageNumber: number | null;
    expiresAt: string | null;
  }): Promise<NotificationResult>;
}

export type InboundDeps = {
  api: CalendarEventsApi;
  store: InboundStore;
  /** Ambiente em que o SERVIDOR está operando. */
  environment: CalendarEnvironment;
  now: () => Date;
};

/** Contexto de chamada ao Google em nome do dono da conexão, numa agenda. */
export type InboundConnection = {
  connectionId: string;
  userId: string;
  calendarId: string;
  environment: CalendarEnvironment;
  accessToken: string;
};
