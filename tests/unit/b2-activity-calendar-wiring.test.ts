/**
 * @vitest-environment node
 *
 * B2 — as ações de atividade que já existiam (criar, editar, reagendar,
 * excluir) agora levam o compromisso ao Google Agenda. Orquestrador REAL,
 * provedor simulado e armazenamento em memória; só o que fala com Supabase
 * (RPCs de atividade, sessão, vínculo) é substituído. Dados fictícios.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { zonedInstant } from "@/lib/timezone";
import { deterministicEventId } from "@/server/calendar/sync/ids";

import { CALENDAR_ID, makeFixture } from "../support/calendar-fixture";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";

const m = vi.hoisted(() => ({
  provider: { value: null as unknown },
  store: { value: null as unknown },
  conn: { value: null as unknown },
  activities: new Map<string, Record<string, unknown>>(),
  rpcLog: [] as Array<{ name: string; googleStatusAtCall?: string | undefined }>,
  onDelete: { fn: undefined as undefined | (() => string | undefined) },
  syncStoreCalls: { count: 0 },
  permission: { allowCalendar: true },
  hasConnection: { value: true },
  nextId: { n: 0 },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/authz/safe", () => ({
  requirePermissionSafe: async (permission: string) => {
    if (permission === "calendar.connect_own" && !m.permission.allowCalendar) return { error: "Você não tem permissão para fazer isso." };
    return { ctx: { userId: USER, workspaceId: WS } };
  },
}));
vi.mock("@/server/authz/permissions", () => ({ requireMembership: async () => ({ workspaceId: WS }) }));
vi.mock("@/server/calendar/provider", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCalendarProvider: async () => m.provider.value,
}));
vi.mock("@/server/calendar/admin/sync-store", () => ({
  createSupabaseSyncStore: () => {
    m.syncStoreCalls.count += 1;
    return m.store.value;
  },
}));
vi.mock("@/server/calendar/connection-context", () => ({ loadConnectionContext: async () => m.conn.value }));
vi.mock("@/modules/calendar/queries", () => ({
  listCalendarConnections: async () =>
    m.hasConnection.value ? [{ id: "conn-1", isMine: true, calendarId: "principal@calendar.simulated", status: "active" }] : [],
}));
vi.mock("@/modules/activities/queries", () => ({
  getActivity: async (id: string) => (m.activities.has(id) ? { workspaceId: WS, ...m.activities.get(id) } : null),
  listActivities: vi.fn(),
}));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "list_activity_calendar_links") {
        // Mesma regra da migration (vínculo ativo / inclusão incerta).
        const { createHarness, fakeActivityRpc } = await import("../support/calendar-activity-harness");
        return fakeActivityRpc(createHarness(), m.store.value as never, name, args);
      }
      if (name === "create_activity") {
        m.nextId.n += 1;
        const id = `a1b2c3d4-0000-4000-8000-0000000b${String(m.nextId.n).padStart(4, "0")}`;
        const time = args.p_due_time as string | undefined;
        m.activities.set(id, {
          id,
          title: args.p_title,
          dueAt: zonedInstant(args.p_due_date as string, time ?? "00:00"),
          hasTime: Boolean(time),
          type: args.p_type,
          lockVersion: 1,
        });
        m.rpcLog.push({ name });
        return { data: id, error: null };
      }
      const id = args.p_activity_id as string;
      const current = m.activities.get(id);
      if (name === "reschedule_activity" && current) {
        current.dueAt = zonedInstant(args.p_due_date as string, (args.p_due_time as string) ?? "00:00");
        current.lockVersion = (current.lockVersion as number) + 1;
      }
      if (name === "update_activity" && current) {
        if (args.p_title) current.title = args.p_title;
        current.lockVersion = (current.lockVersion as number) + 1;
      }
      if (name === "delete_activity") {
        m.rpcLog.push({ name, googleStatusAtCall: m.onDelete.fn?.() });
        m.activities.delete(id);
        return { data: null, error: null };
      }
      m.rpcLog.push({ name });
      return { data: null, error: null };
    },
  }),
}));

import {
  createActivityAction,
  deleteActivityAction,
  rescheduleActivityAction,
  updateActivityAction,
} from "@/modules/activities/actions";
import type { MemoryStore } from "../support/calendar-memory-store";
import type { SimulatedCalendarProvider } from "@/server/calendar/simulated-provider";

let f: Awaited<ReturnType<typeof makeFixture>>;

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

const MEETING = {
  leadId: LEAD,
  type: "meeting",
  title: "Reunião de teste fictícia",
  dueDate: "2026-11-10",
  dueTime: "14:00",
};

function eventOf(provider: SimulatedCalendarProvider, store: MemoryStore, activityId: string) {
  const link = [...store.links.values()].find((l) => l.activityId === activityId);
  return { link, event: link ? provider.peek(link.calendarId, link.eventId) : undefined };
}

beforeEach(async () => {
  f = await makeFixture();
  m.provider.value = f.provider;
  m.store.value = f.store;
  m.conn.value = f.conn;
  m.activities.clear();
  m.rpcLog.length = 0;
  m.onDelete.fn = undefined;
  m.syncStoreCalls.count = 0;
  m.permission.allowCalendar = true;
  m.hasConnection.value = true;
  m.nextId.n = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** Cria uma reunião já na agenda, pela ação de atividade. */
async function reuniaoNaAgenda(extra: Record<string, string> = {}) {
  const result = await createActivityAction({ ok: false }, form({ ...MEETING, calendarAdd: "on", ...extra }));
  expect(result.ok).toBe(true);
  const activityId = result.activityId!;
  return { activityId, ...eventOf(f.provider, f.store, activityId) };
}

describe("integração desligada: nada muda", () => {
  beforeEach(() => {
    m.provider.value = null;
  });

  it("criar, editar, reagendar e excluir não tocam em nada de B2", async () => {
    const created = await createActivityAction({ ok: false }, form(MEETING));
    expect(created).toEqual({ ok: true, activityId: expect.any(String) });
    const id = created.activityId!;

    expect(await updateActivityAction({ ok: false }, form({ activityId: id, lockVersion: "1", title: "Novo" }))).toEqual({ ok: true, activityId: id });
    expect(await rescheduleActivityAction(id, 2, "2026-11-12", "10:00")).toEqual({ ok: true, activityId: id });
    expect(await deleteActivityAction(id)).toEqual({ ok: true });

    expect(m.syncStoreCalls.count).toBe(0);
    expect(f.provider.calls).toEqual([]);
  });

  it("pedir o Google Agenda com a integração desligada é recusado ANTES de criar a atividade", async () => {
    const result = await createActivityAction({ ok: false }, form({ ...MEETING, calendarAdd: "on" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("não está configurada");
    expect(m.rpcLog).toEqual([]);
  });
});

describe("criar atividade já na agenda", () => {
  it("reunião com horário: cria a atividade e o evento (60 min, sem convidados, sem e-mail, sem Meet)", async () => {
    const { activityId, link, event } = await reuniaoNaAgenda();
    expect(link).toMatchObject({ status: "linked", durationMinutes: 60 });
    expect(event?.start?.dateTime).toBe("2026-11-10T17:00:00.000Z"); // 14:00 em São Paulo
    expect(event?.end?.dateTime).toBe("2026-11-10T18:00:00.000Z");
    expect(event?.attendees).toBeUndefined();
    expect(event?.conferenceData).toBeUndefined();
    expect(f.provider.notificationsSent).toEqual([]);
    expect(m.activities.has(activityId)).toBe(true);
  });

  it("duração editável e Meet opcional", async () => {
    const { link, event } = await reuniaoNaAgenda({ durationMinutes: "90", withMeet: "on" });
    expect(link).toMatchObject({ durationMinutes: 90, meetStatus: "success" });
    expect(event?.end?.dateTime).toBe("2026-11-10T18:30:00.000Z");
    expect(event?.conferenceData?.entryPoints).toHaveLength(1);
  });

  it("resultado traz o aviso de sucesso com o link do Meet", async () => {
    const result = await createActivityAction({ ok: false }, form({ ...MEETING, calendarAdd: "on", withMeet: "on" }));
    expect(result.calendar).toMatchObject({ level: "success", meetUrl: expect.stringContaining("meet") });
  });

  it("convidados SEM confirmação: recusado antes de criar a atividade", async () => {
    const result = await createActivityAction({ ok: false }, form({ ...MEETING, calendarAdd: "on", inviteEmails: "convidado@exemplo.test" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Confirme explicitamente");
    expect(m.rpcLog).toEqual([]);
    expect(f.provider.notificationsSent).toEqual([]);
  });

  it("convidados COM confirmação: o Google envia o convite", async () => {
    const { event } = await reuniaoNaAgenda({ inviteEmails: "convidado@exemplo.test", confirmInvites: "on" });
    expect(event?.attendees).toEqual([{ email: "convidado@exemplo.test" }]);
    expect(f.provider.notificationsSent).toEqual([{ eventId: expect.any(String), to: ["convidado@exemplo.test"] }]);
  });

  it("e-mail de convidado inválido: recusado antes de criar", async () => {
    const result = await createActivityAction(
      { ok: false },
      form({ ...MEETING, calendarAdd: "on", inviteEmails: "isto-nao-e-email", confirmInvites: "on" }),
    );
    expect(result.ok).toBe(false);
    expect(m.rpcLog).toEqual([]);
  });

  it("duração fora de 15–480: recusada antes de criar", async () => {
    const result = await createActivityAction({ ok: false }, form({ ...MEETING, calendarAdd: "on", durationMinutes: "600" }));
    expect(result.ok).toBe(false);
    expect(m.rpcLog).toEqual([]);
  });

  it("horário ocupado com 'só criar se livre': recusado antes de criar a atividade", async () => {
    f.provider.addExternalEvent(CALENDAR_ID, "2026-11-10T17:30:00.000Z", "2026-11-10T18:30:00.000Z");
    const result = await createActivityAction({ ok: false }, form({ ...MEETING, calendarAdd: "on", requireFree: "on" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ocupado");
    expect(m.rpcLog).toEqual([]);
  });

  it("horário ocupado SEM exigir livre: cria normalmente", async () => {
    f.provider.addExternalEvent(CALENDAR_ID, "2026-11-10T17:30:00.000Z", "2026-11-10T18:30:00.000Z");
    const { link } = await reuniaoNaAgenda();
    expect(link?.status).toBe("linked");
  });

  it("só reunião com horário vai para a agenda", async () => {
    const task = await createActivityAction({ ok: false }, form({ ...MEETING, type: "task", calendarAdd: "on" }));
    const semHora = await createActivityAction({ ok: false }, form({ leadId: LEAD, type: "meeting", title: "x", dueDate: "2026-11-10", calendarAdd: "on" }));
    expect(task.ok).toBe(false);
    expect(semHora.ok).toBe(false);
    expect(m.rpcLog).toEqual([]);
  });

  it("sem pedir a agenda, a atividade nasce só no CRM (nenhuma chamada ao Google)", async () => {
    const result = await createActivityAction({ ok: false }, form(MEETING));
    expect(result).toEqual({ ok: true, activityId: expect.any(String) });
    expect(f.provider.calls).toEqual([]);
  });

  it("falha no Google depois de criar: a atividade FICA e o aviso explica", async () => {
    f.provider.injectFault({ operation: "insert", kind: "status", status: 500 });
    const result = await createActivityAction({ ok: false }, form({ ...MEETING, calendarAdd: "on" }));
    expect(result.ok).toBe(true);
    expect(result.calendar).toMatchObject({ level: "warning" });
    expect(m.activities.size).toBe(1);
  });

  it("sem conexão própria: recusado antes de criar", async () => {
    m.hasConnection.value = false;
    const result = await createActivityAction({ ok: false }, form({ ...MEETING, calendarAdd: "on" }));
    expect(result.ok).toBe(false);
    expect(m.rpcLog).toEqual([]);
  });
});

describe("reagendar atividade vinculada", () => {
  it("o novo horário vai ao Google, mantendo a duração", async () => {
    const { activityId, link } = await reuniaoNaAgenda({ durationMinutes: "90" });
    const result = await rescheduleActivityAction(activityId, 1, "2026-11-12", "16:00");
    expect(result.ok).toBe(true);
    expect(result.calendar).toMatchObject({ level: "success" });
    const event = f.provider.peek(link!.calendarId, link!.eventId);
    expect(event?.start?.dateTime).toBe("2026-11-12T19:00:00.000Z");
    expect(event?.end?.dateTime).toBe("2026-11-12T20:30:00.000Z"); // 90 min preservados
  });

  it("duração alterada pelo usuário vale (15–480)", async () => {
    const { activityId, link } = await reuniaoNaAgenda();
    await rescheduleActivityAction(activityId, 1, "2026-11-10", "14:00", undefined, { durationMinutes: 120 });
    const event = f.provider.peek(link!.calendarId, link!.eventId);
    expect(event?.end?.dateTime).toBe("2026-11-10T19:00:00.000Z");
  });

  it("atividade SEM vínculo: nada é feito no Google", async () => {
    const created = await createActivityAction({ ok: false }, form(MEETING));
    const before = f.provider.calls.length;
    const result = await rescheduleActivityAction(created.activityId!, 1, "2026-11-12", "16:00");
    expect(result).toEqual({ ok: true, activityId: created.activityId });
    expect(f.provider.calls.length).toBe(before);
  });

  it("vinculada à agenda de OUTRA pessoa: recusado ANTES de salvar (nem CRM nem Google mudam)", async () => {
    const created = await createActivityAction({ ok: false }, form(MEETING));
    f.store.seedLink({ activityId: created.activityId!, eventId: "evento-de-outra-pessoa", connectionId: "conn-9" });
    const antes = (m.activities.get(created.activityId!) as { dueAt: string }).dueAt;
    const result = await rescheduleActivityAction(created.activityId!, 1, "2026-11-12", "16:00");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("outra pessoa");
    expect((m.activities.get(created.activityId!) as { dueAt: string }).dueAt).toBe(antes);
    expect(f.provider.calls).toEqual([]);
  });

  it("falha no Google: o CRM já mudou e o resultado continua ok, com aviso", async () => {
    const { activityId } = await reuniaoNaAgenda();
    f.provider.injectFault({ operation: "get", kind: "status", status: 500 });
    const result = await rescheduleActivityAction(activityId, 1, "2026-11-12", "16:00");
    expect(result.ok).toBe(true);
    expect(result.calendar?.level).toBe("warning");
    expect((m.activities.get(activityId) as { dueAt: string }).dueAt).toBe("2026-11-12T19:00:00.000Z");
  });

  it("acesso à agenda perdido: aviso explícito e vínculo pendente", async () => {
    const { activityId, link } = await reuniaoNaAgenda();
    f.provider.revokeCalendarAccess(link!.calendarId, 404);
    const result = await rescheduleActivityAction(activityId, 1, "2026-11-12", "16:00");
    expect(result.calendar).toMatchObject({ level: "warning", message: expect.stringContaining("acessar a agenda") });
    expect([...f.store.links.values()][0]).toMatchObject({ status: "needs_attention", baseCancelled: false });
  });
});

describe("editar título de atividade vinculada", () => {
  it("o título novo vai ao Google", async () => {
    const { activityId, link } = await reuniaoNaAgenda();
    const result = await updateActivityAction({ ok: false }, form({ activityId, lockVersion: "1", title: "Título novo fictício" }));
    expect(result.ok).toBe(true);
    expect(f.provider.peek(link!.calendarId, link!.eventId)?.summary).toBe("Título novo fictício");
  });
});

describe("excluir atividade vinculada", () => {
  it("o evento sai do Google ANTES de a atividade ser excluída", async () => {
    const { activityId, link } = await reuniaoNaAgenda();
    m.onDelete.fn = () => f.provider.peek(link!.calendarId, link!.eventId)?.status;

    const result = await deleteActivityAction(activityId);

    expect(result.ok).toBe(true);
    expect(result.calendar).toMatchObject({ level: "success" });
    expect(m.rpcLog.at(-1)).toEqual({ name: "delete_activity", googleStatusAtCall: "cancelled" });
    expect(m.activities.has(activityId)).toBe(false);
  });

  it("agenda inacessível: a atividade NÃO é excluída e o motivo aparece", async () => {
    const { activityId, link } = await reuniaoNaAgenda();
    f.provider.revokeCalendarAccess(link!.calendarId, 403);

    const result = await deleteActivityAction(activityId);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("não foi excluída");
    expect(m.rpcLog.some((r) => r.name === "delete_activity")).toBe(false);
    expect(m.activities.has(activityId)).toBe(true);
  });

  it("resultado incerto no Google: a atividade NÃO é excluída", async () => {
    const { activityId } = await reuniaoNaAgenda();
    f.provider.injectFault({ operation: "get", kind: "timeout_before_apply" });
    const result = await deleteActivityAction(activityId);
    expect(result.ok).toBe(false);
    expect(m.activities.has(activityId)).toBe(true);
  });

  it("evento editado no Google desde a última sincronização: a atividade NÃO é excluída e nada fica abandonado", async () => {
    const { activityId, link } = await reuniaoNaAgenda();
    f.provider.externalEdit(link!.calendarId, link!.eventId, { summary: "Editado direto no Google" });
    const result = await deleteActivityAction(activityId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("NÃO foi removido");
    expect(f.provider.peek(link!.calendarId, link!.eventId)?.status).toBe("confirmed");
    expect(m.activities.has(activityId)).toBe(true);
    expect(await f.store.getLink(activityId)).not.toBeNull();
  });

  it("vinculada à agenda de OUTRA pessoa: exclusão recusada, atividade e vínculo permanecem", async () => {
    const created = await createActivityAction({ ok: false }, form(MEETING));
    f.store.seedLink({ activityId: created.activityId!, eventId: "evento-de-outra-pessoa", connectionId: "conn-9" });
    const result = await deleteActivityAction(created.activityId!);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("outra pessoa");
    expect(m.activities.has(created.activityId!)).toBe(true);
    expect(f.provider.calls).toEqual([]);
  });

  it("atividade sem vínculo: exclusão comum", async () => {
    const created = await createActivityAction({ ok: false }, form(MEETING));
    expect(await deleteActivityAction(created.activityId!)).toEqual({ ok: true });
    expect(f.provider.calls).toEqual([]);
  });
});

describe("papel sem permissão de agenda", () => {
  it("as ações de atividade continuam funcionando e nada vai ao Google", async () => {
    const { activityId } = await reuniaoNaAgenda();
    const before = f.provider.calls.length;
    m.permission.allowCalendar = false;
    expect((await rescheduleActivityAction(activityId, 1, "2026-11-12", "16:00")).ok).toBe(true);
    expect(f.provider.calls.length).toBe(before);
  });
});

it("o id do evento criado é o determinístico do compromisso", async () => {
  const { activityId, link } = await reuniaoNaAgenda();
  expect(link?.eventId).toBe(deterministicEventId("preview", activityId, 1));
});
