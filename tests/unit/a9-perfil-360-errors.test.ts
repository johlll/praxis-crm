import { describe, expect, it, vi } from "vitest";

/**
 * A9 — mesmo espírito de ActivitiesLoadError/ConversationsLoadError/
 * ClientDetailLoadError (A6/A7/A8): falha operacional de consulta nunca
 * vira estado vazio disfarçado de "sem dados ainda". get_conflict_check(),
 * por outro lado, tem um estado vazio LEGÍTIMO ("não verificado") que não
 * deve ser confundido com erro.
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));

const { getLeadTimelinePage, LeadTimelineLoadError } = await import("@/modules/timeline/queries");
const { getConflictCheck, ConflictCheckLoadError } = await import("@/modules/conflict-checks/queries");
const { listProposalsForLead, ProposalsLoadError } = await import("@/modules/proposals/queries");

describe("getLeadTimelinePage", () => {
  it("falha operacional joga LeadTimelineLoadError — nunca vira timeline vazia", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: "conexão perdida (simulado)" } }));

    await expect(getLeadTimelinePage("lead-1")).rejects.toThrow(LeadTimelineLoadError);
  });

  it("devolve os eventos e has_more quando a busca funciona", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: [{ items: [{ event_type: "nota", occurred_at: "2026-09-13T10:00:00Z", id: "n1", payload: { body: "oi" } }], has_more: true }],
      error: null,
    }));

    const result = await getLeadTimelinePage("lead-1");
    expect(result.hasMore).toBe(true);
    expect(result.items).toEqual([
      { eventType: "nota", occurredAt: "2026-09-13T10:00:00Z", id: "n1", payload: { body: "oi" } },
    ]);
  });
});

describe("getConflictCheck", () => {
  it("falha operacional joga ConflictCheckLoadError", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: "conexão perdida (simulado)" } }));

    await expect(getConflictCheck("lead-1")).rejects.toThrow(ConflictCheckLoadError);
  });

  it("sem registro ainda, devolve o estado padrão 'nao_verificado' — nunca um erro", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: { id: null, status: "nao_verificado", note: null, checked_by: null, checked_at: null, lock_version: null },
      error: null,
    }));

    const result = await getConflictCheck("lead-1");
    expect(result.status).toBe("nao_verificado");
    expect(result.id).toBeNull();
  });
});

describe("listProposalsForLead", () => {
  it("falha operacional joga ProposalsLoadError", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: "conexão perdida (simulado)" } }));

    await expect(listProposalsForLead("lead-1")).rejects.toThrow(ProposalsLoadError);
  });

  it("payload de viewer nunca contém value_cents (projeção aplicada no servidor, confiada aqui)", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: [
        {
          id: "p1",
          opportunity_id: "opp-1",
          number: "PROP-2026-0001",
          status: "enviada",
          sent_channels: ["whatsapp"],
          sent_at: "2026-09-13T10:00:00Z",
          decided_at: null,
          decision_note: null,
          lock_version: 1,
          created_at: "2026-09-13T09:00:00Z",
        },
      ],
      error: null,
    }));

    const result = await listProposalsForLead("lead-1");
    expect(result[0]?.valueCents).toBeUndefined();
    expect(result[0]?.status).toBe("enviada");
  });
});
