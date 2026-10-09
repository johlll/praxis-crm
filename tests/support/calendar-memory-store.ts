import type { CalendarEnvironment } from "@/server/calendar/environment";
import type {
  ActivitySnapshot,
  ConflictResolution,
  EffectOperation,
  EffectTarget,
  LinkRecord,
  LinkState,
  OpenCreateIntent,
  SyncStore,
} from "@/server/calendar/sync/types";

/**
 * Persistência em memória, com a mesma semântica das RPCs (`begin/
 * resolve_calendar_effect`, `get_calendar_link`, `record_calendar_conflict`):
 * só existe para os testes do orquestrador. O banco real é coberto pelo
 * pgTAP (`22_b2_appointment_sync`).
 */
export type StoredIntent = {
  id: string;
  connectionId: string;
  activityId: string;
  operation: EffectOperation;
  expected: Record<string, unknown>;
  status: "pending" | "succeeded" | "failed" | "uncertain" | "superseded";
  errorCode?: string | undefined;
  /** Identidade gravada ANTES da chamada (como no banco). */
  createdBy: string;
  createdAt: number;
  calendarId: string | null;
  eventId: string | null;
};

/** Pendente há mais que isto já não está "em andamento" (como no banco). */
const SETTLE_MS = 2 * 60_000;

/** Estado de sincronização do vínculo (mesma regra da migration da etapa 2b). */
export type StoredSync = {
  syncState?: "in_sync" | "pending" | "failed" | "uncertain";
  syncOperation?: EffectOperation | null;
  syncError?: string | null;
};

export type StoredConflict = {
  linkId: string;
  field: string;
  crmValue: unknown;
  googleValue: unknown;
  resolution: ConflictResolution;
};

export class MemoryStore implements SyncStore {
  links = new Map<string, LinkRecord & { activityId: string } & StoredSync>();
  /** Pendências marcadas sem intenção (preparação/conexão falhou depois de salvar no CRM). */
  pendingMarks: Array<{ activityId: string; reason: string }> = [];
  intents: StoredIntent[] = [];
  conflicts: StoredConflict[] = [];
  appliedToActivity: Array<{ activityId: string; title?: string | undefined; dueAt?: string | undefined }> = [];
  /** Toda tentativa de aplicar valores do Google, com a versão esperada. */
  applyAttempts: Array<{ activityId: string; expectedVersion: number | undefined; applied: boolean }> = [];
  /** Atividades do CRM simuladas (só as registradas têm controle de versão). */
  activities = new Map<string, ActivitySnapshot>();
  /** Usuário em nome de quem o store age (o adaptador real recebe o da sessão). */
  actor = "user-1";
  private beforeApply: (() => void) | undefined;
  /** Agenda SELECIONADA de cada conexão (o banco a lê da conexão, ao criar o vínculo). */
  private selectedCalendar = new Map<string, string>();
  private seq = 0;

  constructor(
    readonly environment: CalendarEnvironment,
    private readonly calendarId = "principal@calendar.simulated",
  ) {}

  async getLink(activityId: string): Promise<LinkRecord | null> {
    const link = [...this.links.values()].find((l) => l.activityId === activityId && l.status !== "unlinked");
    return link ? structuredClone(link) : null;
  }

  async beginEffect(params: {
    connectionId: string;
    activityId: string;
    operation: EffectOperation;
    expected: Record<string, unknown>;
    target?: EffectTarget | undefined;
  }): Promise<string> {
    const { target, ...rest } = params;
    let calendarId: string | null;
    let eventId: string | null;
    if (params.operation === "create") {
      // Como no banco: a inclusão grava a agenda selecionada e o evento; só
      // uma inclusão sem desfecho por atividade.
      if (!target?.calendarId || !target.eventId) throw new Error("calendar_target_required");
      if (target.calendarId !== this.selectedCalendarOf(params.connectionId)) throw new Error("calendar_selection_changed");
      if (this.openCreates(params.activityId).length > 0) throw new Error("create_outcome_uncertain");
      ({ calendarId, eventId } = target);
    } else {
      // Demais operações: o alvo é o do vínculo ativo.
      const link = [...this.links.values()].find((l) => l.activityId === params.activityId && l.status !== "unlinked");
      calendarId = link?.calendarId ?? null;
      eventId = link?.eventId ?? null;
    }
    this.seq += 1;
    const id = `intent-${this.seq}`;
    this.intents.push({ id, ...rest, status: "pending", createdBy: this.actor, createdAt: Date.now(), calendarId, eventId });
    return id;
  }

  async getOpenCreateIntent(activityId: string): Promise<OpenCreateIntent | null> {
    const intent = this.openCreates(activityId).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!intent) return null;
    if (intent.createdBy !== this.actor) return { isMine: false };
    return {
      isMine: true,
      intentId: intent.id,
      workspaceId: "workspace-1",
      environment: this.environment,
      connectionId: intent.connectionId,
      calendarId: intent.calendarId,
      eventId: intent.eventId,
      status: intent.status as "pending" | "uncertain",
      settled: intent.status === "uncertain" || intent.createdAt < Date.now() - SETTLE_MS,
    };
  }

  async resolveEffect(params: {
    intentId: string;
    status: "succeeded" | "failed" | "uncertain";
    errorCode?: string | undefined;
    state?: LinkState | undefined;
    syncState?: "pending" | "failed" | undefined;
  }): Promise<string | null> {
    const intent = this.intents.find((i) => i.id === params.intentId);
    // Como no banco: só quem abriu a intenção a resolve.
    if (!intent || intent.createdBy !== this.actor) throw new Error("intent_not_found");
    // Idempotente: resultado definitivo não é reescrito.
    if (intent.status === "succeeded" || intent.status === "failed" || intent.status === "superseded") return null;
    // Inclusão concluída só no alvo gravado.
    if (params.status === "succeeded" && intent.operation === "create") {
      if (!intent.calendarId || !intent.eventId) throw new Error("intent_target_unknown");
      if (params.state?.eventId !== intent.eventId) throw new Error("intent_target_mismatch");
    }
    intent.status = params.status;
    intent.errorCode = params.errorCode;

    // Como no banco: um desfecho definitivo encerra intenções ainda abertas do
    // MESMO alvo (conexão, agenda e evento) — não basta ser da mesma atividade.
    if (params.status !== "uncertain" && intent.calendarId && intent.eventId) {
      for (const other of this.intents) {
        if (
          other !== intent &&
          other.connectionId === intent.connectionId &&
          other.calendarId === intent.calendarId &&
          other.eventId === intent.eventId &&
          (other.status === "uncertain" || other.status === "pending")
        ) {
          other.status = "superseded";
        }
      }
    }

    const active = () =>
      [...this.links.values()].find(
        (l) => l.activityId === intent.activityId && l.status !== "unlinked" && l.connectionId === intent.connectionId,
      );

    if (params.status !== "succeeded") {
      // Como no banco: falha ou incerteza ficam GRAVADAS no vínculo ativo
      // (visíveis depois de recarregar); perda de acesso o marca como pendente.
      const link = active();
      if (link) {
        if (params.status === "failed" && params.state?.linkStatus === "needs_attention") link.status = "needs_attention";
        link.syncState = params.status === "uncertain" ? "uncertain" : (params.syncState ?? "failed");
        link.syncOperation = intent.operation;
        link.syncError = params.errorCode ?? null;
      }
      return null;
    }
    if (!params.state) return null;

    // Como no banco: o estado viaja como JSON — chave AUSENTE preserva o valor
    // guardado; chave presente (inclusive null) o substitui.
    const s = JSON.parse(JSON.stringify(params.state)) as LinkState;
    // Como no banco: o vínculo ativo da atividade; sem ele, o da agenda DA
    // TENTATIVA (não a selecionada agora).
    const calendarId = intent.calendarId ?? this.selectedCalendarOf(intent.connectionId);
    const existing =
      active() ?? [...this.links.values()].find((l) => l.calendarId === calendarId && l.eventId === s.eventId);
    const pick = <K extends "meetRequestId" | "meetStatus" | "meetUrl">(key: K, fallback: LinkRecord[K] | undefined): LinkRecord[K] =>
      (key in s ? (s[key] ?? null) : (fallback ?? null)) as LinkRecord[K];
    const next = {
      status: s.linkStatus,
      durationMinutes: s.durationMinutes,
      baseEtag: s.etag,
      baseTitle: s.title,
      baseStart: s.start,
      baseEnd: s.end,
      baseCancelled: s.cancelled,
      baseHasMeet: s.hasMeet,
      baseCrmVersion: s.crmVersion,
      meetRequestId: pick("meetRequestId", existing?.meetRequestId),
      meetStatus: pick("meetStatus", existing?.meetStatus),
      meetUrl: pick("meetUrl", existing?.meetUrl),
    };
    if (existing) {
      Object.assign(existing, next, { syncState: "in_sync", syncOperation: null, syncError: null });
      return existing.id;
    }
    this.seq += 1;
    const link = {
      id: `link-${this.seq}`,
      activityId: intent.activityId,
      connectionId: intent.connectionId,
      environment: this.environment,
      calendarId,
      eventId: s.eventId,
      generation: 1,
      ...next,
      syncState: "in_sync" as const,
      syncOperation: null,
      syncError: null,
    };
    this.links.set(link.id, link);
    return link.id;
  }

  async markLinkPending(params: { activityId: string; reason: string }): Promise<boolean> {
    const link = [...this.links.values()].find((l) => l.activityId === params.activityId && l.status !== "unlinked");
    if (!link) return false;
    link.syncState = "pending";
    link.syncOperation = "update";
    link.syncError = params.reason;
    this.pendingMarks.push(params);
    return true;
  }

  async recordConflict(params: {
    linkId: string;
    field: "title" | "schedule" | "cancellation" | "meet";
    crmValue: unknown;
    googleValue: unknown;
    resolution: ConflictResolution;
  }): Promise<void> {
    this.conflicts.push(params);
  }

  async applyGoogleToActivity(params: {
    activityId: string;
    expectedVersion: number;
    title?: string | undefined;
    dueAt?: string | undefined;
    conflicts: Array<{ field: "title" | "schedule"; crmValue: unknown; googleValue: unknown }>;
  }): Promise<number | null> {
    const hook = this.beforeApply;
    this.beforeApply = undefined;
    hook?.();

    const current = this.activities.get(params.activityId);
    const stale = current !== undefined && params.expectedVersion !== undefined && current.lockVersion !== params.expectedVersion;
    this.applyAttempts.push({ activityId: params.activityId, expectedVersion: params.expectedVersion, applied: !stale });
    // Como no banco: versão diferente da esperada NÃO aplica nada e NÃO grava conflito.
    if (stale) return null;

    const link = [...this.links.values()].find((l) => l.activityId === params.activityId && l.status !== "unlinked");
    for (const c of params.conflicts ?? []) {
      this.conflicts.push({ linkId: link?.id ?? "sem-vinculo", field: c.field, crmValue: c.crmValue, googleValue: c.googleValue, resolution: "google_prevails" });
    }
    this.appliedToActivity.push({ activityId: params.activityId, title: params.title, dueAt: params.dueAt });
    if (current) {
      if (params.title !== undefined) current.title = params.title;
      if (params.dueAt !== undefined) current.dueAt = params.dueAt;
      current.lockVersion += 1;
      return current.lockVersion;
    }
    return this.appliedToActivity.length;
  }

  /** O usuário escolhe outra agenda para a conexão: vale só para vínculos NOVOS. */
  selectCalendar(connectionId: string, calendarId: string): void {
    this.selectedCalendar.set(connectionId, calendarId);
  }

  private selectedCalendarOf(connectionId: string): string {
    return this.selectedCalendar.get(connectionId) ?? this.calendarId;
  }

  private openCreates(activityId: string): StoredIntent[] {
    return this.intents.filter(
      (i) => i.activityId === activityId && i.operation === "create" && (i.status === "pending" || i.status === "uncertain"),
    );
  }

  /** Registra (ou substitui) a atividade do CRM, com controle de versão. */
  setActivity(activity: ActivitySnapshot): void {
    this.activities.set(activity.id, { ...activity });
  }

  /** Simula uma edição do CRM entre a leitura e a aplicação dos valores do Google. */
  onceBeforeApply(fn: () => void): void {
    this.beforeApply = fn;
  }

  /** Planta um vínculo pronto, como se criado antes (outro ambiente, etc.). */
  seedLink(link: Partial<LinkRecord> & { activityId: string; eventId: string }): void {
    this.seq += 1;
    this.links.set(`seed-${this.seq}`, {
      id: `seed-${this.seq}`,
      connectionId: "conn-1",
      environment: this.environment,
      calendarId: this.calendarId,
      generation: 1,
      status: "linked",
      durationMinutes: 60,
      baseEtag: null,
      baseTitle: null,
      baseStart: null,
      baseEnd: null,
      baseCancelled: false,
      baseHasMeet: false,
      baseCrmVersion: null,
      meetRequestId: null,
      meetStatus: null,
      meetUrl: null,
      ...link,
    });
  }
}
