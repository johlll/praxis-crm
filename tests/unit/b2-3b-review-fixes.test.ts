/**
 * @vitest-environment node
 *
 * B2, etapa 3b — correções da revisão da PR #28, com reprodução primeiro:
 *  1. restauração do horário COMPLETO (início e duração) de um conflito;
 *  2. batimento e saúde: "executou recentemente" ≠ "sincronizou com sucesso";
 *  3. reconexão retomável depois de revincular (entrada, saída, interrupção).
 * Orquestradores REAIS, provedor SIMULADO, dados fictícios.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { describeRecovery } from "@/modules/calendar/automation";
import { syncHealthNotices, type CalendarSyncHealth } from "@/modules/calendar/health";
import { createAppointment, rescheduleAppointment } from "@/server/calendar/sync/appointments";
import { syncCalendar } from "@/server/calendar/sync/inbound";
import type { InboundDeps } from "@/server/calendar/sync/inbound-types";
import type { MaintenanceReport } from "@/server/calendar/sync/maintenance";
import { recoverLinksAfterReconnect } from "@/server/calendar/sync/reconnect";
import { checkPrimaryScheduler, runScheduledMaintenance, type ScheduledDeps } from "@/server/calendar/sync/scheduled";

import { ACTIVITY_ID, CALENDAR_ID, activity, countCalls, makeFixture } from "../support/calendar-fixture";
import { InboundMemoryStore } from "../support/calendar-inbound-store";
import { MemorySchedulerStore } from "../support/calendar-scheduler-store";

const MIN = 60_000;
const H = (hour: number, minute = 0) => `2026-11-10T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

let f: Awaited<ReturnType<typeof makeFixture>>;
let clock: { t: number };
let inbound: InboundMemoryStore;
let deps: InboundDeps;
let eventId: string;

const now = () => new Date(clock.t);
const crm = () => f.store.activities.get(ACTIVITY_ID)!;
const linkOf = () => [...f.store.links.values()].find((l) => l.activityId === ACTIVITY_ID && l.status !== "unlinked")!;
const google = () => f.provider.peek(CALENDAR_ID, eventId)!;
const own = (connectionId = "conn-1") => ({ connectionId, userId: "user-1", calendarId: CALENDAR_ID, environment: "preview" as const, accessToken: f.conn.accessToken });

async function setup(dueAt = H(10)) {
  f = await makeFixture();
  clock = { t: Date.parse("2026-11-01T12:00:00.000Z") };
  f.provider.now = () => clock.t;
  inbound = new InboundMemoryStore(f.store, now);
  deps = { api: f.provider, store: inbound, environment: "preview", now };
  f.store.setActivity(activity({ dueAt }));
  const created = await createAppointment(f.deps, f.conn, activity({ dueAt }));
  if (created.status !== "created") throw new Error("setup");
  eventId = created.eventId;
  await syncCalendar(deps, own()); // base e token
}

// ---------------------------------------------------------------------
// 1. Restauração do horário completo
// ---------------------------------------------------------------------

describe("1. restaurar o horário recupera início E duração do CRM", () => {
  /** CRM remarcou para 14h (1 h); o Google, para 16h–18h: conflito, o Google prevalece. */
  async function scheduleConflict() {
    await setup(H(10));
    crm().dueAt = H(14);
    crm().lockVersion += 1;
    f.provider.externalEdit(CALENDAR_ID, eventId, { start: { dateTime: H(16) }, end: { dateTime: H(18) } });
    await syncCalendar(deps, own());

    expect(f.store.conflicts).toEqual([
      expect.objectContaining({ field: "schedule", crmValue: { start: H(14), end: H(15) }, googleValue: { start: H(16), end: H(18) } }),
    ]);
    expect(crm().dueAt).toBe(H(16));
    expect(linkOf().durationMinutes).toBe(120);
  }

  /**
   * O que `restore_calendar_conflict` faz no banco (espelho do SQL; o banco
   * real é coberto pelo pgTAP `25_b2_scheduler_alerts_restore`): confere
   * início E duração contra o que o Google venceu; devolve o início à
   * atividade e a duração ao vínculo; deixa o vínculo pendente.
   */
  function restoreLikeDatabase(): { status: string } {
    const conflict = f.store.conflicts.find((c) => c.field === "schedule")!;
    const crmValue = conflict.crmValue as { start: string; end: string };
    const googleValue = conflict.googleValue as { start: string; end: string };
    const minutes = (v: { start: string; end: string }) => Math.round((Date.parse(v.end) - Date.parse(v.start)) / MIN);
    if (Date.parse(crm().dueAt) !== Date.parse(googleValue.start) || linkOf().durationMinutes !== minutes(googleValue)) {
      return { status: "outdated" };
    }
    crm().dueAt = crmValue.start;
    crm().lockVersion += 1;
    Object.assign(linkOf(), { durationMinutes: minutes(crmValue), syncState: "pending", syncError: "conflict_restored" });
    return { status: "restored" };
  }

  /** O que a ação faz depois do banco: a saída normal (`syncLinkedActivity`), sem duração explícita. */
  const pushLikeAction = () => rescheduleAppointment(f.deps, f.conn, { ...crm() });

  it("CRM 14h–15h perdeu para Google 16h–18h: restaurar devolve 14h–15h ao CRM, ao vínculo e ao Google", async () => {
    await scheduleConflict();
    expect(restoreLikeDatabase().status).toBe("restored");
    expect(crm().dueAt).toBe(H(14));

    await pushLikeAction();

    expect(google().start).toEqual({ dateTime: H(14) });
    expect(google().end).toEqual({ dateTime: H(15) });
    expect(linkOf()).toMatchObject({ baseStart: H(14), baseEnd: H(15), durationMinutes: 60 });
  });

  it("depois do conflito, o Google mudou SÓ a duração (16h–17h): restaurar fica desatualizado", async () => {
    await scheduleConflict();
    f.provider.externalEdit(CALENDAR_ID, eventId, { end: { dateTime: H(17) } });
    await syncCalendar(deps, own());
    expect(crm().dueAt).toBe(H(16)); // o início não mudou

    expect(restoreLikeDatabase().status).toBe("outdated");
    expect(crm().dueAt).toBe(H(16));
  });

  it("depois do conflito, o CRM mudou SÓ a duração (16h–17h30): restaurar fica desatualizado", async () => {
    await scheduleConflict();
    await rescheduleAppointment(f.deps, f.conn, { ...crm() }, { durationMinutes: 90 });
    expect(google().end).toEqual({ dateTime: H(17, 30) });

    expect(restoreLikeDatabase().status).toBe("outdated");
  });

  it("a ida ao Google falha (503): fica pendente; a nova tentativa, sem duração pedida, ainda leva 14h–15h", async () => {
    await scheduleConflict();
    restoreLikeDatabase();
    f.provider.injectFault({ operation: "patch", kind: "status", status: 503 });
    expect((await pushLikeAction()).status).toBe("pending");
    expect(linkOf()).toMatchObject({ syncState: "pending", durationMinutes: 60 });
    expect(google().start).toEqual({ dateTime: H(16) });

    expect((await pushLikeAction()).status).toBe("updated");
    expect(google().start).toEqual({ dateTime: H(14) });
    expect(google().end).toEqual({ dateTime: H(15) });
    expect(linkOf()).toMatchObject({ syncState: "in_sync", durationMinutes: 60 });
  });

  it("uma sincronização de entrada entre restaurar e levar ao Google não desfaz a duração restaurada", async () => {
    await scheduleConflict();
    restoreLikeDatabase();
    await syncCalendar(deps, own());
    expect(crm().dueAt).toBe(H(14));
    expect(linkOf().durationMinutes).toBe(60);

    await pushLikeAction();
    expect(google().end).toEqual({ dateTime: H(15) });
  });

  it("o Google mudou de novo (17h–19h) antes da ida: o Google prevalece outra vez, com o valor do CRM (14h–15h) gravado", async () => {
    await scheduleConflict();
    restoreLikeDatabase();
    f.provider.externalEdit(CALENDAR_ID, eventId, { start: { dateTime: H(17) }, end: { dateTime: H(19) } });

    expect((await pushLikeAction()).status).toBe("conflict_resolved");
    expect(crm().dueAt).toBe(H(17));
    expect(google().start).toEqual({ dateTime: H(17) });
    expect(f.store.conflicts.at(-1)).toMatchObject({
      field: "schedule",
      crmValue: { start: H(14), end: H(15) },
      googleValue: { start: H(17), end: H(19) },
    });
  });

  it("o CRM foi editado entre restaurar e levar ao Google: vale a edição mais nova, nada é sobrescrito", async () => {
    await scheduleConflict();
    restoreLikeDatabase();
    crm().dueAt = H(11);
    crm().lockVersion += 1;

    await pushLikeAction();
    expect(google().start).toEqual({ dateTime: H(11) });
    expect(google().end).toEqual({ dateTime: H(12) });
  });

  it("sem conflito nem restauração, reagendar no CRM continua mantendo a duração que o Google mudou", async () => {
    await setup(H(10));
    f.provider.externalEdit(CALENDAR_ID, eventId, { end: { dateTime: H(12) } }); // 2 h, só no Google
    crm().dueAt = H(15);
    crm().lockVersion += 1;

    await rescheduleAppointment(f.deps, f.conn, { ...crm() });
    expect(google().start).toEqual({ dateTime: H(15) });
    expect(google().end).toEqual({ dateTime: H(17) });
  });
});

// ---------------------------------------------------------------------
// 2. Batimento e saúde
// ---------------------------------------------------------------------

describe("2. falha total ou parcial não aparece como saúde normal", () => {
  const report = (extra: Partial<MaintenanceReport>): MaintenanceReport => ({
    targets: 3,
    synced: 0,
    full: 0,
    busy: 0,
    accessLost: 0,
    failed: 0,
    needsReauth: 0,
    conflicts: 0,
    channelsCreated: 0,
    channelsRenewed: 0,
    channelsStopped: 0,
    pollingOnly: 0,
    ...extra,
  });
  let store: MemorySchedulerStore;
  const scheduled = (r: MaintenanceReport, extra: Partial<ScheduledDeps> = {}): ScheduledDeps => ({
    maintenance: async () => r,
    store,
    now,
    schedulerEnabled: true,
    alertsEnabled: false,
    sendAlert: null,
    ...extra,
  });

  beforeEach(() => {
    clock = { t: Date.parse("2026-11-01T12:00:00.000Z") };
    store = new MemorySchedulerStore(now);
  });

  it("todas as agendas falharam (sem exceção): a rodada é falha, no resultado e no batimento", async () => {
    const result = await runScheduledMaintenance(scheduled(report({ failed: 3 })), "inngest");
    expect(result.outcome).toBe("failed");
    expect(store.heartbeats.get("inngest")!.lastOutcome).toBe("failed");
  });

  it("parte das agendas falhou: a rodada é parcial, não ok", async () => {
    const result = await runScheduledMaintenance(scheduled(report({ synced: 2, failed: 1 })), "inngest");
    expect(result.outcome).toBe("partial");
    expect(store.heartbeats.get("inngest")!.lastOutcome).toBe("partial");
  });

  it("Detector 1: principal rodou há pouco mas FALHOU — não é saudável, e não é \"atrasado\"", async () => {
    await runScheduledMaintenance(scheduled(report({ failed: 3 })), "inngest");
    clock.t += 10 * MIN;
    expect(await checkPrimaryScheduler(scheduled(report({}), { alertsEnabled: true }))).toBe("last_run_failed");
  });

  it("outra execução com a trava, sem acesso ou a reautorizar NÃO é falha da rodada", async () => {
    const result = await runScheduledMaintenance(scheduled(report({ synced: 1, busy: 1, accessLost: 1, needsReauth: 1 })), "inngest");
    expect(result.outcome).toBe("ok");
    expect(await checkPrimaryScheduler(scheduled(report({})))).toBe("healthy");
  });

  it("batimento separa \"executou\" de \"sincronizou com sucesso\": falha e parcial não avançam o último sucesso", async () => {
    await runScheduledMaintenance(scheduled(report({ synced: 3 })), "inngest");
    const success = now().toISOString();
    clock.t += 15 * MIN;
    await runScheduledMaintenance(scheduled(report({ synced: 2, failed: 1 })), "inngest");
    clock.t += 15 * MIN;
    await runScheduledMaintenance(scheduled(report({ failed: 3 })), "inngest");

    expect((await store.listHeartbeats())[0]).toEqual({
      scheduler: "inngest",
      lastRunAt: now().toISOString(),
      lastOutcome: "failed",
      lastSuccessAt: success,
    });
    expect(store.heartbeats.get("inngest")!.report).toMatchObject({ failed: 3, synced: 0 });
  });

  it("Detector 1: parcial é distinto de falha; atraso continua com o diagnóstico próprio, mesmo se a última rodada falhou", async () => {
    await runScheduledMaintenance(scheduled(report({ synced: 2, failed: 1 })), "inngest");
    expect(await checkPrimaryScheduler(scheduled(report({})))).toBe("last_run_partial");

    await runScheduledMaintenance(scheduled(report({ failed: 3 })), "inngest");
    clock.t += 61 * MIN;
    expect(await checkPrimaryScheduler(scheduled(report({})))).toBe("stale_alerts_disabled");
  });

  it("falha recente com os alertas LIGADOS: nenhum e-mail (o e-mail continua só para atraso) e nenhuma reserva", async () => {
    const sent: unknown[] = [];
    await runScheduledMaintenance(scheduled(report({ failed: 3 })), "inngest");
    const result = await runScheduledMaintenance(
      scheduled(report({ synced: 1 }), { alertsEnabled: true, sendAlert: async (msg) => void sent.push(msg) }),
      "github",
    );
    expect(result).toMatchObject({ outcome: "ok", detector: "last_run_failed" });
    expect(sent).toEqual([]);
    expect(store.alerts).toEqual([]);
  });

  it("Detector 2: falha com último sucesso conhecido, parcial e atraso têm mensagens distintas", () => {
    const at = (minutes: number) => new Date(clock.t - minutes * MIN).toISOString();
    const notice = (h: CalendarSyncHealth["schedulers"][number]) =>
      syncHealthNotices({ schedulers: [h], activeLinks: 2, channelsLowLife: 0 }, { now: now(), schedulerEnabled: true });

    expect(notice({ scheduler: "inngest", lastRunAt: at(5), lastOutcome: "failed", lastSuccessAt: at(95) })).toEqual([
      expect.objectContaining({ level: "warning", message: expect.stringMatching(/última execução falhou\. A última execução sem falhas foi há 95 minutos/) }),
    ]);
    expect(notice({ scheduler: "inngest", lastRunAt: at(5), lastOutcome: "partial", lastSuccessAt: at(20) })).toEqual([
      expect.objectContaining({ level: "warning", message: expect.stringMatching(/parte das agendas; as demais foram atualizadas/) }),
    ]);
    expect(notice({ scheduler: "inngest", lastRunAt: at(70), lastOutcome: "failed", lastSuccessAt: null })).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/atrasada: a última execução foi há 70 minutos/) }),
    ]);
    expect(notice({ scheduler: "github", lastRunAt: at(5), lastOutcome: "ok", lastSuccessAt: at(5) })).toEqual([]);
    // Integração com o agendador desligado: só o aviso informativo, qualquer que seja o batimento.
    expect(
      syncHealthNotices(
        { schedulers: [{ scheduler: "inngest", lastRunAt: at(5), lastOutcome: "failed", lastSuccessAt: null }], activeLinks: 2, channelsLowLife: 0 },
        { now: now(), schedulerEnabled: false },
      ),
    ).toEqual([expect.objectContaining({ level: "info" })]);
  });

  it("Detector 2: execução recente com falha não vira \"nenhuma execução registrada\"", () => {
    const health: CalendarSyncHealth = {
      schedulers: [{ scheduler: "inngest", lastRunAt: new Date(clock.t - 10 * MIN).toISOString(), lastOutcome: "failed", lastSuccessAt: null }],
      activeLinks: 2,
      channelsLowLife: 0,
    };
    const notices = syncHealthNotices(health, { now: now(), schedulerEnabled: true });
    expect(notices.map((n) => n.message).join(" ")).not.toMatch(/nenhuma execução registrada/);
    expect(notices).toEqual([expect.objectContaining({ level: "warning", message: expect.stringMatching(/falhou/) })]);
  });
});

// ---------------------------------------------------------------------
// 3. Reconexão retomável
// ---------------------------------------------------------------------

describe("3. a reconexão é retomável depois de revincular", () => {
  beforeEach(async () => {
    await setup(H(14));
    // Desconectar (como `disconnect_calendar_connection`) e reconectar a mesma conta.
    inbound.connections.get("conn-1")!.status = "disconnected";
    for (const l of f.store.links.values()) if (l.connectionId === "conn-1") l.status = "unlinked";
    inbound.connections.set("conn-2", { id: "conn-2", userId: "user-1", workspaceId: "ws-1", status: "active" });
    // Enquanto desconectado, o CRM remarcou: isto só chega ao Google pela recuperação.
    crm().dueAt = H(9);
    crm().lockVersion += 1;
    f.provider.calls.length = 0;
  });

  const recover = () =>
    recoverLinksAfterReconnect({ inbound: deps, outbound: f.deps }, { connectionId: "conn-2", userId: "user-1", accessToken: f.conn.accessToken });

  const expectNoDuplicates = () => {
    expect(countCalls(f.provider, "insert")).toBe(0);
    expect(f.provider.eventCount(CALENDAR_ID)).toBe(1);
    expect([...f.store.links.values()].filter((l) => l.activityId === ACTIVITY_ID)).toHaveLength(1);
  };

  it("entrada FALHA depois do relink: fica pendente, a saída não roda; repetir conclui", async () => {
    f.provider.injectFault({ operation: "list", kind: "status", status: 503 });
    const first = await recover();
    expect(first).toMatchObject({ relinked: 1, completed: 0, pending: 1, pushed: 0 });
    expect(google().start).toEqual({ dateTime: H(14) });

    const second = await recover();
    expect(second).toMatchObject({ candidates: 0, resumed: 1, completed: 1, pending: 0, pushed: 1 });
    expect(google().start).toEqual({ dateTime: H(9) });
    expectNoDuplicates();
  });

  it("entrada OCUPADA (outra execução com a trava): não conta como concluída; repetir conclui", async () => {
    await inbound.claimSync("user-1", "conn-2", CALENDAR_ID);
    expect(await recover()).toMatchObject({ relinked: 1, completed: 0, pending: 1, pushed: 0 });

    clock.t += 3 * MIN; // a trava vence
    expect(await recover()).toMatchObject({ resumed: 1, completed: 1, pushed: 1 });
    expect(google().start).toEqual({ dateTime: H(9) });
    expectNoDuplicates();
  });

  it("INTERRUPÇÃO depois do relink (processo cai): a próxima recuperação retoma e conclui", async () => {
    const claim = inbound.claimSync.bind(inbound);
    inbound.claimSync = async () => {
      inbound.claimSync = claim;
      throw new Error("interrompido");
    };
    await expect(recover()).rejects.toThrow("interrompido");
    expect(linkOf().connectionId).toBe("conn-2");

    expect(await recover()).toMatchObject({ candidates: 0, resumed: 1, completed: 1, pushed: 1 });
    expect(google().start).toEqual({ dateTime: H(9) });
    expectNoDuplicates();
  });

  it("saída FALHA (Google 503): pendente com resultado verdadeiro; repetir conclui", async () => {
    f.provider.injectFault({ operation: "patch", kind: "status", status: 503 });
    const first = await recover();
    expect(first).toMatchObject({ relinked: 1, completed: 0, pending: 1, pushed: 0 });
    expect(describeRecovery(first)).toMatch(/pendente/);

    const second = await recover();
    expect(second).toMatchObject({ resumed: 1, completed: 1, pushed: 1 });
    expect(describeRecovery(second)).toMatch(/concluíd/);
    expect(google().start).toEqual({ dateTime: H(9) });
    expectNoDuplicates();
  });

  it("saída perde o ACESSO (403): não é concluída; com o acesso de volta, repetir conclui", async () => {
    f.provider.injectFault({ operation: "patch", kind: "status", status: 403 });
    const first = await recover();
    expect(first).toMatchObject({ completed: 0, accessLost: 1 });
    expect(describeRecovery(first)).toMatch(/não alcança a agenda/);
    expect(await recover()).toMatchObject({ resumed: 1, completed: 1, pushed: 1 });
    expectNoDuplicates();
  });

  it("entrada sem ACESSO depois do relink: pendente por acesso, a saída não roda", async () => {
    f.provider.onBefore("list", () => f.provider.revokeCalendarAccess(CALENDAR_ID, 403));
    expect(await recover()).toMatchObject({ relinked: 1, completed: 0, accessLost: 1, pending: 0, pushed: 0 });
    expect(countCalls(f.provider, "patch")).toBe(0);

    f.provider.restoreCalendarAccess(CALENDAR_ID);
    expect(await recover()).toMatchObject({ resumed: 1, completed: 1, pushed: 1 });
    expectNoDuplicates();
  });

  it("a pendência fica identificável no banco até concluir, e não some da lista por causa do relink", async () => {
    f.provider.injectFault({ operation: "patch", kind: "status", status: 503 });
    await recover();
    // Já não é "recuperável" (voltou para a conexão nova)...
    expect(await inbound.listRecoverableLinks("user-1", "conn-2")).toEqual([]);
    // ...mas continua pendente, mesmo com o erro da saída por cima do "reconnected".
    expect(linkOf()).toMatchObject({ syncState: "pending", syncError: "provider_503" });
    expect(await inbound.listPendingRecoveries("user-1", "conn-2")).toEqual([expect.objectContaining({ id: linkOf().id, activityId: ACTIVITY_ID })]);

    await recover();
    expect(await inbound.listPendingRecoveries("user-1", "conn-2")).toEqual([]);
    expect(inbound.audit.filter((a) => a.action === "calendar.link.recovery_completed")).toHaveLength(1);
    // Nada mais a fazer: a tela não inventa resultado.
    const third = await recover();
    expect(third).toMatchObject({ candidates: 0, resumed: 0, completed: 0, pending: 0 });
    expect(describeRecovery(third)).toBeNull();
  });

  it("evento cancelado no Google entre o relink e a saída: concluída como \"não existe mais\", nada recriado", async () => {
    f.provider.onBefore("list", () => f.provider.externalEdit(CALENDAR_ID, eventId, { status: "cancelled" }));
    expect(await recover()).toMatchObject({ relinked: 1, completed: 1, gone: 1, pending: 0, pushed: 0 });
    expect(countCalls(f.provider, "insert")).toBe(0);
    expect(await inbound.listPendingRecoveries("user-1", "conn-2")).toEqual([]);
  });

  it("a pendência é só da PRÓPRIA conexão: outro usuário não lista nem conclui", async () => {
    f.provider.injectFault({ operation: "patch", kind: "status", status: 503 });
    await recover();
    await expect(inbound.listPendingRecoveries("user-2", "conn-2")).rejects.toThrow("connection_not_found");
    await expect(inbound.finishRecovery("user-2", linkOf().id, "conn-2")).rejects.toThrow("connection_not_found");
    expect(await inbound.listPendingRecoveries("user-1", "conn-2")).toHaveLength(1);
  });
});
