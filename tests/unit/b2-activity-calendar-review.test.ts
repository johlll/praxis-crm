/**
 * @vitest-environment node
 *
 * B2 — revisão da PR #26: reproduções das decisões de produto (vínculo de
 * outra pessoa bloqueia título/horário/duração/tipo/exclusão; nada é
 * desvinculado nem abandonado no Google) e dos pontos A (tipo/horário/duração
 * conferidos antes da escrita), B (pendência que sobrevive ao recarregar) e C
 * (mensagens fiéis ao resultado). Orquestrador REAL, provedor simulado e
 * dados fictícios.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CALENDAR_ID, makeFixture } from "../support/calendar-fixture";
import { createHarness, fakeActivityRpc, type Harness } from "../support/calendar-activity-harness";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";

const m = vi.hoisted(() => ({
  f: { value: null as unknown },
  h: { value: null as unknown },
  provider: { on: true },
  connectionFails: { value: null as null | string },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/authz/safe", () => ({
  requirePermissionSafe: async () => ({ ctx: { userId: USER, workspaceId: WS } }),
}));
vi.mock("@/server/authz/permissions", () => ({ requireMembership: async () => ({ workspaceId: WS }) }));
vi.mock("@/server/calendar/provider", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCalendarProvider: async () => (m.provider.on ? (m.f.value as { provider: unknown }).provider : null),
}));
vi.mock("@/server/calendar/admin/sync-store", () => ({
  createSupabaseSyncStore: () => (m.f.value as { store: unknown }).store,
}));
vi.mock("@/server/calendar/connection-context", () => ({
  loadConnectionContext: async () => {
    if (m.connectionFails.value) throw new Error(m.connectionFails.value);
    return (m.f.value as { conn: unknown }).conn;
  },
}));
vi.mock("@/modules/calendar/queries", () => ({
  listCalendarConnections: async () => [
    { id: "conn-1", isMine: true, calendarId: "principal@calendar.simulated", status: "active" },
  ],
}));
vi.mock("@/modules/activities/queries", () => ({
  getActivity: async (id: string) => {
    const h = m.h.value as Harness;
    const a = h.activities.get(id);
    return a ? { workspaceId: WS, ...a } : null;
  },
  listActivities: vi.fn(),
}));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) =>
      fakeActivityRpc(m.h.value as Harness, (m.f.value as { store: never }).store, name, args),
  }),
}));

import {
  createActivityAction,
  deleteActivityAction,
  rescheduleActivityAction,
  updateActivityAction,
} from "@/modules/activities/actions";
import {
  addMeetAction,
  cancelAppointmentAction,
  recoverUncertainCreateAction,
  rescheduleAppointmentAction,
} from "@/modules/calendar/appointment-actions";
import { readActivityCalendarInfo } from "@/modules/calendar/activity-links";

let f: Awaited<ReturnType<typeof makeFixture>>;
let h: Harness;

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

const MEETING = { leadId: LEAD, type: "meeting", title: "Reunião fictícia", dueDate: "2026-11-10", dueTime: "14:00" };

beforeEach(async () => {
  f = await makeFixture();
  h = createHarness();
  m.f.value = f;
  m.h.value = h;
  m.provider.on = true;
  m.connectionFails.value = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function minhaReuniao(extra: Record<string, string> = {}) {
  const r = await createActivityAction({ ok: false }, form({ ...MEETING, calendarAdd: "on", ...extra }));
  expect(r.ok).toBe(true);
  const id = r.activityId!;
  const link = [...f.store.links.values()].find((l) => l.activityId === id)!;
  h.rpcLog.length = 0;
  return { id, link };
}

async function reuniaoDeOutraPessoa() {
  const r = await createActivityAction({ ok: false }, form(MEETING));
  const id = r.activityId!;
  f.store.seedLink({ activityId: id, eventId: "evento-da-outra-pessoa", connectionId: "conn-9" });
  h.rpcLog.length = 0;
  return id;
}

const wrote = (name: string) => h.rpcLog.some((r) => r.name === name);

// ---------------------------------------------------------------------
// Decisão 1 — vínculo de outra pessoa bloqueia título/horário/duração/exclusão
// ---------------------------------------------------------------------

describe("decisão 1 — compromisso na agenda de outra pessoa", () => {
  it("reagendar é recusado ANTES de qualquer escrita", async () => {
    const id = await reuniaoDeOutraPessoa();
    const antes = h.activities.get(id)!.dueAt;

    const r = await rescheduleActivityAction(id, 1, "2026-11-12", "16:00");

    expect(r.ok).toBe(false);
    expect(r.error).toContain("outra pessoa");
    expect(wrote("reschedule_activity")).toBe(false);
    expect(h.activities.get(id)!.dueAt).toBe(antes);
    expect(f.provider.calls).toEqual([]);
  });

  it("mudar o título é recusado antes da escrita", async () => {
    const id = await reuniaoDeOutraPessoa();
    const r = await updateActivityAction({ ok: false }, form({ activityId: id, lockVersion: "1", title: "Outro título" }));
    expect(r.ok).toBe(false);
    expect(wrote("update_activity")).toBe(false);
  });

  it("notas e prioridade continuam editáveis, sem sincronização", async () => {
    const id = await reuniaoDeOutraPessoa();
    const r = await updateActivityAction(
      { ok: false },
      form({ activityId: id, lockVersion: "1", title: "Reunião fictícia", notes: "Levar documentos", priority: "alta" }),
    );
    expect(r).toEqual({ ok: true, activityId: id });
    expect(wrote("update_activity")).toBe(true);
    expect(f.provider.calls).toEqual([]);
  });

  it("excluir é recusado: a atividade e o vínculo permanecem", async () => {
    const id = await reuniaoDeOutraPessoa();
    const r = await deleteActivityAction(id);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outra pessoa");
    expect(wrote("delete_activity")).toBe(false);
    expect(h.activities.has(id)).toBe(true);
    expect(await f.store.getLink(id)).not.toBeNull();
  });
});

describe("compromisso meu: só sincroniza o que importa", () => {
  it("editar só notas/prioridade NÃO chama o Google", async () => {
    const { id } = await minhaReuniao();
    const chamadas = f.provider.calls.length;
    const r = await updateActivityAction(
      { ok: false },
      form({ activityId: id, lockVersion: "1", title: "Reunião fictícia", notes: "Só uma nota" }),
    );
    expect(r).toEqual({ ok: true, activityId: id });
    expect(f.provider.calls.length).toBe(chamadas);
  });
});

// ---------------------------------------------------------------------
// Decisão 2 — nada desvinculado nem abandonado no Google automaticamente
// ---------------------------------------------------------------------

describe("decisão 2 — evento editado no Google desde a última sincronização", () => {
  it("excluir a atividade é recusado: nada é desvinculado nem abandonado", async () => {
    const { id, link } = await minhaReuniao();
    f.provider.externalEdit(link.calendarId, link.eventId, { summary: "Editado direto no Google" });

    const r = await deleteActivityAction(id);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("alterado no Google Agenda");
    expect(wrote("delete_activity")).toBe(false);
    expect(h.activities.has(id)).toBe(true);
    expect(f.provider.peek(link.calendarId, link.eventId)?.status).toBe("confirmed");
    expect(await f.store.getLink(id)).not.toBeNull(); // o vínculo NÃO foi desfeito
  });

  it("'Remover da agenda': o evento fica, o vínculo também, e a mensagem diz que NÃO foi removido", async () => {
    const { id, link } = await minhaReuniao();
    f.provider.externalEdit(link.calendarId, link.eventId, { summary: "Editado direto no Google" });

    const r = await cancelAppointmentAction({ ok: false }, form({ activityId: id }));

    expect(r.ok).toBe(false);
    expect(r.notice?.message).toMatch(/não foi removido/i);
    expect(r.notice?.message).not.toMatch(/^Removido/);
    expect(await f.store.getLink(id)).not.toBeNull();
    expect(f.provider.peek(link.calendarId, link.eventId)?.status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------
// A — tipo, horário e duração conferidos ANTES da escrita
// ---------------------------------------------------------------------

describe("A — mudança de tipo, retirada de horário e duração", () => {
  it("mudar o tipo de um compromisso vinculado é recusado antes da escrita", async () => {
    const { id } = await minhaReuniao();
    const r = await updateActivityAction({ ok: false }, form({ activityId: id, lockVersion: "1", type: "task" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/resolva o vínculo|remova.*agenda/i);
    expect(wrote("update_activity")).toBe(false);
    expect(h.activities.get(id)!.type).toBe("meeting");
  });

  it("tirar o horário de um compromisso vinculado é recusado antes da escrita", async () => {
    const { id } = await minhaReuniao();
    const r = await rescheduleActivityAction(id, 1, "2026-11-12", "");
    expect(r.ok).toBe(false);
    expect(wrote("reschedule_activity")).toBe(false);
    expect(h.activities.get(id)!.hasTime).toBe(true);
  });

  it.each([5, 481, 12.5, Number.NaN])("duração %s é recusada no servidor antes da escrita", async (duracao) => {
    const { id } = await minhaReuniao();
    const r = await rescheduleActivityAction(id, 1, "2026-11-12", "16:00", undefined, { durationMinutes: duracao });
    expect(r.ok).toBe(false);
    expect(wrote("reschedule_activity")).toBe(false);
  });

  it("vínculo existente aparece mesmo se a atividade deixou de ser reunião com horário", async () => {
    const { id } = await minhaReuniao();
    h.activities.get(id)!.type = "task"; // mudança feita por fora, antes desta correção
    expect(await readActivityCalendarInfo(id)).toMatchObject({ status: "linked", isMine: true });
  });
});

// ---------------------------------------------------------------------
// B — pendência persistente (visível depois de recarregar)
// ---------------------------------------------------------------------

describe("B — falha depois de salvar no CRM fica gravada", () => {
  it("leitura do Google falha (500) antes de qualquer escrita: pendente — nada foi tentado, não é incerto", async () => {
    const { id } = await minhaReuniao();
    f.provider.injectFault({ operation: "get", kind: "status", status: 500 });
    const r = await rescheduleActivityAction(id, 1, "2026-11-12", "16:00");
    expect(r.ok).toBe(true);
    expect(r.calendar?.level).toBe("warning");
    expect(await readActivityCalendarInfo(id)).toMatchObject({ syncState: "pending", syncOperation: "update" });
  });

  it("erro definitivo no PATCH (400): falha", async () => {
    const { id } = await minhaReuniao();
    f.provider.injectFault({ operation: "patch", kind: "status", status: 400 });
    await rescheduleActivityAction(id, 1, "2026-11-12", "16:00");
    expect(await readActivityCalendarInfo(id)).toMatchObject({ syncState: "failed", syncOperation: "update" });
  });

  it("erro temporário no PATCH (503): pendente", async () => {
    const { id } = await minhaReuniao();
    f.provider.injectFault({ operation: "patch", kind: "status", status: 503 });
    await rescheduleActivityAction(id, 1, "2026-11-12", "16:00");
    expect(await readActivityCalendarInfo(id)).toMatchObject({ syncState: "pending", syncOperation: "update" });
  });

  it("limite de concorrência (412 em todas as tentativas): pendente", async () => {
    const { id, link } = await minhaReuniao();
    for (let i = 0; i < 3; i++) {
      f.provider.onBefore("patch", () => f.provider.externalEdit(link.calendarId, link.eventId, { attendees: [{ email: `x${i}@exemplo.test` }] }));
    }
    await rescheduleActivityAction(id, 1, "2026-11-12", "16:00");
    expect(await readActivityCalendarInfo(id)).toMatchObject({ syncState: "pending" });
  });

  it("preparação/conexão falha depois de salvar: pendente, mesmo sem chegar ao Google", async () => {
    const { id } = await minhaReuniao();
    m.connectionFails.value = "connection_not_active";
    const r = await rescheduleActivityAction(id, 1, "2026-11-12", "16:00");
    expect(r.ok).toBe(true);
    expect(r.calendar?.level).toBe("warning");
    expect(await readActivityCalendarInfo(id)).toMatchObject({ syncState: "pending" });
  });

  it("resultado incerto: 'incerto', e a recuperação CONSULTA antes de repetir", async () => {
    const { id, link } = await minhaReuniao();
    // O get inicial passa; o PATCH é aplicado mas a resposta se perde; a conferência também falha.
    f.provider.injectFault({ operation: "patch", kind: "timeout_after_apply" });
    f.provider.onBefore("patch", () => f.provider.injectFault({ operation: "get", kind: "status", status: 500 }));
    await rescheduleActivityAction(id, 1, "2026-11-12", "16:00");
    expect(await readActivityCalendarInfo(id)).toMatchObject({ syncState: "uncertain" });
    const patches = f.provider.calls.filter((c) => c.operation === "patch").length;

    const r = await rescheduleAppointmentAction({ ok: false }, form({ activityId: id }));

    expect(r.ok).toBe(true);
    expect(f.provider.calls.filter((c) => c.operation === "patch").length).toBe(patches); // nada repetido
    expect(f.provider.peek(link.calendarId, link.eventId)?.start?.dateTime).toBe("2026-11-12T19:00:00.000Z");
    expect(await readActivityCalendarInfo(id)).toMatchObject({ syncState: "in_sync" });
  });

  it("depois de sincronizar com sucesso, a pendência some", async () => {
    const { id } = await minhaReuniao();
    f.provider.injectFault({ operation: "patch", kind: "status", status: 503 });
    await rescheduleActivityAction(id, 1, "2026-11-12", "16:00");
    await rescheduleAppointmentAction({ ok: false }, form({ activityId: id }));
    expect(await readActivityCalendarInfo(id)).toMatchObject({ syncState: "in_sync" });
  });
});

describe("B — inclusão no Google com resultado incerto", () => {
  async function criarIncerta(kind: "timeout_after_apply" | "timeout_before_apply") {
    f.provider.injectFault({ operation: "insert", kind });
    f.provider.injectFault({ operation: "get", kind: "status", status: 500 });
    const r = await createActivityAction({ ok: false }, form({ ...MEETING, calendarAdd: "on" }));
    expect(r.ok).toBe(true);
    expect(r.calendar?.message).toMatch(/incerto|confirmar/i);
    return r.activityId!;
  }

  it("fica visível como incerta depois de recarregar", async () => {
    const id = await criarIncerta("timeout_after_apply");
    expect(await readActivityCalendarInfo(id)).toMatchObject({ status: "not_linked", syncState: "uncertain", syncOperation: "create" });
  });

  it("recuperar CONSULTA o Google: se o evento existe, adota — sem criar outro", async () => {
    const id = await criarIncerta("timeout_after_apply");
    const inserts = f.provider.calls.filter((c) => c.operation === "insert").length;

    const r = await recoverUncertainCreateAction({ ok: false }, form({ activityId: id }));

    expect(r.ok).toBe(true);
    expect(r.notice?.message).toMatch(/estava no Google Agenda|confirmad/i);
    expect(f.provider.calls.filter((c) => c.operation === "insert").length).toBe(inserts);
    expect(await readActivityCalendarInfo(id)).toMatchObject({ status: "linked", syncState: "in_sync" });
  });

  it("recuperar CONSULTA o Google: se o evento não existe, diz isso e NÃO cria sozinho", async () => {
    const id = await criarIncerta("timeout_before_apply");
    const inserts = f.provider.calls.filter((c) => c.operation === "insert").length;

    const r = await recoverUncertainCreateAction({ ok: false }, form({ activityId: id }));

    expect(r.notice?.message).toMatch(/não foi criado/i);
    expect(f.provider.calls.filter((c) => c.operation === "insert").length).toBe(inserts);
    expect(await readActivityCalendarInfo(id)).toBeNull(); // pendência encerrada
  });

  it("excluir com inclusão incerta é recusado (o evento pode existir no Google)", async () => {
    const id = await criarIncerta("timeout_after_apply");
    const r = await deleteActivityAction(id);
    expect(r.ok).toBe(false);
    expect(wrote("delete_activity")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// C — mensagens fiéis ao resultado (servidor)
// ---------------------------------------------------------------------

describe("C — cada resultado tem a sua mensagem", () => {
  it("Meet pedido e ainda em criação NÃO é 'link criado'", async () => {
    const { id } = await minhaReuniao();
    f.provider.meetReadyAfterReads = 99;
    const r = await addMeetAction({ ok: false }, form({ activityId: id }));
    expect(r.notice?.message).toMatch(/sendo criado/i);
    expect(r.notice?.message).not.toMatch(/link do Meet criado/i);
  });

  it("Meet pronto: link criado, com o endereço", async () => {
    const { id } = await minhaReuniao();
    const r = await addMeetAction({ ok: false }, form({ activityId: id }));
    expect(r.notice).toMatchObject({ level: "success", meetUrl: expect.stringContaining("meet") });
  });

  it("conflito resolvido explica que o Google prevaleceu", async () => {
    const { id, link } = await minhaReuniao();
    f.provider.externalEdit(link.calendarId, link.eventId, {
      start: { dateTime: "2026-11-13T12:00:00.000Z" },
      end: { dateTime: "2026-11-13T13:00:00.000Z" },
    });
    h.activities.get(id)!.dueAt = "2026-11-12T19:00:00.000Z";
    const r = await rescheduleAppointmentAction({ ok: false }, form({ activityId: id }));
    expect(r.notice?.message).toMatch(/Google prevaleceu/i);
  });

  it("resultado incerto é dito como incerto", async () => {
    const { id } = await minhaReuniao();
    // O DELETE é aplicado mas a resposta se perde, e a conferência também falha.
    f.provider.injectFault({ operation: "delete", kind: "timeout_after_apply" });
    f.provider.onBefore("delete", () => f.provider.injectFault({ operation: "get", kind: "status", status: 500 }));
    const r = await cancelAppointmentAction({ ok: false }, form({ activityId: id }));
    expect(r.ok).toBe(false);
    expect(r.notice).toMatchObject({ level: "warning", message: expect.stringMatching(/incerto/i) });
  });

  it("removido de fato: 'Removido do Google Agenda'", async () => {
    const { id } = await minhaReuniao();
    const r = await cancelAppointmentAction({ ok: false }, form({ activityId: id }));
    expect(r).toMatchObject({ ok: true, notice: { level: "success", message: expect.stringMatching(/^Removido do Google Agenda/) } });
  });
});

it("integração desligada: nada disso consulta B2", async () => {
  m.provider.on = false;
  const r = await createActivityAction({ ok: false }, form(MEETING));
  const id = r.activityId!;
  expect((await rescheduleActivityAction(id, 1, "2026-11-12", "")).ok).toBe(true);
  expect((await updateActivityAction({ ok: false }, form({ activityId: id, lockVersion: "2", type: "task" }))).ok).toBe(true);
  expect((await deleteActivityAction(id)).ok).toBe(true);
  expect(f.provider.calls).toEqual([]);
  expect(CALENDAR_ID).toBeTruthy();
});
