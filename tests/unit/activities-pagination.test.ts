import { describe, expect, it, vi } from "vitest";

/**
 * A6, correção pré-merge: list_activities() no banco limita p_page_size a
 * 100 (mesmo pedindo mais — ver comentário na migration), mas
 * agenda/page.tsx pedia pageSize:200 numa chamada só. O RPC simplesmente
 * ignorava o pedido e cortava em 100, sem sinalizar nada — qualquer
 * atividade além da centésima da semana desaparecia em silêncio da
 * Agenda. Só aumentar o teto do RPC não resolveria de verdade (qualquer
 * teto fixo pode ser ultrapassado por um workspace maior); a correção é
 * paginar de verdade até esgotar o total_count devolvido pelo próprio
 * RPC. Este teste simula um workspace com mais de 100 atividades numa
 * mesma semana e confirma que a ÚLTIMA continua acessível.
 */

// vi.hoisted() garante que rpcMock já existe quando a factory de
// vi.mock() (hoisted acima de tudo pelo próprio Vitest) roda de verdade.
const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));

const { listAllActivities, ActivitiesLoadError } = await import("@/modules/activities/queries");

function makeRow(n: number) {
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
    due_at: "2026-09-14T10:00:00.000Z",
    has_time: true,
    status: "pending",
    completed_at: null,
    source: "manual",
    lock_version: 0,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  };
}

const EMPTY_COUNTS = { overdue: 0, today: 0, tomorrow: 0, week: 0, unassigned: 0 };

describe("listAllActivities", () => {
  it("pagina além do teto de 100 do RPC — a atividade 105 (última) continua acessível", async () => {
    const total = 105;
    const page1 = Array.from({ length: 100 }, (_, i) => makeRow(i + 1));
    const page2 = Array.from({ length: 5 }, (_, i) => makeRow(101 + i));

    rpcMock.mockReset();
    rpcMock.mockImplementation(async (_fn: string, args: Record<string, unknown>) => {
      const page = args.p_page as number;
      const items = page === 1 ? page1 : page === 2 ? page2 : [];
      return { data: [{ items, total_count: total, counts: { ...EMPTY_COUNTS, week: total } }], error: null };
    });

    const result = await listAllActivities("workspace-1", { filter: "week", status: "all" });

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(result.total).toBe(105);
    expect(result.items).toHaveLength(105);
    expect(result.items.at(-1)?.id).toBe("item-105");
    expect(result.items.at(-1)?.title).toBe("Atividade 105");
  });

  it("não faz página extra quando tudo cabe na primeira busca", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: [{ items: [makeRow(1)], total_count: 1, counts: { ...EMPTY_COUNTS, week: 1 } }],
      error: null,
    }));

    const result = await listAllActivities("workspace-1", { filter: "week", status: "all" });

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(1);
  });

  /**
   * Achado real da revisão pré-merge: a versão anterior desta função, ao
   * encontrar uma página com erro (ou uma busca vazia sem ter batido no
   * total), simplesmente parava o laço e devolvia o que já tinha
   * acumulado como se fosse a lista inteira — sucesso com dado parcial,
   * sem sinalizar nada. Nunca deve devolver "ok" nesse caso: tem que
   * jogar ActivitiesLoadError, para a Agenda mostrar erro tratado (com
   * "tentar novamente") em vez de uma semana truncada disfarçada de
   * completa.
   */
  it("joga ActivitiesLoadError quando uma página falha no meio da busca — nunca devolve lista parcial como sucesso", async () => {
    const total = 105;
    const page1 = Array.from({ length: 100 }, (_, i) => makeRow(i + 1));

    rpcMock.mockReset();
    rpcMock.mockImplementation(async (_fn: string, args: Record<string, unknown>) => {
      const page = args.p_page as number;
      if (page === 1) {
        return { data: [{ items: page1, total_count: total, counts: { ...EMPTY_COUNTS, week: total } }], error: null };
      }
      return { data: null, error: { message: "conexão perdida com o banco (simulado)" } };
    });

    await expect(listAllActivities("workspace-1", { filter: "week", status: "all" })).rejects.toThrow(
      ActivitiesLoadError,
    );
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  /**
   * Achado real da revisão pré-merge: se o total_count nunca for
   * alcançado dentro do teto de segurança de páginas, a versão anterior
   * também devolvia sucesso com a lista truncada em silêncio. A trava de
   * segurança (50 páginas) continua existindo — a correção não é
   * aumentá-la, é parar de fingir que uma busca incompleta terminou.
   */
  it("joga ActivitiesLoadError ao atingir o limite de páginas com o total ainda pendente — preserva a trava em 50", async () => {
    const hugeTotal = 10_000; // nunca cabe em 50 páginas de 100 (5.000 no máximo)
    const fullPage = Array.from({ length: 100 }, (_, i) => makeRow(i + 1));

    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: [{ items: fullPage, total_count: hugeTotal, counts: { ...EMPTY_COUNTS, week: hugeTotal } }],
      error: null,
    }));

    await expect(listAllActivities("workspace-1", { filter: "week", status: "all" })).rejects.toThrow(
      ActivitiesLoadError,
    );
    // Exatamente 50 chamadas — a trava de segurança não foi tocada nem
    // silenciosamente aumentada para "resolver" o teste.
    expect(rpcMock).toHaveBeenCalledTimes(50);
  });
});
