/**
 * @vitest-environment node
 *
 * B2, etapa 3b — ação "Restaurar valor do CRM", o caminho restaurar → Google
 * com o orquestrador real e o provedor simulado, os avisos de saúde
 * (Detector 2) e a integração DESLIGADA (sem provedor: nada é consultado).
 * Dados fictícios.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  provider: { value: null as unknown },
  restore: vi.fn(),
  sync: vi.fn(),
  listConnections: vi.fn(),
  serverClient: vi.fn(),
  after: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: m.after }));
vi.mock("@/server/authz/safe", () => ({
  requirePermissionSafe: async () => ({ ctx: { userId: "user-1", workspaceId: "ws-1", role: "owner" } }),
}));
vi.mock("@/server/calendar/provider", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCalendarProvider: async () => m.provider.value,
}));
vi.mock("@/server/calendar/admin/conflicts", () => ({ adminRestoreCalendarConflict: m.restore }));
vi.mock("@/modules/calendar/appointment-service", () => ({
  PROVIDER_NOT_CONFIGURED: "A integração com o Google Agenda não está configurada.",
  syncLinkedActivity: m.sync,
  loadActivityFromSession: vi.fn(),
}));
vi.mock("@/modules/calendar/queries", () => ({ listCalendarConnections: m.listConnections }));
vi.mock("@/server/supabase/server", () => ({ createServerSupabaseClient: m.serverClient }));

import { restoreCalendarConflictAction } from "@/modules/calendar/conflict-actions";
import { recoverCalendarLinksAction } from "@/modules/calendar/actions";
import { loadCalendarHealthNotices, recoverOwnCalendarLinks } from "@/modules/calendar/automation";
import { syncHealthNotices, type CalendarSyncHealth } from "@/modules/calendar/health";
import { scheduleOnDemandCalendarSync } from "@/modules/calendar/on-demand";
import { createAppointment, rescheduleAppointment } from "@/server/calendar/sync/appointments";
import { syncCalendar } from "@/server/calendar/sync/inbound";

import { ACTIVITY_ID, CALENDAR_ID, activity, makeFixture } from "../support/calendar-fixture";
import { InboundMemoryStore } from "../support/calendar-inbound-store";

const CONFLICT_ID = "c0000000-0000-4000-8000-000000000001";

beforeEach(() => {
  m.provider.value = {};
  for (const fn of [m.restore, m.sync, m.listConnections, m.serverClient, m.after]) fn.mockReset();
});

describe("ação Restaurar valor do CRM", () => {
  it("restaurado no CRM: leva ao Google pela saída normal e avisa", async () => {
    m.restore.mockResolvedValueOnce({ status: "restored", activityId: ACTIVITY_ID, lockVersion: 6 });
    m.sync.mockResolvedValueOnce({ level: "success", message: "Salvo no CRM. Google Agenda atualizado." });

    const result = await restoreCalendarConflictAction(CONFLICT_ID);

    expect(m.restore).toHaveBeenCalledWith({ conflictId: CONFLICT_ID, actorUserId: "user-1" });
    expect(m.sync).toHaveBeenCalledWith(ACTIVITY_ID);
    expect(result).toEqual({ ok: true, notice: { level: "success", message: "Valor do CRM restaurado. Google Agenda atualizado." } });
  });

  it.each([
    ["outdated", /mudou depois do conflito/],
    ["not_owner", /agenda de outra pessoa/],
    ["already_restored", /já foi restaurado/],
    ["link_inactive", /não está mais vinculado/],
    ["not_restorable", /não pode ser restaurado/],
  ])("recusado pelo banco (%s): nada vai ao Google", async (status, message) => {
    m.restore.mockResolvedValueOnce({ status, activityId: ACTIVITY_ID });
    const result = await restoreCalendarConflictAction(CONFLICT_ID);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(message);
    expect(m.sync).not.toHaveBeenCalled();
  });

  it("integração desligada ou id inválido: recusa antes do banco", async () => {
    m.provider.value = null;
    expect(await restoreCalendarConflictAction(CONFLICT_ID)).toMatchObject({ ok: false });
    m.provider.value = {};
    expect(await restoreCalendarConflictAction("nao-e-uuid")).toMatchObject({ ok: false });
    expect(m.restore).not.toHaveBeenCalled();
  });
});

describe("restaurar → Google (orquestrador real, provedor simulado)", () => {
  /** O que `restore_calendar_conflict` faz no banco, para encadear com a saída real. */
  function restoreInMemory(f: Awaited<ReturnType<typeof makeFixture>>) {
    const conflict = f.store.conflicts[0]!;
    const current = f.store.activities.get(ACTIVITY_ID)!;
    if (current.title !== conflict.googleValue) throw new Error("outdated");
    current.title = conflict.crmValue as string;
    current.lockVersion += 1;
  }

  async function conflictOnTitle() {
    const f = await makeFixture();
    f.store.setActivity(activity());
    const created = await createAppointment(f.deps, f.conn, activity());
    if (created.status !== "created") throw new Error("setup");
    const inbound = new InboundMemoryStore(f.store, () => new Date());
    const deps = { api: f.provider, store: inbound, environment: "preview" as const, now: () => new Date() };
    const conn = { connectionId: "conn-1", userId: "user-1", calendarId: CALENDAR_ID, environment: "preview" as const, accessToken: f.conn.accessToken };
    await syncCalendar(deps, conn);

    f.store.activities.get(ACTIVITY_ID)!.title = "Do CRM";
    f.store.activities.get(ACTIVITY_ID)!.lockVersion += 1;
    f.provider.externalEdit(CALENDAR_ID, created.eventId, { summary: "Do Google" });
    await syncCalendar(deps, conn);
    expect(f.store.conflicts).toEqual([expect.objectContaining({ field: "title", crmValue: "Do CRM", googleValue: "Do Google" })]);
    return { f, eventId: created.eventId };
  }

  it("o valor do CRM volta para a atividade e vai ao Google; nenhum conflito novo", async () => {
    const { f, eventId } = await conflictOnTitle();
    restoreInMemory(f);

    const result = await rescheduleAppointment(f.deps, f.conn, { ...f.store.activities.get(ACTIVITY_ID)! });

    expect(result.status).toBe("updated");
    expect(f.provider.peek(CALENDAR_ID, eventId)!.summary).toBe("Do CRM");
    expect(f.store.conflicts).toHaveLength(1);
  });

  it("o Google mudou de novo antes da ida: vale a regra de conflito outra vez, com registro", async () => {
    const { f, eventId } = await conflictOnTitle();
    restoreInMemory(f);
    f.provider.externalEdit(CALENDAR_ID, eventId, { summary: "Google de novo" });

    const result = await rescheduleAppointment(f.deps, f.conn, { ...f.store.activities.get(ACTIVITY_ID)! });

    expect(result.status).toBe("conflict_resolved");
    expect(f.store.activities.get(ACTIVITY_ID)!.title).toBe("Google de novo");
    expect(f.store.conflicts.at(-1)).toMatchObject({ field: "title", crmValue: "Do CRM", googleValue: "Google de novo" });
  });
});

describe("Detector 2: avisos de saúde", () => {
  const now = new Date("2026-11-01T12:00:00.000Z");
  const health = (extra: Partial<CalendarSyncHealth> = {}): CalendarSyncHealth => ({
    schedulers: [],
    activeLinks: 3,
    channelsLowLife: 0,
    ...extra,
  });

  it("sem compromissos vinculados: nenhum aviso", () => {
    expect(syncHealthNotices(health({ activeLinks: 0, channelsLowLife: 2 }), { now, schedulerEnabled: true })).toEqual([]);
  });

  it("agendador desligado (padrão): informa, sem alarme", () => {
    expect(syncHealthNotices(health(), { now, schedulerEnabled: false })).toEqual([
      expect.objectContaining({ level: "info", message: expect.stringMatching(/desligada neste ambiente/) }),
    ]);
  });

  it("ligado: atrasado sem execução, atrasado há mais de 60 min, em dia; manual não conta", () => {
    expect(syncHealthNotices(health(), { now, schedulerEnabled: true })[0]).toMatchObject({ level: "warning", message: expect.stringMatching(/nenhuma execução/) });
    const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
    expect(
      syncHealthNotices(health({ schedulers: [{ scheduler: "inngest", lastRunAt: at(61), lastOutcome: "ok" }] }), { now, schedulerEnabled: true })[0],
    ).toMatchObject({ message: expect.stringMatching(/há 61 minutos/) });
    expect(
      syncHealthNotices(health({ schedulers: [{ scheduler: "github", lastRunAt: at(10), lastOutcome: "ok" }] }), { now, schedulerEnabled: true }),
    ).toEqual([]);
    expect(
      syncHealthNotices(health({ schedulers: [{ scheduler: "manual", lastRunAt: at(1), lastOutcome: "ok" }] }), { now, schedulerEnabled: true })[0],
    ).toMatchObject({ level: "warning" });
  });

  it("canais perto de vencer: aviso", () => {
    expect(syncHealthNotices(health({ channelsLowLife: 2 }), { now, schedulerEnabled: false }).at(-1)).toMatchObject({
      level: "warning",
      message: "2 canais de notificação do Google Agenda estão perto de vencer sem renovação.",
    });
  });
});

describe("integração desligada (hoje, em Preview e Production): nada é consultado", () => {
  beforeEach(() => {
    m.provider.value = null;
  });

  it("abrir a agenda não agenda sincronização nem lê conexões", async () => {
    await scheduleOnDemandCalendarSync({ userId: "user-1", workspaceId: "ws-1" });
    expect(m.listConnections).not.toHaveBeenCalled();
    expect(m.after).not.toHaveBeenCalled();
  });

  it("nenhum aviso de saúde e nenhuma consulta ao banco", async () => {
    expect(await loadCalendarHealthNotices("ws-1")).toEqual([]);
    expect(m.serverClient).not.toHaveBeenCalled();
  });

  it("reconexão e \"Reencontrar compromissos\" não tocam em nada", async () => {
    expect(await recoverOwnCalendarLinks({ userId: "user-1", workspaceId: "ws-1" })).toBeNull();
    expect(await recoverCalendarLinksAction()).toMatchObject({ ok: false });
    expect(m.listConnections).not.toHaveBeenCalled();
  });
});

describe("integração ligada: a sob demanda roda DEPOIS da resposta", () => {
  it("lê a conexão pela sessão e agenda o trabalho com after()", async () => {
    m.listConnections.mockResolvedValueOnce([{ id: "conn-1", isMine: true, status: "active", calendarId: CALENDAR_ID }]);
    await scheduleOnDemandCalendarSync({ userId: "user-1", workspaceId: "ws-1" });
    expect(m.after).toHaveBeenCalledTimes(1);
  });

  it("sem conexão própria ativa com agenda: nada agendado", async () => {
    m.listConnections.mockResolvedValueOnce([{ id: "conn-1", isMine: true, status: "needs_reauth", calendarId: CALENDAR_ID }]);
    await scheduleOnDemandCalendarSync({ userId: "user-1", workspaceId: "ws-1" });
    expect(m.after).not.toHaveBeenCalled();
  });
});
