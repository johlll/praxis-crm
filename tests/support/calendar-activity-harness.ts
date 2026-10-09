import { zonedInstant } from "@/lib/timezone";

import type { MemoryStore } from "./calendar-memory-store";

/**
 * Banco de atividades de mentira para os testes das ações de atividade com o
 * Google Agenda: responde às RPCs de atividade (create/update/reschedule/
 * delete) e à leitura do vínculo pela tela (`list_activity_calendar_links`),
 * esta com a MESMA regra da migration: vínculo ativo da atividade, ou — sem
 * vínculo — uma inclusão no Google com resultado incerto. Dados fictícios.
 */
export type HarnessActivity = {
  id: string;
  title: string;
  dueAt: string;
  hasTime: boolean;
  type: string;
  lockVersion: number;
  notes?: string | null;
  priority?: string;
};

export type Harness = {
  activities: Map<string, HarnessActivity>;
  rpcLog: Array<{ name: string; googleStatusAtCall?: string | undefined }>;
  onDelete: (() => string | undefined) | undefined;
  nextId: number;
  /** Conexão do usuário logado (para `isMine`). */
  myConnectionId: string;
  /** Falha forçada na leitura do vínculo. */
  failLinkRead: boolean;
};

export function createHarness(): Harness {
  return { activities: new Map(), rpcLog: [], onDelete: undefined, nextId: 0, myConnectionId: "conn-1", failLinkRead: false };
}

export function fakeActivityRpc(h: Harness, store: MemoryStore, name: string, args: Record<string, unknown>) {
  if (name === "list_activity_calendar_links") {
    if (h.failLinkRead) return { data: null, error: { message: "environment_required" } };
    const ids = args.p_activity_ids as string[];
    const rows: unknown[] = [];
    for (const id of ids) {
      const link = [...store.links.values()].find((l) => l.activityId === id && l.status !== "unlinked");
      if (link) {
        rows.push({
          activityId: id,
          status: link.status,
          isMine: link.connectionId === h.myConnectionId,
          durationMinutes: link.durationMinutes,
          meetStatus: link.meetStatus,
          meetUrl: link.meetUrl,
          lastSyncedAt: null,
          syncState: link.syncState ?? "in_sync",
          syncOperation: link.syncOperation ?? null,
        });
        continue;
      }
      const open = store.intents.find((i) => i.activityId === id && i.operation === "create" && i.status === "uncertain");
      if (open) {
        rows.push({
          activityId: id,
          status: "not_linked",
          isMine: open.connectionId === h.myConnectionId,
          durationMinutes: 60,
          meetStatus: null,
          meetUrl: null,
          lastSyncedAt: null,
          syncState: "uncertain",
          syncOperation: "create",
        });
      }
    }
    return { data: rows, error: null };
  }

  if (name === "create_activity") {
    h.nextId += 1;
    const id = `a1b2c3d4-0000-4000-8000-0000000b${String(h.nextId).padStart(4, "0")}`;
    const time = args.p_due_time as string | undefined;
    h.activities.set(id, {
      id,
      title: args.p_title as string,
      dueAt: zonedInstant(args.p_due_date as string, time ?? "00:00"),
      hasTime: Boolean(time),
      type: args.p_type as string,
      lockVersion: 1,
    });
    h.rpcLog.push({ name });
    return { data: id, error: null };
  }

  const id = args.p_activity_id as string;
  const current = h.activities.get(id);
  if (name === "reschedule_activity" && current) {
    const time = args.p_due_time as string | undefined;
    current.dueAt = zonedInstant(args.p_due_date as string, time ?? "00:00");
    current.hasTime = Boolean(time);
    current.lockVersion += 1;
  }
  if (name === "update_activity" && current) {
    if (args.p_title) current.title = args.p_title as string;
    if (args.p_type) current.type = args.p_type as string;
    if (args.p_notes) current.notes = args.p_notes as string;
    if (args.p_priority) current.priority = args.p_priority as string;
    current.lockVersion += 1;
  }
  if (name === "delete_activity") {
    h.rpcLog.push({ name, googleStatusAtCall: h.onDelete?.() });
    h.activities.delete(id);
    return { data: null, error: null };
  }
  h.rpcLog.push({ name });
  return { data: null, error: null };
}
