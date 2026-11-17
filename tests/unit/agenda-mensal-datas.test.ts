import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agenda mensal — datas (chaves de mês/dia, grade de segunda a domingo,
 * meses de 28/29/30/31 dias, viradas de mês e ano, fuso do escritório) e a
 * consulta do mês no servidor (paginação até o fim, erro em vez de mês pela
 * metade, contagem por dia conferida contra os itens).
 */

const { rpcMock, attachMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), attachMock: vi.fn() }));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));
vi.mock("@/modules/calendar/activity-links", () => ({
  attachCalendarInfo: attachMock,
}));

import {
  addDays,
  agendaHref,
  dayKeyOf,
  daysInMonth,
  firstDayOf,
  formatFullDate,
  formatMonthLabel,
  isoWeekday,
  lastDayOf,
  monthWeeks,
  parseDayKey,
  parseMonthKey,
  resolveAgendaMonth,
  resolveSelectedDay,
  shiftMonth,
  todayKey,
  type MonthKey,
} from "@/lib/calendar-month";

const { listActivitiesInRange, ActivitiesLoadError } = await import("@/modules/activities/queries");

describe("chaves de mês e dia", () => {
  it("aceita só meses reais e dentro dos limites", () => {
    expect(parseMonthKey("2026-11")).toBe("2026-11");
    expect(parseMonthKey("2026-1")).toBeNull();
    expect(parseMonthKey("2026-13")).toBeNull();
    expect(parseMonthKey("2026-00")).toBeNull();
    expect(parseMonthKey("1999-12")).toBeNull();
    expect(parseMonthKey("2101-01")).toBeNull();
    expect(parseMonthKey("novembro")).toBeNull();
    expect(parseMonthKey(["2026-11"])).toBeNull();
    expect(parseMonthKey(undefined)).toBeNull();
  });

  it("aceita só dias que existem (bissexto, 30/31, limites)", () => {
    expect(parseDayKey("2026-11-17")).toBe("2026-11-17");
    expect(parseDayKey("2028-02-29")).toBe("2028-02-29");
    expect(parseDayKey("2026-02-29")).toBeNull();
    expect(parseDayKey("2100-02-29")).toBeNull(); // 2100 não é bissexto
    expect(parseDayKey("2000-02-29")).toBe("2000-02-29");
    expect(parseDayKey("2026-04-31")).toBeNull();
    expect(parseDayKey("2026-04-30")).toBe("2026-04-30");
    expect(parseDayKey("2026-12-32")).toBeNull();
    expect(parseDayKey("2026-11-00")).toBeNull();
    expect(parseDayKey("2026-11-7")).toBeNull();
    expect(parseDayKey("2026-11-17T00:00")).toBeNull();
    expect(parseDayKey(null)).toBeNull();
  });

  it("meses de 28, 29, 30 e 31 dias", () => {
    expect(daysInMonth("2027-02" as MonthKey)).toBe(28);
    expect(daysInMonth("2028-02" as MonthKey)).toBe(29);
    expect(daysInMonth("2026-11" as MonthKey)).toBe(30);
    expect(daysInMonth("2026-12" as MonthKey)).toBe(31);
    expect(lastDayOf("2028-02" as MonthKey)).toBe("2028-02-29");
    expect(firstDayOf("2026-11" as MonthKey)).toBe("2026-11-01");
  });

  it("vira mês e ano nos dois sentidos", () => {
    expect(shiftMonth("2026-12" as MonthKey, 1)).toBe("2027-01");
    expect(shiftMonth("2027-01" as MonthKey, -1)).toBe("2026-12");
    expect(shiftMonth("2026-11" as MonthKey, 0)).toBe("2026-11");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
  });

  it("semana ISO: segunda = 1, domingo = 7", () => {
    expect(isoWeekday("2026-11-16")).toBe(1);
    expect(isoWeekday("2026-11-22")).toBe(7);
  });
});

describe("grade do mês", () => {
  it("novembro/2026 começa num domingo: seis casas vazias antes do dia 1", () => {
    const weeks = monthWeeks("2026-11" as MonthKey);
    expect(weeks[0]).toEqual([null, null, null, null, null, null, "2026-11-01"]);
    expect(weeks.flat().filter(Boolean)).toHaveLength(30);
    expect(weeks.at(-1)).toEqual(["2026-11-30", null, null, null, null, null, null]);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });

  it("fevereiro/2027 começa numa segunda e cabe em quatro semanas exatas", () => {
    const weeks = monthWeeks("2027-02" as MonthKey);
    expect(weeks).toHaveLength(4);
    expect(weeks[0]![0]).toBe("2027-02-01");
    expect(weeks[3]![6]).toBe("2027-02-28");
  });

  it("fevereiro/2028 (bissexto) tem o dia 29", () => {
    expect(monthWeeks("2028-02" as MonthKey).flat()).toContain("2028-02-29");
  });

  it("só dias reais do mês (nenhum dia de outro mês na grade)", () => {
    for (const m of ["2026-01", "2026-03", "2026-08", "2026-12"] as MonthKey[]) {
      const days = monthWeeks(m).flat().filter((d): d is string => d !== null);
      expect(days.every((d) => d.startsWith(m))).toBe(true);
      expect(days).toHaveLength(daysInMonth(m));
    }
  });
});

describe("fuso do escritório", () => {
  it("o dia de um instante é o de São Paulo, não o do UTC", () => {
    // 02:59 UTC de 18/11 = 23:59 de 17/11 em São Paulo.
    expect(dayKeyOf("2026-11-18T02:59:59.000Z")).toBe("2026-11-17");
    expect(dayKeyOf("2026-11-18T03:00:00.000Z")).toBe("2026-11-18");
    // Atividade "só de data" gravada às 23:59:59 locais continua no próprio dia.
    expect(dayKeyOf("2027-01-01T02:59:59.000Z")).toBe("2026-12-31");
  });

  it("hoje é calculado no fuso do escritório", () => {
    expect(todayKey(new Date("2026-11-18T01:00:00.000Z"))).toBe("2026-11-17");
    expect(todayKey(new Date("2026-11-18T10:00:00.000Z"))).toBe("2026-11-18");
  });

  it("rótulos em português, sem deslocar o dia", () => {
    expect(formatMonthLabel("2026-11" as MonthKey)).toBe("Novembro de 2026");
    expect(formatFullDate("2026-11-17")).toBe("Terça-feira, 17 de novembro de 2026");
    expect(formatFullDate("2026-11-01")).toBe("Domingo, 1 de novembro de 2026");
    expect(formatFullDate("2028-02-29")).toBe("Terça-feira, 29 de fevereiro de 2028");
  });
});

describe("seleção a partir da URL", () => {
  const today = "2026-11-17";

  it("sem parâmetros: mês e dia de hoje", () => {
    const month = resolveAgendaMonth({}, today);
    expect(month).toBe("2026-11");
    expect(resolveSelectedDay(null, month, today)).toBe(today);
  });

  it("mês e dia válidos são respeitados", () => {
    const month = resolveAgendaMonth({ mes: "2027-02", dia: "2027-02-14" }, today);
    expect(month).toBe("2027-02");
    expect(resolveSelectedDay("2027-02-14", month, today)).toBe("2027-02-14");
  });

  it("dia de outro mês ou impossível: dia 1 (ou hoje, no mês atual)", () => {
    expect(resolveSelectedDay("2027-03-05", "2027-02" as MonthKey, today)).toBe("2027-02-01");
    expect(resolveSelectedDay("2027-02-30", "2027-02" as MonthKey, today)).toBe("2027-02-01");
    expect(resolveSelectedDay("lixo", "2026-11" as MonthKey, today)).toBe(today);
  });

  it("mês inválido cai no mês do dia válido, e depois no de hoje", () => {
    expect(resolveAgendaMonth({ mes: "2026-13", dia: "2027-05-02" }, today)).toBe("2027-05");
    expect(resolveAgendaMonth({ mes: "2026-13", dia: "2027-02-30" }, today)).toBe("2026-11");
    expect(resolveAgendaMonth({ mes: ["2027-01", "2027-02"] }, today)).toBe("2026-11");
  });

  it("monta a URL da Agenda", () => {
    expect(agendaHref("2026-12" as MonthKey, "2026-12-01")).toBe("/agenda?mes=2026-12&dia=2026-12-01");
  });
});

// -------------------------------------------------------------------
// Consulta do mês
// -------------------------------------------------------------------

function row(n: number, dueAt: string) {
  return {
    id: `item-${n}`,
    lead_id: "lead-1",
    opportunity_id: null,
    contact_name: "Contato de teste",
    legal_area: "Cível",
    type: "task",
    title: `Atividade ${n}`,
    notes: null,
    assigned_to: null,
    assigned_to_name: null,
    priority: "media",
    due_at: dueAt,
    has_time: true,
    status: "pending",
    completed_at: null,
    source: "manual",
    lock_version: 0,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
  };
}

describe("listActivitiesInRange", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    attachMock.mockReset();
    attachMock.mockImplementation(async (items: Array<{ id: string }>) => items.map((i) => ({ ...i, calendar: null })));
  });

  it("pagina além de 100 e devolve o mês inteiro com a contagem por dia do banco", async () => {
    // 105 atividades: 100 em 10/11 e 5 em 30/11 às 23:59:59 locais (02:59:59Z de 01/12).
    const all = [
      ...Array.from({ length: 100 }, (_, i) => row(i + 1, "2026-11-10T13:00:00.000Z")),
      ...Array.from({ length: 5 }, (_, i) => row(101 + i, "2026-12-01T02:59:59.000Z")),
    ];
    rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      expect(fn).toBe("list_activities_in_range");
      const page = args.p_page as number;
      const size = args.p_page_size as number;
      return {
        data: [{ items: all.slice((page - 1) * size, page * size), total_count: 105, day_counts: { "2026-11-10": 100, "2026-11-30": 5 } }],
        error: null,
      };
    });

    const result = await listActivitiesInRange("ws-1", { from: "2026-11-01", to: "2026-11-30" });
    expect(result.total).toBe(105);
    expect(result.items).toHaveLength(105);
    expect(result.items.at(-1)!.id).toBe("item-105");
    expect(result.dayCounts).toEqual({ "2026-11-10": 100, "2026-11-30": 5 });
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(rpcMock.mock.calls[0]![1]).toMatchObject({ p_workspace_id: "ws-1", p_from: "2026-11-01", p_to: "2026-11-30", p_page: 1 });
  });

  it("falha do banco vira erro, nunca mês vazio", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom", code: "XX000" } });
    await expect(listActivitiesInRange("ws-1", { from: "2026-11-01", to: "2026-11-30" })).rejects.toBeInstanceOf(
      ActivitiesLoadError,
    );
  });

  it("falha na segunda página também é erro (nada de mês pela metade)", async () => {
    rpcMock
      .mockResolvedValueOnce({
        data: [{ items: Array.from({ length: 100 }, (_, i) => row(i, "2026-11-10T13:00:00.000Z")), total_count: 120, day_counts: { "2026-11-10": 120 } }],
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { message: "timeout", code: "57014" } });
    await expect(listActivitiesInRange("ws-1", { from: "2026-11-01", to: "2026-11-30" })).rejects.toBeInstanceOf(
      ActivitiesLoadError,
    );
  });

  it("página vazia antes do total é erro", async () => {
    rpcMock
      .mockResolvedValueOnce({
        data: [{ items: Array.from({ length: 100 }, (_, i) => row(i, "2026-11-10T13:00:00.000Z")), total_count: 120, day_counts: { "2026-11-10": 120 } }],
        error: null,
      })
      .mockResolvedValueOnce({ data: [{ items: [], total_count: 120, day_counts: { "2026-11-10": 120 } }], error: null });
    await expect(listActivitiesInRange("ws-1", { from: "2026-11-01", to: "2026-11-30" })).rejects.toBeInstanceOf(
      ActivitiesLoadError,
    );
  });

  it("itens que não batem com a contagem por dia são erro", async () => {
    rpcMock.mockResolvedValue({
      data: [{ items: [row(1, "2026-11-10T13:00:00.000Z")], total_count: 1, day_counts: { "2026-11-11": 1 } }],
      error: null,
    });
    await expect(listActivitiesInRange("ws-1", { from: "2026-11-01", to: "2026-11-30" })).rejects.toBeInstanceOf(
      ActivitiesLoadError,
    );
  });

  it("mês sem atividades: lista e contagem vazias, uma chamada só", async () => {
    rpcMock.mockResolvedValue({ data: [{ items: [], total_count: 0, day_counts: {} }], error: null });
    const result = await listActivitiesInRange("ws-1", { from: "2026-11-01", to: "2026-11-30" });
    expect(result).toEqual({ items: [], total: 0, dayCounts: {} });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("anexa o estado do Google Agenda de cada página (sem chamar o Google)", async () => {
    rpcMock.mockResolvedValue({
      data: [{ items: [row(1, "2026-11-10T13:00:00.000Z")], total_count: 1, day_counts: { "2026-11-10": 1 } }],
      error: null,
    });
    attachMock.mockImplementation(async (items: Array<{ id: string }>) =>
      items.map((i) => ({ ...i, calendar: { status: "linked", isMine: true, syncState: "pending" } })),
    );
    const result = await listActivitiesInRange("ws-1", { from: "2026-11-01", to: "2026-11-30" });
    expect(attachMock).toHaveBeenCalledTimes(1);
    expect(result.items[0]!.calendar).toMatchObject({ status: "linked", syncState: "pending" });
  });
});
