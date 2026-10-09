import type {
  ApplyInboundResult,
  ChannelStatus,
  InboundLink,
  InboundState,
  InboundStore,
  MaintenanceBatch,
  NotificationResult,
  SyncLease,
  SyncTarget,
} from "@/server/calendar/sync/inbound-types";

import type { MemoryStore } from "./calendar-memory-store";

/**
 * Persistência em memória da sincronização Google → CRM, com a MESMA
 * semântica das RPCs da migration `20261011100000_b2_google_to_crm_sync`
 * (trava de execução conferida em toda escrita, token só no fim, base
 * conferida, versão da atividade, alcance do dono, canais com hash do
 * segredo, lote justo da manutenção). Compartilha vínculos e
 * atividades com o `MemoryStore` da etapa 2. O banco real é coberto pelo
 * pgTAP (`24_b2_google_to_crm_sync`).
 */

type MemoryLink = MemoryStore["links"] extends Map<string, infer L> ? L : never;

type Connection = { id: string; userId: string; workspaceId: string; status: "active" | "needs_reauth" | "disconnected" };

type StateRow = {
  connectionId: string;
  calendarId: string;
  syncToken: string | null;
  fullSyncAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  dirtyAt: string | null;
  lastVisitAt: number | null;
  leaseId: string | null;
  leaseStartedAt: number | null;
  leaseUntil: number | null;
};

type ChannelRow = {
  channelId: string;
  connectionId: string;
  calendarId: string;
  tokenHash: string;
  resourceId: string | null;
  status: ChannelStatus;
  expiresAt: string | null;
  renewAt: string | null;
  renewingUntil: number | null;
  syncReceivedAt: string | null;
  lastMessageNumber: number | null;
  stopReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export class InboundMemoryStore implements InboundStore {
  connections = new Map<string, Connection>([["conn-1", { id: "conn-1", userId: "user-1", workspaceId: "ws-1", status: "active" }]]);
  states = new Map<string, StateRow>();
  channels = new Map<string, ChannelRow>();
  /** Atividades que o dono da conexão deixou de alcançar (papel/lead). */
  noAccess = new Set<string>();
  /** Auditoria: só ações e nomes de campo, como no banco. */
  audit: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  /** Toda aplicação pedida (para provar o que NÃO foi aplicado). */
  applyCalls: Array<{ linkId: string; status: string }> = [];
  /** `recovery_pending_at` dos vínculos revinculados (id → instante). */
  recoveryPending = new Map<string, number>();
  private beforeApply: (() => void | Promise<void>) | undefined;
  private seq = 0;

  constructor(
    readonly base: MemoryStore,
    readonly now: () => Date,
  ) {}

  private t = () => this.now().getTime();
  private iso = () => this.now().toISOString();
  private key = (connectionId: string, calendarId: string) => `${connectionId}|${calendarId}`;

  private ownActive(actor: string, connectionId: string): Connection {
    const c = this.connections.get(connectionId);
    if (!c || c.userId !== actor || c.status === "disconnected") throw new Error("connection_not_found");
    if (c.status !== "active") throw new Error("connection_not_active");
    return c;
  }

  /** Roda `fn` entre a leitura e a aplicação (edição do CRM, outra execução...). */
  onceBeforeApply(fn: () => void | Promise<void>): void {
    this.beforeApply = fn;
  }

  private emptyState(connectionId: string, calendarId: string): StateRow {
    return {
      connectionId,
      calendarId,
      syncToken: null,
      fullSyncAt: null,
      lastRunAt: null,
      lastError: null,
      dirtyAt: null,
      lastVisitAt: null,
      leaseId: null,
      leaseStartedAt: null,
      leaseUntil: null,
    };
  }

  /** (conexão, agenda) com vínculo ativo no ambiente. */
  private linkedPairs(): Set<string> {
    const pairs = new Set<string>();
    for (const l of this.base.links.values()) {
      if (l.status === "unlinked" || l.environment !== this.base.environment) continue;
      pairs.add(this.key(l.connectionId, l.calendarId));
    }
    return pairs;
  }

  async claimMaintenanceBatch(limit: number): Promise<MaintenanceBatch> {
    const max = Math.max(1, Math.min(limit, 200));
    const linked = this.linkedPairs();
    type Candidate = { k: string; connectionId: string; calendarId: string; visit: number | null; dirty: number | null };
    const candidates: Candidate[] = [];
    for (const k of linked) {
      const [connectionId, calendarId] = k.split("|") as [string, string];
      if (this.connections.get(connectionId)?.status !== "active") continue;
      const s = this.states.get(k);
      candidates.push({ k, connectionId, calendarId, visit: s?.lastVisitAt ?? null, dirty: s?.dirtyAt ? Date.parse(s.dirtyAt) : null });
    }
    // Até metade das vagas: dica do webhook ainda não atendida. O resto: os
    // visitados há mais tempo (nunca visitados primeiro).
    const hinted = candidates
      .filter((x) => x.dirty !== null && (x.visit === null || x.dirty > x.visit))
      .sort((a, b) => a.dirty! - b.dirty!)
      .slice(0, Math.floor(max / 2));
    const fair = [...candidates].sort((a, b) => (a.visit ?? -Infinity) - (b.visit ?? -Infinity) || a.k.localeCompare(b.k));
    const picked = [...new Map([...hinted, ...fair].map((x) => [x.k, x])).values()].slice(0, max);

    const targets: SyncTarget[] = [];
    for (const p of picked) {
      const c = this.connections.get(p.connectionId)!;
      const s = this.states.get(p.k);
      targets.push({
        connectionId: p.connectionId,
        workspaceId: c.workspaceId,
        userId: c.userId,
        connectionStatus: c.status,
        calendarId: p.calendarId,
        hasSyncToken: !!s?.syncToken,
        lastRunAt: s?.lastRunAt ?? null,
        fullSyncAt: s?.fullSyncAt ?? null,
        dirtyAt: s?.dirtyAt ?? null,
        leaseUntil: s?.leaseUntil ? new Date(s.leaseUntil).toISOString() : null,
      });
    }
    // A visita é marcada na reserva: a próxima rodada começa pelos outros.
    for (const p of picked) {
      const s = this.states.get(p.k) ?? this.emptyState(p.connectionId, p.calendarId);
      s.lastVisitAt = this.t();
      this.states.set(p.k, s);
    }

    // Canais do lote + os que podem ter de ser encerrados em qualquer agenda.
    const batchKeys = new Set(picked.map((p) => p.k));
    const live = [...this.channels.values()].filter((w) => w.status !== "stopped");
    const expired = (w: ChannelRow) => w.expiresAt !== null && Date.parse(w.expiresAt) <= this.t();
    const channels = live
      .filter((w) => {
        const k = this.key(w.connectionId, w.calendarId);
        return batchKeys.has(k) || !linked.has(k) || expired(w);
      })
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
      .map((w) => {
        const c = this.connections.get(w.connectionId)!;
        return {
          channelId: w.channelId,
          connectionId: w.connectionId,
          workspaceId: c.workspaceId,
          userId: c.userId,
          connectionStatus: c.status,
          calendarId: w.calendarId,
          status: w.status,
          resourceId: w.resourceId,
          expiresAt: w.expiresAt,
          renewAt: w.renewAt,
          syncReceivedAt: w.syncReceivedAt,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
          hasLinks: linked.has(this.key(w.connectionId, w.calendarId)),
          replacementDelivered: live.some(
            (o) => o !== w && o.connectionId === w.connectionId && o.calendarId === w.calendarId && o.status === "active" && o.syncReceivedAt !== null,
          ),
        };
      });
    return structuredClone({ targets, channels });
  }

  async claimSync(actor: string, connectionId: string, calendarId: string, leaseSeconds = 120): Promise<SyncLease | null> {
    this.ownActive(actor, connectionId);
    const k = this.key(connectionId, calendarId);
    let s = this.states.get(k);
    if (!s) {
      s = this.emptyState(connectionId, calendarId);
      this.states.set(k, s);
    }
    if (s.leaseUntil !== null && s.leaseUntil >= this.t()) return null;
    this.seq += 1;
    s.leaseId = `lease-${this.seq}`;
    s.leaseStartedAt = this.t();
    s.leaseUntil = this.t() + leaseSeconds * 1000;
    return { leaseId: s.leaseId, syncToken: s.syncToken, fullSyncAt: s.fullSyncAt };
  }

  /** Estado cuja trava AINDA é desta execução (como `private.lock_sync_lease`). */
  private leased(actor: string, leaseId: string): StateRow | null {
    const s = [...this.states.values()].find((x) => x.leaseId === leaseId);
    if (!s) return null;
    if (this.connections.get(s.connectionId)?.userId !== actor) throw new Error("connection_not_found");
    if ((s.leaseUntil ?? 0) < this.t()) return null;
    return s;
  }

  async resetSyncToken(actor: string, leaseId: string): Promise<boolean> {
    const s = this.leased(actor, leaseId);
    if (!s) return false;
    s.syncToken = null;
    s.lastError = "sync_token_invalid";
    this.audit.push({ action: "calendar.sync.token_reset", metadata: {} });
    return true;
  }

  async finishSync(
    actor: string,
    leaseId: string,
    outcome: "success" | "failed" | "access_lost",
    opts: { syncToken?: string | undefined; full: boolean; error?: string | undefined },
  ): Promise<boolean> {
    const s = this.leased(actor, leaseId);
    if (!s) return false;
    const links = [...this.base.links.values()].filter((l) => l.connectionId === s.connectionId && l.calendarId === s.calendarId);
    if (outcome === "success") {
      if (!opts.syncToken) throw new Error("sync_token_required");
      s.syncToken = opts.syncToken;
      s.lastRunAt = this.iso();
      if (opts.full) s.fullSyncAt = this.iso();
      s.lastError = null;
      if (s.dirtyAt !== null && Date.parse(s.dirtyAt) < (s.leaseStartedAt ?? 0)) s.dirtyAt = null;
      for (const l of links) if (l.status === "needs_attention" && l.syncError === "calendar_access_lost") l.status = "linked";
    } else {
      s.lastError = opts.error || outcome;
      if (outcome === "access_lost") {
        for (const l of links) {
          if (l.status !== "linked") continue;
          l.status = "needs_attention";
          l.syncState = "pending";
          l.syncError = "calendar_access_lost";
        }
      }
    }
    s.leaseId = null;
    s.leaseStartedAt = null;
    s.leaseUntil = null;
    this.audit.push({ action: `calendar.sync.${outcome}`, metadata: { full: opts.full, reason: opts.error ?? null } });
    return true;
  }

  async listLinks(actor: string, connectionId: string, calendarId: string): Promise<InboundLink[]> {
    this.ownActive(actor, connectionId);
    return [...this.base.links.values()]
      .filter((l) => l.connectionId === connectionId && l.calendarId === calendarId && l.status !== "unlinked" && l.environment === this.base.environment)
      .map((l) => {
        const a = l.activityId ? this.base.activities.get(l.activityId) : undefined;
        return structuredClone({
          id: l.id,
          activityId: l.activityId,
          connectionId: l.connectionId,
          environment: l.environment,
          calendarId: l.calendarId,
          eventId: l.eventId,
          status: l.status,
          durationMinutes: l.durationMinutes,
          baseEtag: l.baseEtag,
          baseTitle: l.baseTitle,
          baseStart: l.baseStart,
          baseEnd: l.baseEnd,
          baseCancelled: l.baseCancelled,
          baseHasMeet: l.baseHasMeet,
          meetStatus: l.meetStatus,
          meetUrl: l.meetUrl,
          activity: a ? { title: a.title, dueAt: a.dueAt, hasTime: a.hasTime, type: a.type, lockVersion: a.lockVersion } : null,
        });
      });
  }

  async applyInbound(actor: string, params: Parameters<InboundStore["applyInbound"]>[1]): Promise<ApplyInboundResult> {
    const hook = this.beforeApply;
    this.beforeApply = undefined;
    await hook?.();

    const result = this.applyNow(actor, params);
    this.applyCalls.push({ linkId: params.linkId, status: result.status });
    return result;
  }

  private applyNow(
    actor: string,
    params: Parameters<InboundStore["applyInbound"]>[1],
  ): ApplyInboundResult {
    // A trava primeiro: tem de ser desta execução, da conexão e da agenda do vínculo.
    const lease = this.leased(actor, params.leaseId);
    const link = this.base.links.get(params.linkId);
    if (!link || link.status === "unlinked") throw new Error("link_not_found");
    if (link.environment !== this.base.environment) throw new Error("calendar_environment_mismatch");
    const c = this.connections.get(link.connectionId);
    if (c?.userId !== actor || c.status !== "active") throw new Error("connection_not_found");
    if (!lease || lease.connectionId !== link.connectionId || lease.calendarId !== link.calendarId) return { status: "lease_lost" };
    if (link.baseEtag !== params.expectedBaseEtag) return { status: "stale_link" };

    let version: number | null = null;
    if (link.activityId) {
      const a = this.base.activities.get(link.activityId);
      if (!a || this.noAccess.has(link.activityId)) {
        link.status = "needs_attention";
        link.syncState = "failed";
        link.syncError = "owner_lost_access";
        this.audit.push({ action: "calendar.inbound.not_authorized", metadata: {} });
        return { status: "not_authorized" };
      }
      if (params.expectedVersion !== a.lockVersion) return { status: "stale_activity" };
      version = a.lockVersion;
      if (params.title || params.dueAt) {
        if (params.title) a.title = params.title;
        if (params.dueAt) {
          a.dueAt = params.dueAt;
          a.hasTime = true;
        }
        a.lockVersion += 1;
        version = a.lockVersion;
      }
    }
    for (const conflict of params.conflicts) {
      this.base.conflicts.push({ linkId: link.id, field: conflict.field, crmValue: conflict.crmValue, googleValue: conflict.googleValue, resolution: "google_prevails" });
    }
    const s = JSON.parse(JSON.stringify(params.state)) as InboundState;
    Object.assign(link, {
      status: s.linkStatus,
      durationMinutes: s.durationMinutes,
      baseEtag: s.etag,
      baseTitle: s.title,
      baseStart: s.start,
      baseEnd: s.end,
      baseCancelled: s.cancelled,
      baseHasMeet: s.hasMeet,
      baseCrmVersion: version ?? link.baseCrmVersion,
      ...("meetStatus" in s ? { meetStatus: s.meetStatus } : {}),
      ...("meetUrl" in s ? { meetUrl: s.meetUrl } : {}),
    });
    this.audit.push({ action: "calendar.inbound.applied", metadata: { changed: s.changed, linkStatus: s.linkStatus } });
    return { status: "applied", lockVersion: version };
  }

  async markNeedsReauth(actor: string, connectionId: string, reason: string): Promise<void> {
    const c = this.connections.get(connectionId);
    if (!c || c.userId !== actor || c.status === "disconnected") throw new Error("connection_not_found");
    c.status = "needs_reauth";
    this.audit.push({ action: "calendar.connection.needs_reauth", metadata: { reason } });
  }

  async listOwnSyncTargets(actor: string, connectionId: string) {
    this.ownActive(actor, connectionId);
    const calendars = new Set(
      [...this.base.links.values()]
        .filter((l) => l.connectionId === connectionId && l.status !== "unlinked" && l.environment === this.base.environment)
        .map((l) => l.calendarId),
    );
    return [...calendars].sort().map((calendarId) => {
      const s = this.states.get(this.key(connectionId, calendarId));
      return {
        calendarId,
        lastRunAt: s?.lastRunAt ?? null,
        leaseUntil: s?.leaseUntil ? new Date(s.leaseUntil).toISOString() : null,
      };
    });
  }

  /** Como `private.recoverable_link`. */
  private recoverable(link: MemoryLink, conn: Connection): boolean {
    const old = this.connections.get(link.connectionId);
    return (
      link.status === "unlinked" &&
      !!link.activityId &&
      link.environment === this.base.environment &&
      link.connectionId !== conn.id &&
      old?.userId === conn.userId &&
      old.status === "disconnected" &&
      this.base.activities.has(link.activityId) &&
      ![...this.base.links.values()].some((o) => o !== link && o.activityId === link.activityId && o.status !== "unlinked")
    );
  }

  async listRecoverableLinks(actor: string, connectionId: string) {
    const conn = this.ownActive(actor, connectionId);
    return [...this.base.links.values()]
      .filter((l) => this.recoverable(l, conn))
      .map((l) => ({ id: l.id, activityId: l.activityId, calendarId: l.calendarId, eventId: l.eventId }));
  }

  async relinkRecovered(actor: string, linkId: string, connectionId: string): Promise<"relinked" | "not_recoverable"> {
    const conn = this.ownActive(actor, connectionId);
    const link = this.base.links.get(linkId);
    if (!link || !this.recoverable(link, conn)) return "not_recoverable";
    Object.assign(link, { connectionId, status: "linked", syncState: "pending", syncError: "reconnected" });
    this.recoveryPending.set(link.id, this.t());
    this.audit.push({ action: "calendar.link.recovered", metadata: {} });
    return "relinked";
  }

  /** Como `list_pending_calendar_recoveries`. */
  async listPendingRecoveries(actor: string, connectionId: string) {
    const conn = this.ownActive(actor, connectionId);
    return [...this.base.links.values()]
      .filter(
        (l) =>
          l.connectionId === conn.id &&
          l.environment === this.base.environment &&
          l.status !== "unlinked" &&
          !!l.activityId &&
          this.recoveryPending.has(l.id),
      )
      .sort((a, b) => this.recoveryPending.get(a.id)! - this.recoveryPending.get(b.id)! || a.id.localeCompare(b.id))
      .map((l) => ({ id: l.id, activityId: l.activityId, calendarId: l.calendarId, eventId: l.eventId }));
  }

  /** Como `finish_calendar_link_recovery`. */
  async finishRecovery(actor: string, linkId: string, connectionId: string): Promise<boolean> {
    const conn = this.ownActive(actor, connectionId);
    const link = this.base.links.get(linkId);
    if (!link || link.connectionId !== conn.id || !this.recoveryPending.has(linkId)) return false;
    this.recoveryPending.delete(linkId);
    this.audit.push({ action: "calendar.link.recovery_completed", metadata: {} });
    return true;
  }

  async beginChannel(actor: string, params: { connectionId: string; calendarId: string; channelId: string; tokenHash: string }): Promise<void> {
    this.ownActive(actor, params.connectionId);
    if (this.channels.has(params.channelId)) throw new Error("duplicate_channel");
    this.channels.set(params.channelId, {
      channelId: params.channelId,
      connectionId: params.connectionId,
      calendarId: params.calendarId,
      tokenHash: params.tokenHash,
      resourceId: null,
      status: "creating",
      expiresAt: null,
      renewAt: null,
      renewingUntil: null,
      syncReceivedAt: null,
      lastMessageNumber: null,
      stopReason: null,
      createdAt: this.iso(),
      updatedAt: this.iso(),
    });
  }

  private own(actor: string, channelId: string): ChannelRow {
    const w = this.channels.get(channelId);
    if (!w || this.connections.get(w.connectionId)?.userId !== actor) throw new Error("channel_not_found");
    return w;
  }

  async activateChannel(
    actor: string,
    params: { channelId: string; resourceId: string; expiresAt: string; renewAt: string | null; pollingOnly: boolean },
  ): Promise<void> {
    const w = this.own(actor, params.channelId);
    if (w.status !== "creating" && w.status !== "active") throw new Error("channel_not_creating");
    w.status = params.pollingOnly ? "polling_only" : "active";
    w.resourceId = params.resourceId;
    w.expiresAt = params.expiresAt;
    w.renewAt = params.pollingOnly ? null : params.renewAt;
    w.renewingUntil = null;
    w.updatedAt = this.iso();
    if (!params.pollingOnly) {
      for (const other of this.channels.values()) {
        if (other !== w && other.connectionId === w.connectionId && other.calendarId === w.calendarId && other.status === "active") {
          other.status = "retiring";
          other.updatedAt = this.iso();
        }
      }
    }
  }

  async claimChannelRenewal(actor: string, channelId: string): Promise<boolean> {
    const w = this.own(actor, channelId);
    const due = w.renewAt !== null && Date.parse(w.renewAt) <= this.t();
    if (w.status !== "active" || !due || (w.renewingUntil !== null && w.renewingUntil >= this.t())) return false;
    w.renewingUntil = this.t() + 120_000;
    return true;
  }

  async stopChannel(actor: string, channelId: string, reason: string): Promise<void> {
    const w = this.own(actor, channelId);
    if (w.status === "stopped") return;
    w.status = "stopped";
    w.stopReason = reason;
    w.updatedAt = this.iso();
  }

  async recordNotification(params: {
    channelId: string;
    tokenHash: string;
    resourceId: string | null;
    resourceState: string;
    messageNumber: number | null;
    expiresAt: string | null;
  }): Promise<NotificationResult> {
    const w = this.channels.get(params.channelId);
    if (!w) return "rejected";
    if (params.tokenHash !== w.tokenHash) return "rejected";
    if (w.resourceId !== null && params.resourceId !== w.resourceId) return "rejected";
    if (w.status === "stopped" || w.status === "polling_only") return "ignored";
    w.resourceId ??= params.resourceId;
    w.expiresAt ??= params.expiresAt;
    if (params.resourceState === "sync") w.syncReceivedAt ??= this.iso();
    w.lastMessageNumber = Math.max(w.lastMessageNumber ?? 0, params.messageNumber ?? 0);
    if (params.resourceState !== "sync") {
      const k = this.key(w.connectionId, w.calendarId);
      const s = this.states.get(k);
      if (s) s.dirtyAt = this.iso();
      else this.states.set(k, { ...this.emptyState(w.connectionId, w.calendarId), dirtyAt: this.iso() });
    }
    return "accepted";
  }
}
