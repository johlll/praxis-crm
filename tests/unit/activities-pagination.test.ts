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

const { listAllActivities } = await import("@/modules/activities/queries");

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
});
