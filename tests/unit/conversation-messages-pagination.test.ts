import { describe, expect, it, vi } from "vitest";

/**
 * A7 — histórico de mensagens é paginado por cursor (created_at da mais
 * antiga já carregada), nunca "carrega tudo" de uma vez (diferente do
 * problema corrigido na Agenda da A6). Mas a MESMA disciplina daquele
 * fix vale aqui: uma falha de busca nunca pode virar "conversa vazia" —
 * listConversationMessages() joga ConversationMessagesLoadError em vez de
 * devolver uma lista vazia disfarçada de "não há mensagens".
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));

const { listConversationMessages, ConversationMessagesLoadError } = await import(
  "@/modules/conversations/queries"
);
const { loadOlderMessagesAction } = await import("@/modules/conversations/actions");

function makeMessageRow(n: number) {
  return {
    id: `msg-${n}`,
    direction: "inbound",
    body_text: `Mensagem ${n}`,
    status: "delivered",
    status_updated_at: "2026-09-11T10:00:00.000Z",
    error_reason: null,
    sent_by: null,
    created_at: `2026-09-11T10:${String(n).padStart(2, "0")}:00.000Z`,
    wa_message_id: `wamid.${n}`,
  };
}

describe("listConversationMessages", () => {
  it("devolve a página pedida e sinaliza has_more corretamente", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: [{ items: [makeMessageRow(1), makeMessageRow(2)], has_more: true }],
      error: null,
    }));

    const result = await listConversationMessages("conv-1", { limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.items[0]?.id).toBe("msg-1");
  });

  /**
   * Achado da revisão pré-merge: created_at sozinho não desempata mensagens
   * com o MESMO timestamp — o cursor precisa ser composto (created_at, id).
   * Este teste garante que o wiring do lado do cliente sempre manda os DOIS
   * juntos (nunca um cursor incompleto); a matemática real do desempate
   * (duas mensagens empatadas no timestamp aparecendo cada uma exatamente
   * uma vez entre páginas) é validada no banco de verdade — pgTAP,
   * 12_a7_conversations.test.sql, seção de paginação.
   */
  it("repassa created_at E id do cursor juntos (p_before/p_before_id) — nunca um cursor incompleto", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({ data: [{ items: [], has_more: false }], error: null }));

    await listConversationMessages("conv-1", {
      before: { createdAt: "2026-09-11T10:05:00.000Z", id: "msg-5" },
      limit: 5,
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "list_conversation_messages",
      expect.objectContaining({
        p_before: "2026-09-11T10:05:00.000Z",
        p_before_id: "msg-5",
      }),
    );
  });

  it("joga ConversationMessagesLoadError quando a busca falha — nunca devolve lista vazia disfarçada de 'sem mensagens'", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: null,
      error: { message: "conexão perdida com o banco (simulado)" },
    }));

    await expect(listConversationMessages("conv-1")).rejects.toThrow(ConversationMessagesLoadError);
  });

  it("uma conversa genuinamente sem mensagens (RPC ok, lista vazia de verdade) continua distinguível de uma falha", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({ data: [{ items: [], has_more: false }], error: null }));

    const result = await listConversationMessages("conv-1");
    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });
});

describe("loadOlderMessagesAction", () => {
  it("em caso de falha, devolve {ok:false} tratável — nunca joga para o Client Component nem apaga o que já estava carregado", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: "falha simulada" } }));

    const result = await loadOlderMessagesAction("conv-1", { createdAt: "2026-09-11T10:00:00.000Z", id: "msg-1" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/não foi possível/i);
    }
  });

  it("em caso de sucesso, devolve os itens mais antigos e has_more", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: [{ items: [makeMessageRow(1)], has_more: false }],
      error: null,
    }));

    const result = await loadOlderMessagesAction("conv-1", { createdAt: "2026-09-11T10:02:00.000Z", id: "msg-2" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(1);
      expect(result.hasMore).toBe(false);
    }
  });
});
