/**
 * @vitest-environment node
 *
 * B2 — "Verificar inclusão" usa a identidade IMUTÁVEL da tentativa original
 * (ambiente, workspace, conexão, agenda e evento gravados ANTES da chamada
 * ao Google), nunca a agenda selecionada depois. Reproduções pedidas na
 * revisão da PR #26: troca de agenda entre a inclusão incerta e a
 * verificação, ausência confirmada na agenda original, acesso perdido,
 * usuário/conexão indevidos e verificação repetida. Ações e orquestrador
 * REAIS, provedor simulado e dados fictícios.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CALENDAR_ID, makeFixture } from "../support/calendar-fixture";
import { createHarness, fakeActivityRpc, type Harness } from "../support/calendar-activity-harness";
import type { StoredIntent } from "../support/calendar-memory-store";

const USER = "11111111-1111-4111-8111-111111111111";
const OUTRO_USUARIO = "11111111-1111-4111-8111-111111111112";
const WS = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";

/** Agenda da tentativa original (A) e agenda selecionada depois (B). */
const AGENDA_A = CALENDAR_ID;
const AGENDA_B = "segunda@calendar.simulated";

type Conn = { id: string; isMine: boolean; calendarId: string | null; status: "active" | "needs_reauth" | "disconnected" };

const m = vi.hoisted(() => ({
  f: { value: null as unknown },
  h: { value: null as unknown },
  user: { value: "" },
  connections: { value: [] as unknown[] },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/authz/safe", () => ({
  requirePermissionSafe: async () => ({ ctx: { userId: m.user.value, workspaceId: WS } }),
}));
vi.mock("@/server/authz/permissions", () => ({ requireMembership: async () => ({ workspaceId: WS }) }));
vi.mock("@/server/calendar/provider", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCalendarProvider: async () => (m.f.value as { provider: unknown }).provider,
}));
vi.mock("@/server/calendar/admin/sync-store", () => ({
  // Como o adaptador real: o store age em nome do usuário da sessão.
  createSupabaseSyncStore: (actorUserId: string) => {
    const store = (m.f.value as { store: { actor: string } }).store;
    store.actor = actorUserId;
    return store;
  },
}));
vi.mock("@/server/calendar/connection-context", () => ({
  // Token da conexão pedida, na agenda pedida (como o carregador real).
  loadConnectionContext: async ({ connection }: { connection: { id: string; calendarId: string | null; status: string } }) => {
    if (connection.status !== "active") throw new Error("connection_not_active");
    if (!connection.calendarId) throw new Error("calendar_not_selected");
    const base = (m.f.value as { conn: Record<string, unknown> }).conn;
    return { ...base, connectionId: connection.id, calendarId: connection.calendarId };
  },
}));
vi.mock("@/modules/calendar/queries", () => ({
  listCalendarConnections: async () => m.connections.value,
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

import { createActivityAction } from "@/modules/activities/actions";
import { createAppointmentAction, recoverUncertainCreateAction } from "@/modules/calendar/appointment-actions";
import { readActivityCalendarInfo } from "@/modules/calendar/activity-links";

let f: Awaited<ReturnType<typeof makeFixture>>;
let h: Harness;

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

const MEETING = { leadId: LEAD, type: "meeting", title: "Reunião fictícia", dueDate: "2026-11-10", dueTime: "14:00" };
const minhaConexao = (calendarId: string, status: Conn["status"] = "active"): Conn => ({ id: "conn-1", isMine: true, calendarId, status });

beforeEach(async () => {
  f = await makeFixture();
  h = createHarness();
  m.f.value = f;
  m.h.value = h;
  m.user.value = USER;
  m.connections.value = [minhaConexao(AGENDA_A)];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** Cria a atividade com inclusão na agenda A e deixa o resultado INCERTO: a
 * resposta do insert se perde e a conferência imediata também falha. */
async function incluirIncertaEmA(kind: "timeout_after_apply" | "timeout_before_apply", extra: Record<string, string> = {}) {
  f.provider.injectFault({ operation: "insert", kind });
  f.provider.injectFault({ operation: "get", kind: "status", status: 500 });
  const r = await createActivityAction({ ok: false }, form({ ...MEETING, calendarAdd: "on", ...extra }));
  expect(r.ok).toBe(true);
  expect(r.calendar?.message).toMatch(/confirmar/i);
  const id = r.activityId!;
  expect(await readActivityCalendarInfo(id)).toMatchObject({ status: "not_linked", syncState: "uncertain" });
  return id;
}

/** O usuário escolhe a agenda B para a conexão (vale só para compromissos novos). */
function trocarParaB() {
  m.connections.value = [minhaConexao(AGENDA_B)];
  f.store.selectCalendar("conn-1", AGENDA_B);
}

const createIntents = (id: string) => f.store.intents.filter((i) => i.activityId === id && i.operation === "create");
const callsSince = (n: number) => f.provider.calls.slice(n);
const inserts = () => f.provider.calls.filter((c) => c.operation === "insert").length;
const verificar = (id: string) => recoverUncertainCreateAction({ ok: false }, form({ activityId: id }));

describe("Verificar inclusão — identidade da tentativa original", () => {
  it("1. efetivada na agenda A com resposta perdida; troca para B; verificar encontra e vincula o evento em A", async () => {
    const id = await incluirIncertaEmA("timeout_after_apply");
    trocarParaB();
    const antes = f.provider.calls.length;
    const intencoes = f.store.intents.length;
    const insertsAntes = inserts();

    const r = await verificar(id);

    expect(r.ok).toBe(true);
    expect(r.result).toBe("adopted");
    expect(r.notice?.message).toMatch(/estava no Google Agenda/i);
    // A mensagem explica que o compromisso ficou na agenda ORIGINAL, não na selecionada.
    expect(r.notice?.message).toMatch(/não é a agenda selecionada agora/i);
    const link = await f.store.getLink(id);
    expect(link?.calendarId).toBe(AGENDA_A);
    expect(f.provider.peek(AGENDA_A, link!.eventId)?.status).toBe("confirmed");
    expect(f.provider.eventCount(AGENDA_B)).toBe(0);
    // Só consultou a agenda A; nada foi criado; nenhuma intenção nova foi aberta.
    expect(callsSince(antes).every((c) => c.calendarId === AGENDA_A)).toBe(true);
    expect(inserts()).toBe(insertsAntes);
    expect(f.store.intents.length).toBe(intencoes);
    expect(createIntents(id).map((i) => i.status)).toEqual(["succeeded"]);
    expect(await readActivityCalendarInfo(id)).toMatchObject({ status: "linked", syncState: "in_sync" });
  });

  it("2. evento realmente ausente em A, com acesso confirmado: conclui a ausência consultando A", async () => {
    const id = await incluirIncertaEmA("timeout_before_apply");
    trocarParaB();
    const antes = f.provider.calls.length;
    const intencoes = f.store.intents.length;

    const r = await verificar(id);

    expect(r.result).toBe("not_created");
    expect(r.notice?.message).toMatch(/não foi criado/i);
    const consultas = callsSince(antes);
    expect(consultas.map((c) => [c.operation, c.calendarId])).toEqual([
      ["get", AGENDA_A],
      ["calendar", AGENDA_A], // acesso à agenda A confirmado antes de concluir
    ]);
    expect(inserts()).toBe(1); // só a tentativa original, que não chegou ao Google
    expect(f.store.intents.length).toBe(intencoes);
    expect(createIntents(id)).toMatchObject([{ status: "failed", errorCode: "not_created_confirmed" }]);
    expect(await readActivityCalendarInfo(id)).toBeNull();
  });

  it.each([
    ["403", 403 as const],
    ["404 ambíguo", 404 as const],
  ])("3. acesso perdido à agenda original (%s): a pendência é preservada, sem repetição às cegas", async (_nome, como) => {
    const id = await incluirIncertaEmA("timeout_after_apply");
    trocarParaB();
    f.provider.revokeCalendarAccess(AGENDA_A, como);

    const r = await verificar(id);

    expect(r.ok).toBe(false);
    expect(r.result).toBe("access_lost");
    expect(r.notice?.message).toMatch(/continua pendente/i);
    expect(r.notice?.message).not.toMatch(/não foi criado/i);
    // A intenção ORIGINAL continua aberta e a tela continua mostrando a inclusão incerta.
    expect(createIntents(id)).toMatchObject([{ status: "uncertain" }]);
    expect(await f.store.getLink(id)).toBeNull();
    expect(await readActivityCalendarInfo(id)).toMatchObject({ status: "not_linked", syncState: "uncertain" });

    // Adicionar de novo (agora na agenda B) é recusado antes de qualquer criação.
    const insertsAntes = inserts();
    const nova = await createAppointmentAction({ ok: false }, form({ activityId: id }));
    expect(nova.ok).toBe(false);
    expect(nova.error).toMatch(/Verificar inclusão/);
    expect(inserts()).toBe(insertsAntes);
    expect(f.provider.eventCount(AGENDA_B)).toBe(0);
  });

  it.each([
    ["reconectada (outra conexão)", [{ id: "conn-7", isMine: true, calendarId: AGENDA_B, status: "active" }] as Conn[]],
    ["a reautorizar", [minhaConexao(AGENDA_A, "needs_reauth")]],
    ["desconectada", [minhaConexao(AGENDA_A, "disconnected")]],
  ])("3b. conexão original %s: a pendência é mantida e nada é consultado", async (_nome, conexoes) => {
    const id = await incluirIncertaEmA("timeout_after_apply");
    m.connections.value = conexoes;
    const antes = f.provider.calls.length;

    const r = await verificar(id);

    expect(r.ok).toBe(false);
    expect(r.result).toBe("connection_unavailable");
    expect(r.notice?.message).toMatch(/continua pendente/i);
    expect(f.provider.calls.length).toBe(antes);
    expect(createIntents(id)).toMatchObject([{ status: "uncertain" }]);
    expect(await f.store.getLink(id)).toBeNull();
  });

  it("4. outro usuário (com outra conexão): recusa sem efeitos", async () => {
    const id = await incluirIncertaEmA("timeout_after_apply");
    m.user.value = OUTRO_USUARIO;
    m.connections.value = [
      { id: "conn-2", isMine: true, calendarId: AGENDA_A, status: "active" },
      { id: "conn-1", isMine: false, calendarId: AGENDA_A, status: "active" },
    ];
    h.myConnectionId = "conn-2";
    const antes = f.provider.calls.length;
    const intencoes = structuredClone(f.store.intents);

    const r = await verificar(id);

    expect(r.ok).toBe(false);
    expect(r.result).toBe("not_owner");
    expect(r.notice?.message).toMatch(/outra pessoa/i);
    expect(f.provider.calls.length).toBe(antes);
    expect(f.store.intents).toEqual(intencoes);
    expect(await f.store.getLink(id)).toBeNull();
  });

  it("5. verificar repetidamente: nenhuma criação, nenhum convite e nenhum vínculo duplicado", async () => {
    const id = await incluirIncertaEmA("timeout_after_apply", { inviteEmails: "convidado@exemplo.test", confirmInvites: "on" });
    expect(f.provider.notificationsSent).toHaveLength(1); // o convite da tentativa original
    trocarParaB();
    const intencoes = f.store.intents.length;
    const insertsAntes = inserts();

    // Google fora do ar nas duas primeiras: continua incerto, sem abrir intenção nova.
    f.provider.injectFault({ operation: "get", kind: "status", status: 503 });
    f.provider.injectFault({ operation: "get", kind: "status", status: 503 });
    expect((await verificar(id)).result).toBe("uncertain");
    expect((await verificar(id)).result).toBe("uncertain");
    expect(f.store.intents.length).toBe(intencoes);

    const resultados = [];
    for (let i = 0; i < 3; i++) resultados.push((await verificar(id)).result);

    expect(resultados).toEqual(["adopted", "already_linked", "already_linked"]);
    expect(inserts()).toBe(insertsAntes);
    expect(f.provider.notificationsSent).toHaveLength(1);
    expect([...f.store.links.values()].filter((l) => l.activityId === id)).toHaveLength(1);
    expect(f.store.intents.length).toBe(intencoes);
    expect(f.provider.eventCount(AGENDA_B)).toBe(0);
  });
});

describe("Verificar inclusão — sem conclusão inventada", () => {
  it("inclusão aberta há pouco (pode estar em andamento): nada é consultado nem concluído", async () => {
    const r0 = await createActivityAction({ ok: false }, form(MEETING));
    const id = r0.activityId!;
    // A tentativa foi registrada e a chamada ao Google ainda não terminou.
    f.store.actor = USER;
    await f.store.beginEffect({
      connectionId: "conn-1",
      activityId: id,
      operation: "create",
      expected: {},
      target: { calendarId: AGENDA_A, eventId: "evento-em-andamento" },
    });
    const antes = f.provider.calls.length;

    const r = await verificar(id);

    expect(r.result).toBe("in_progress");
    expect(f.provider.calls.length).toBe(antes);
    expect(createIntents(id)).toMatchObject([{ status: "pending" }]);
  });

  it("intenção sem agenda/evento registrados: não consulta nada e não conclui", async () => {
    const r0 = await createActivityAction({ ok: false }, form(MEETING));
    const id = r0.activityId!;
    f.store.intents.push({
      id: "intent-legado",
      connectionId: "conn-1",
      activityId: id,
      operation: "create",
      expected: {},
      status: "uncertain",
      createdBy: USER,
      createdAt: 0,
      calendarId: null,
      eventId: null,
    } as StoredIntent);
    const antes = f.provider.calls.length;

    const r = await verificar(id);

    expect(r.ok).toBe(false);
    expect(r.result).toBe("insufficient_info");
    expect(r.notice?.message).toMatch(/não é possível concluir/i);
    expect(f.provider.calls.length).toBe(antes);
    expect(f.store.intents.find((i) => i.id === "intent-legado")?.status).toBe("uncertain");
  });

  it("não encerra outra intenção incerta só por ser da mesma atividade", async () => {
    const id = await incluirIncertaEmA("timeout_after_apply");
    // Outra intenção aberta da MESMA atividade e conexão, sobre OUTRO alvo.
    f.store.intents.push({
      id: "intent-outro-alvo",
      connectionId: "conn-1",
      activityId: id,
      operation: "delete",
      expected: {},
      status: "uncertain",
      createdBy: USER,
      createdAt: 0,
      calendarId: "antiga@calendar.simulated",
      eventId: "evento-antigo",
    } as StoredIntent);

    const r = await verificar(id);

    expect(r.result).toBe("adopted");
    expect(f.store.intents.find((i) => i.id === "intent-outro-alvo")?.status).toBe("uncertain");
  });
});
