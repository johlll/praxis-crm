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

/**
 * Estado gravado no vínculo ao fechar uma intenção.
 *
 * Os campos do Meet (`meetStatus`, `meetUrl`, `meetRequestId`) seguem a
 * mesma regra no banco: chave AUSENTE preserva o valor guardado; chave
 * presente — inclusive `null` — o substitui. `null` significa "removido".
 */
export type LinkState = {
  eventId: string;
  etag: string | null;
  title: string | null;
  start: string | null;
  end: string | null;
  cancelled: boolean;
  hasMeet: boolean;
  meetStatus?: "pending" | "success" | "failed" | null;
  meetUrl?: string | null;
  meetRequestId?: string | null;
  durationMinutes: number;
  crmVersion: number | null;
  linkStatus: LinkStatus;
};

export type EffectOperation = "create" | "update" | "delete" | "meet";

export type ConflictResolution = "google_prevails" | "crm_prevails" | "kept_google_event" | "needs_attention";

/** Agenda e evento EFETIVAMENTE usados na chamada ao Google. */
export type EffectTarget = { calendarId: string; eventId: string };

/**
 * A inclusão mais recente ainda sem desfecho de uma atividade, com a
 * identidade gravada ANTES da chamada ao Google. De outra pessoa, só o fato
 * de existir. `calendarId`/`eventId` nulos = intenção sem alvo registrado
 * (não há como concluir nada sobre ela). `settled`: incerta, ou parada há
 * tempo suficiente para não estar mais em andamento.
 */
export type OpenCreateIntent =
  | { isMine: false }
  | {
      isMine: true;
      intentId: string;
      workspaceId: string;
      environment: CalendarEnvironment;
      connectionId: string;
      calendarId: string | null;
      eventId: string | null;
      status: "pending" | "uncertain";
      settled: boolean;
    };

export interface SyncStore {
  getLink(activityId: string): Promise<LinkRecord | null>;
  beginEffect(params: {
    connectionId: string;
    activityId: string;
    operation: EffectOperation;
    expected: Record<string, unknown>;
    /** Obrigatório na inclusão: gravado antes da chamada, é o que a
     * verificação de um resultado incerto consulta depois. */
    target?: EffectTarget | undefined;
  }): Promise<string>;
  getOpenCreateIntent(activityId: string): Promise<OpenCreateIntent | null>;
  resolveEffect(params: {
    intentId: string;
    status: "succeeded" | "failed" | "uncertain";
    errorCode?: string | undefined;
    state?: LinkState | undefined;
    /** Numa falha: `pending` (temporária, dá para tentar de novo) ou `failed`
     * (recusa definitiva). Fica gravado no vínculo, visível depois de recarregar. */
    syncState?: "pending" | "failed" | undefined;
  }): Promise<string | null>;
  /** Pendência sem intenção (a sincronização nem chegou a começar, ex.:
   * conexão a reautorizar), depois de o CRM já ter salvo. `false` = não havia
   * vínculo ativo da conexão do usuário. */
  markLinkPending(params: { activityId: string; reason: string }): Promise<boolean>;
  recordConflict(params: {
    linkId: string;
    field: "title" | "schedule" | "cancellation" | "meet";
    crmValue: unknown;
    googleValue: unknown;
    resolution: ConflictResolution;
  }): Promise<void>;
  /**
   * Aplica o valor do Google à atividade (conflito em que o Google vence) e
   * grava, NA MESMA transação, o valor do CRM que perdeu. Só aplica se a
   * atividade ainda está na `expectedVersion` lida: se o CRM foi editado
   * depois da leitura, não aplica nada, não grava conflito e devolve `null`
   * — quem chamou relê a atividade e reavalia.
   */
  applyGoogleToActivity(params: {
    activityId: string;
    expectedVersion: number;
    title?: string | undefined;
    dueAt?: string | undefined;
    conflicts: Array<{ field: "title" | "schedule"; crmValue: unknown; googleValue: unknown }>;
  }): Promise<number | null>;
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
  /** Relê a atividade pela SESSÃO do usuário (alcance e RLS de verdade). */
  loadActivity: (activityId: string) => Promise<ActivitySnapshot | null>;
};

export class CalendarSyncError extends Error {
  constructor(
    public readonly code:
      | "calendar_environment_mismatch"
      | "activity_not_appointment"
      | "invites_require_confirmation"
      | "invalid_duration"
      | "not_linked"
      | "link_connection_mismatch"
      | "activity_not_found"
      | "create_outcome_uncertain",
  ) {
    super(code);
    this.name = "CalendarSyncError";
  }
}
