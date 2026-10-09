import type { CalendarEnvironment } from "@/server/calendar/environment";
import type {
  ActivitySnapshot,
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
  /** Toda tentativa de aplicar valores do Google, com a versão esperada. */
  applyAttempts: Array<{ activityId: string; expectedVersion: number | undefined; applied: boolean }> = [];
  /** Atividades do CRM simuladas (só as registradas têm controle de versão). */
  activities = new Map<string, ActivitySnapshot>();
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
    // Como no banco: perda de acesso marca o vínculo ATIVO da conexão como pendente.
    if (params.status === "failed" && params.state?.linkStatus === "needs_attention") {
      const link = [...this.links.values()].find(
        (l) => l.activityId === intent.activityId && l.status !== "unlinked" && l.connectionId === intent.connectionId,
      );
      if (link) link.status = "needs_attention";
    }
    if (params.status !== "succeeded" || !params.state) return null;

    // Como no banco: o estado viaja como JSON — chave AUSENTE preserva o valor
    // guardado; chave presente (inclusive null) o substitui.
    const s = JSON.parse(JSON.stringify(params.state)) as LinkState;
    const existing = [...this.links.values()].find((l) => l.eventId === s.eventId);
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
      Object.assign(existing, next);
      return existing.id;
    }
    this.seq += 1;
    const link = {
      id: `link-${this.seq}`,
      activityId: intent.activityId,
      connectionId: intent.connectionId,
      environment: this.environment,
      calendarId: this.selectedCalendar.get(intent.connectionId) ?? this.calendarId,
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
