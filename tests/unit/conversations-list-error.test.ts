import { describe, expect, it, vi } from "vitest";

/**
 * Achado da revisão pré-merge: listConversations() tratava erro de consulta
 * (RPC falhou) e "zero conversas de verdade" como a MESMA coisa — as duas
 * situações devolviam `{items: [], total: 0}`, e a Central de Conversas
 * mostrava "nenhuma conversa ainda" mesmo quando a busca tinha falhado.
 * Mesmo espírito de ActivitiesLoadError (A6) e ConversationMessagesLoadError
 * (A7): erro de carregamento precisa subir como exceção própria, para
 * conversas/error.tsx mostrar erro tratado com "tentar novamente" — nunca
 * uma lista vazia disfarçada de "sem conversas".
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));

const { listConversations, ConversationsLoadError } = await import("@/modules/conversations/queries");

describe("listConversations", () => {
  it("joga ConversationsLoadError quando a busca falha — nunca devolve lista vazia disfarçada de 'sem conversas'", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: null,
      error: { message: "conexão perdida com o banco (simulado)" },
    }));

    await expect(listConversations("workspace-1")).rejects.toThrow(ConversationsLoadError);
  });

  it("um workspace genuinamente sem conversas (RPC ok, lista vazia de verdade) continua distinguível de uma falha", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: [{ items: [], total_count: 0 }],
      error: null,
    }));

    const result = await listConversations("workspace-1");
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
              id: "conv-1",
              wa_id: "+5511900000000",
              contact_id: "contact-1",
              contact_name: "Contato Teste",
              lead_id: "lead-1",
              legal_area: "Cível",
              opportunity_id: "opp-1",
              needs_link_review: false,
              last_message_at: "2026-09-11T10:00:00.000Z",
              last_message_text: "Olá",
              last_message_direction: "inbound",
              last_message_status: "delivered",
            },
          ],
          total_count: 1,
        },
      ],
      error: null,
    }));

    const result = await listConversations("workspace-1");
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe("conv-1");
  });
});
