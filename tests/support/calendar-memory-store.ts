import type { CalendarEnvironment } from "@/server/calendar/environment";
import type {
  ConflictResolution,
  EffectOperation,
  LinkRecord,
  LinkState,
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
  status: "pending" | "succeeded" | "failed" | "uncertain";
  errorCode?: string | undefined;
};

export type StoredConflict = {
  linkId: string;
  field: string;
  crmValue: unknown;
  googleValue: unknown;
  resolution: ConflictResolution;
};

export class MemoryStore implements SyncStore {
  links = new Map<string, LinkRecord & { activityId: string }>();
  intents: StoredIntent[] = [];
  conflicts: StoredConflict[] = [];
  appliedToActivity: Array<{ activityId: string; title?: string | undefined; dueAt?: string | undefined }> = [];
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
  }): Promise<string> {
    this.seq += 1;
    const id = `intent-${this.seq}`;
    this.intents.push({ id, ...params, status: "pending" });
    return id;
  }

  async resolveEffect(params: {
    intentId: string;
    status: "succeeded" | "failed" | "uncertain";
    errorCode?: string | undefined;
    state?: LinkState | undefined;
  }): Promise<string | null> {
    const intent = this.intents.find((i) => i.id === params.intentId);
    if (!intent) throw new Error("intent_not_found");
    // Idempotente: resultado definitivo não é reescrito.
    if (intent.status === "succeeded" || intent.status === "failed") return null;
    intent.status = params.status;
    intent.errorCode = params.errorCode;
    if (params.status !== "succeeded" || !params.state) return null;

    const s = params.state;
    const existing = [...this.links.values()].find((l) => l.eventId === s.eventId);
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
      meetRequestId: s.meetRequestId ?? existing?.meetRequestId ?? null,
      meetStatus: s.meetStatus ?? existing?.meetStatus ?? null,
      meetUrl: s.meetUrl ?? existing?.meetUrl ?? null,
    };
    if (existing) {
      Object.assign(existing, next);
      return existing.id;
    }
    this.seq += 1;
    const link = {
      id: `link-${this.seq}`,
      activityId: intent.activityId,
      connectionId: intent.connectionId,
      environment: this.environment,
      calendarId: this.calendarId,
      eventId: s.eventId,
      generation: 1,
      ...next,
    };
    this.links.set(link.id, link);
    return link.id;
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
    title?: string | undefined;
    dueAt?: string | undefined;
  }): Promise<number> {
    this.appliedToActivity.push(params);
    return this.appliedToActivity.length;
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
