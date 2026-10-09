/**
 * @vitest-environment node
 *
 * B2 — peças de servidor da interface de atividades: capacidades do usuário,
 * leitura do selo de agenda (e seu comportamento quando a integração está
 * desligada ou a leitura falha) e conversões de fuso usadas pela checagem de
 * disponibilidade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  provider: vi.fn(),
  rpc: vi.fn(),
  listConnections: vi.fn(),
}));

vi.mock("@/server/calendar/provider", () => ({ getCalendarProvider: () => m.provider() }));
vi.mock("@/server/supabase/server", () => ({ createServerSupabaseClient: async () => ({ rpc: m.rpc }) }));
vi.mock("@/modules/calendar/queries", () => ({ listCalendarConnections: m.listConnections }));

import { dateTimeInputParts, zonedInstant } from "@/lib/timezone";
import { attachCalendarInfo } from "@/modules/calendar/activity-links";
import { getCalendarCapabilities } from "@/modules/calendar/capabilities";

beforeEach(() => {
  vi.clearAllMocks();
  m.provider.mockResolvedValue({ api: "provedor" });
});

describe("capacidades do usuário", () => {
  it("integração desligada: tudo falso, sem consultar o banco", async () => {
    m.provider.mockResolvedValue(null);
    expect(await getCalendarCapabilities({ workspaceId: "ws", role: "owner" })).toEqual({
      enabled: false,
      canUse: false,
      hasConnection: false,
    });
    expect(m.listConnections).not.toHaveBeenCalled();
  });

  it("papel sem permissão de agenda: ligada, mas sem uso e sem consulta", async () => {
    expect(await getCalendarCapabilities({ workspaceId: "ws", role: "viewer" })).toEqual({
      enabled: true,
      canUse: false,
      hasConnection: false,
    });
    expect(m.listConnections).not.toHaveBeenCalled();
  });

  it("conexão própria ativa com agenda escolhida", async () => {
    m.listConnections.mockResolvedValue([
      { id: "c1", isMine: true, status: "active", calendarId: "cal@x" },
      { id: "c2", isMine: false, status: "active", calendarId: "outra@x" },
    ]);
    expect((await getCalendarCapabilities({ workspaceId: "ws", role: "lawyer" })).hasConnection).toBe(true);
  });

  it.each([
    ["sem agenda escolhida", [{ id: "c1", isMine: true, status: "active", calendarId: null }]],
    ["precisa reautorizar", [{ id: "c1", isMine: true, status: "needs_reauth", calendarId: "cal@x" }]],
    ["só a conexão de outra pessoa", [{ id: "c2", isMine: false, status: "active", calendarId: "outra@x" }]],
    ["nenhuma", []],
  ])("não conta como conexão pronta: %s", async (_nome, rows) => {
    m.listConnections.mockResolvedValue(rows);
    expect((await getCalendarCapabilities({ workspaceId: "ws", role: "lawyer" })).hasConnection).toBe(false);
  });

  it("falha ao ler as conexões: não oferece a agenda (as ações conferem de novo)", async () => {
    m.listConnections.mockRejectedValue(new Error("falha"));
    expect(await getCalendarCapabilities({ workspaceId: "ws", role: "owner" })).toEqual({
      enabled: true,
      canUse: true,
      hasConnection: false,
    });
  });
});

describe("selo de agenda nas listas", () => {
  const items = [
    { id: "a1", type: "meeting", hasTime: true },
    { id: "a2", type: "task", hasTime: false },
    { id: "a3", type: "meeting", hasTime: false },
    { id: "a4", type: "meeting", hasTime: true },
  ];

  it("integração desligada: NENHUMA função de B2 é chamada (a lista não depende da migration)", async () => {
    m.provider.mockResolvedValue(null);
    m.rpc.mockRejectedValue(new Error("function public.list_activity_calendar_links does not exist"));
    const result = await attachCalendarInfo(items);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(result.every((i) => i.calendar === null)).toBe(true);
  });

  it("consulta TODAS as atividades (um vínculo nunca é escondido por tipo/horário) e anexa o estado", async () => {
    m.rpc.mockResolvedValue({
      data: [
        { activityId: "a4", status: "linked", isMine: true, durationMinutes: 90, meetStatus: "success", meetUrl: "https://meet.simulated/x", lastSyncedAt: null },
      ],
      error: null,
    });
    const result = await attachCalendarInfo(items);
    expect(m.rpc).toHaveBeenCalledWith("list_activity_calendar_links", { p_activity_ids: ["a1", "a2", "a3", "a4"] });
    expect(result.find((i) => i.id === "a4")?.calendar).toEqual({
      status: "linked",
      isMine: true,
      durationMinutes: 90,
      meetStatus: "success",
      meetUrl: "https://meet.simulated/x",
      lastSyncedAt: null,
      syncState: "in_sync",
      syncOperation: null,
    });
    expect(result.find((i) => i.id === "a1")?.calendar).toBeNull();
    expect(result.find((i) => i.id === "a2")?.calendar).toBeNull();
  });

  it("lista vazia: nem chama o banco", async () => {
    await attachCalendarInfo([]);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("vínculo de uma atividade que deixou de ser reunião com horário continua aparecendo", async () => {
    m.rpc.mockResolvedValue({
      data: [{ activityId: "a2", status: "linked", isMine: true, durationMinutes: 60, meetStatus: null, meetUrl: null, lastSyncedAt: null, syncState: "pending", syncOperation: "update" }],
      error: null,
    });
    const result = await attachCalendarInfo(items);
    expect(result.find((i) => i.id === "a2")?.calendar).toMatchObject({ status: "linked", syncState: "pending" });
  });

  it("mais de 200 reuniões: lê em blocos de 200", async () => {
    m.rpc.mockResolvedValue({ data: [], error: null });
    const many = Array.from({ length: 450 }, (_, i) => ({ id: `a${i}`, type: "meeting", hasTime: true }));
    await attachCalendarInfo(many);
    expect(m.rpc.mock.calls.map((c) => (c[1] as { p_activity_ids: string[] }).p_activity_ids.length)).toEqual([200, 200, 50]);
  });

  it("falha na leitura: a lista continua carregando, sem o selo, e o erro vai para o log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    m.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const result = await attachCalendarInfo(items);
    expect(result.every((i) => i.calendar === null)).toBe(true);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ event: "calendar_links_unavailable" });
    log.mockRestore();
  });
});

describe("fuso do escritório", () => {
  it("zonedInstant: 14:00 em São Paulo é 17:00 UTC", () => {
    expect(zonedInstant("2026-11-10", "14:00")).toBe("2026-11-10T17:00:00.000Z");
  });

  it("zonedInstant: virada de dia", () => {
    expect(zonedInstant("2026-11-10", "22:30")).toBe("2026-11-11T01:30:00.000Z");
    expect(zonedInstant("2026-11-10", "00:00")).toBe("2026-11-10T03:00:00.000Z");
  });

  it("dateTimeInputParts e zonedInstant são inversos", () => {
    const iso = zonedInstant("2026-02-03", "09:45");
    expect(dateTimeInputParts(iso, true)).toEqual({ date: "2026-02-03", time: "09:45" });
  });

  it("sem horário relevante, a hora vem vazia", () => {
    expect(dateTimeInputParts("2026-11-10T03:00:00.000Z", false)).toEqual({ date: "2026-11-10", time: "" });
  });
});
