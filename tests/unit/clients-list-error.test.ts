import { describe, expect, it, vi } from "vitest";

/**
 * Item 7 do pedido da A8: listClients() precisa distinguir falha de
 * consulta de "workspace genuinamente sem clientes" — mesmo princípio já
 * aplicado a ConversationsLoadError (A7) e ActivitiesLoadError (A6).
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));

const { listClients, ClientsLoadError } = await import("@/modules/clients/queries");

describe("listClients", () => {
  it("joga ClientsLoadError quando a busca falha — nunca devolve lista vazia disfarçada de 'sem clientes'", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: null,
      error: { message: "conexão perdida com o banco (simulado)" },
    }));

    await expect(listClients("workspace-1")).rejects.toThrow(ClientsLoadError);
  });

  it("um workspace genuinamente sem clientes (RPC ok, lista vazia de verdade) continua distinguível de uma falha", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: [{ items: [], total_count: 0 }],
      error: null,
    }));

    const result = await listClients("workspace-1");
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("devolve a página pedida quando a busca funciona normalmente", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: [
        {
          items: [
            {
              id: "client-1",
              contact_id: "contact-1",
              contact_name: "Contato Teste",
              owner_user_id: "user-1",
              owner_name: "Fulano",
              status: "ativo",
              created_at: "2026-09-11T10:00:00.000Z",
              updated_at: "2026-09-11T10:00:00.000Z",
              lock_version: 0,
              opportunity_count: 2,
            },
          ],
          total_count: 1,
        },
      ],
      error: null,
    }));

    const result = await listClients("workspace-1");
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe("client-1");
    expect(result.items[0]?.opportunityCount).toBe(2);
  });
});
