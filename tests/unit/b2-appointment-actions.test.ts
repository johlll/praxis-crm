/**
 * @vitest-environment node
 *
 * B2, etapa 2 — camada de ação dos compromissos: permissão, provedor
 * ausente, identidade vinda da SESSÃO (nunca do formulário) e mensagens
 * amigáveis para as recusas do orquestrador e do banco.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  provider: vi.fn(),
  listConnections: vi.fn(),
  loadContext: vi.fn(),
  getActivity: vi.fn(),
  createAppointment: vi.fn(),
  cancelAppointment: vi.fn(),
  reschedule: vi.fn(),
  addMeet: vi.fn(),
  availability: vi.fn(),
  store: vi.fn(),
  permission: { value: undefined as unknown },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/authz/safe", () => ({ requirePermissionSafe: async () => m.permission.value }));
vi.mock("@/server/calendar/provider", () => ({ getCalendarProvider: () => m.provider() }));
vi.mock("@/modules/calendar/queries", () => ({ listCalendarConnections: m.listConnections }));
vi.mock("@/server/calendar/connection-context", () => ({ loadConnectionContext: m.loadContext }));
vi.mock("@/modules/activities/queries", () => ({ getActivity: m.getActivity }));
vi.mock("@/server/calendar/admin/sync-store", () => ({ createSupabaseSyncStore: m.store }));
vi.mock("@/server/calendar/sync/appointments", () => ({
  createAppointment: m.createAppointment,
  cancelAppointment: m.cancelAppointment,
  rescheduleAppointment: m.reschedule,
  addMeetToAppointment: m.addMeet,
  getAvailability: m.availability,
}));

import {
  addMeetAction,
  cancelAppointmentAction,
  checkAvailabilityAction,
  createAppointmentAction,
  rescheduleAppointmentAction,
} from "@/modules/calendar/appointment-actions";
import { CalendarSyncError } from "@/server/calendar/sync/types";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const ACT = "33333333-3333-4333-8333-333333333333";

function form(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.permission.value = { ctx: { userId: USER, workspaceId: WS } };
  m.provider.mockResolvedValue({ api: "provedor" });
  m.listConnections.mockResolvedValue([{ id: "c1", isMine: true, calendarId: "cal@x", status: "active" }]);
  m.loadContext.mockResolvedValue({ connectionId: "c1", calendarId: "cal@x", environment: "preview", accessToken: "tok" });
  m.getActivity.mockResolvedValue({ id: ACT, title: "Reunião", dueAt: "2026-11-10T14:00:00.000Z", hasTime: true, type: "meeting", lockVersion: 2 });
  m.store.mockReturnValue({ marker: "store" });
});

describe("permissão e pré-requisitos", () => {
  it.each([
    ["criar", () => createAppointmentAction({ ok: false }, form({ activityId: ACT }))],
    ["reagendar", () => rescheduleAppointmentAction({ ok: false }, form({ activityId: ACT }))],
    ["Meet", () => addMeetAction({ ok: false }, form({ activityId: ACT }))],
    ["cancelar", () => cancelAppointmentAction({ ok: false }, form({ activityId: ACT }))],
    ["disponibilidade", () => checkAvailabilityAction({ ok: false }, form({ from: "2026-11-10T00:00:00.000Z", to: "2026-11-11T00:00:00.000Z" }))],
  ])("%s: sem permissão não toca em nada", async (_nome, run) => {
    m.permission.value = { error: "Você não tem permissão para fazer isso." };
    const r = await run();
    expect(r.ok).toBe(false);
    expect(m.provider).not.toHaveBeenCalled();
    expect(m.getActivity).not.toHaveBeenCalled();
  });

  it("sem provedor configurado: mensagem clara e nenhuma consulta de B2", async () => {
    m.provider.mockResolvedValue(null);
    const r = await createAppointmentAction({ ok: false }, form({ activityId: ACT }));
    expect(r).toEqual({ ok: false, error: expect.stringContaining("não está configurada") });
    expect(m.listConnections).not.toHaveBeenCalled();
  });

  it("sem conexão própria: recusa", async () => {
    m.listConnections.mockResolvedValue([{ id: "c9", isMine: false, calendarId: "x", status: "active" }]);
    const r = await createAppointmentAction({ ok: false }, form({ activityId: ACT }));
    expect(r.ok).toBe(false);
    expect(m.createAppointment).not.toHaveBeenCalled();
  });

  it("atividade fora do alcance da sessão: recusa antes do orquestrador", async () => {
    m.getActivity.mockResolvedValue(null);
    const r = await cancelAppointmentAction({ ok: false }, form({ activityId: ACT }));
    expect(r).toEqual({ ok: false, error: "Atividade não encontrada." });
    expect(m.cancelAppointment).not.toHaveBeenCalled();
  });
});

describe("identidade e ambiente vêm do servidor", () => {
  it("o store e o contexto usam o usuário e o workspace da SESSÃO, não os do formulário", async () => {
    m.createAppointment.mockResolvedValue({ status: "created", meet: { status: null, url: null } });
    await createAppointmentAction(
      { ok: false },
      form({ activityId: ACT, workspaceId: "ataque", userId: "ataque", environment: "production" }),
    );

    expect(m.store).toHaveBeenCalledWith(USER);
    expect(m.loadContext).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, actorUserId: USER }));
    const deps = m.createAppointment.mock.calls[0]![0];
    expect(deps.environment).toBe("preview"); // VERCEL_ENV do servidor, nunca "production" do formulário
  });
});

describe("resultados e recusas", () => {
  it("convidados sem confirmação: o orquestrador recusa e a mensagem é amigável", async () => {
    m.createAppointment.mockRejectedValue(new CalendarSyncError("invites_require_confirmation"));
    const r = await createAppointmentAction({ ok: false }, form({ activityId: ACT, inviteEmails: "a@exemplo.test" }));
    expect(r).toEqual({ ok: false, error: expect.stringContaining("Confirme explicitamente") });
    expect(m.createAppointment.mock.calls[0]![3]).toMatchObject({ invite: { emails: ["a@exemplo.test"], confirmed: false } });
  });

  it("sem pedir convite, nenhum convite é enviado ao orquestrador", async () => {
    m.createAppointment.mockResolvedValue({ status: "created", meet: { status: null, url: null } });
    await createAppointmentAction({ ok: false }, form({ activityId: ACT }));
    expect(m.createAppointment.mock.calls[0]![3]).not.toHaveProperty("invite");
  });

  it("horário ocupado devolve os intervalos (sem títulos) e não é sucesso", async () => {
    m.createAppointment.mockResolvedValue({ status: "busy", busy: [{ start: "a", end: "b" }] });
    const r = await createAppointmentAction({ ok: false }, form({ activityId: ACT, requireFree: "on" }));
    expect(r).toEqual({ ok: false, result: "busy", busy: [{ start: "a", end: "b" }] });
  });

  it("vínculo de outro ambiente: mensagem amigável e registro estruturado no servidor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.reschedule.mockRejectedValue(new CalendarSyncError("calendar_environment_mismatch"));
    const r = await rescheduleAppointmentAction({ ok: false }, form({ activityId: ACT }));
    expect(r).toEqual({ ok: false, error: expect.stringContaining("outro ambiente") });
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({ event: "calendar_environment_mismatch", userId: USER, workspaceId: WS });
    warn.mockRestore();
  });

  it("vínculo de outra conexão: mensagem clara, sem tratar como evento apagado", async () => {
    m.reschedule.mockRejectedValue(new CalendarSyncError("link_connection_mismatch"));
    const r = await rescheduleAppointmentAction({ ok: false }, form({ activityId: ACT }));
    expect(r).toEqual({ ok: false, error: expect.stringContaining("outra conexão") });
  });

  it.each([
    ["reagendar", () => rescheduleAppointmentAction({ ok: false }, form({ activityId: ACT })), () => m.reschedule],
    ["cancelar", () => cancelAppointmentAction({ ok: false }, form({ activityId: ACT })), () => m.cancelAppointment],
  ])("%s com acesso à agenda perdido: não é sucesso e explica a pendência", async (_nome, run, mock) => {
    mock().mockResolvedValue({ status: "access_lost" });
    const r = await run();
    expect(r).toMatchObject({ ok: false, result: "access_lost", error: expect.stringContaining("pendente") });
  });

  it("o orquestrador relê a atividade pela SESSÃO (mesmo alcance e RLS da leitura inicial)", async () => {
    m.reschedule.mockResolvedValue({ status: "unchanged", meet: { status: null, url: null } });
    await rescheduleAppointmentAction({ ok: false }, form({ activityId: ACT }));
    const deps = m.reschedule.mock.calls[0]![0];
    m.getActivity.mockClear();
    m.getActivity.mockResolvedValue({ id: ACT, title: "Editada", dueAt: "2026-11-11T10:00:00.000Z", hasTime: true, type: "meeting", lockVersion: 7 });

    expect(await deps.loadActivity(ACT)).toEqual({ id: ACT, title: "Editada", dueAt: "2026-11-11T10:00:00.000Z", hasTime: true, type: "meeting", lockVersion: 7 });
    expect(m.getActivity).toHaveBeenCalledWith(ACT);

    m.getActivity.mockResolvedValue(null);
    expect(await deps.loadActivity(ACT)).toBeNull();
  });

  it("Meet criado: devolve o link", async () => {
    m.addMeet.mockResolvedValue({ status: "updated", meet: { status: "success", url: "https://meet.simulated/x" } });
    expect(await addMeetAction({ ok: false }, form({ activityId: ACT }))).toMatchObject({
      ok: true,
      result: "updated",
      meetUrl: "https://meet.simulated/x",
      notice: { level: "success", message: "Link do Meet criado.", meetUrl: "https://meet.simulated/x" },
    });
  });

  it("resultado incerto não é sucesso", async () => {
    m.cancelAppointment.mockResolvedValue({ status: "uncertain", intentId: "i" });
    const r = await cancelAppointmentAction({ ok: false }, form({ activityId: ACT }));
    expect(r).toMatchObject({ ok: false, result: "uncertain" });
  });

  it("disponibilidade devolve só os intervalos", async () => {
    m.availability.mockResolvedValue([{ start: "s", end: "e" }]);
    const r = await checkAvailabilityAction({ ok: false }, form({ from: "2026-11-10T00:00:00.000Z", to: "2026-11-11T00:00:00.000Z" }));
    expect(r).toEqual({ ok: true, busy: [{ start: "s", end: "e" }] });
  });
});
