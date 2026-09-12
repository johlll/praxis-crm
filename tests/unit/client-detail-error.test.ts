import { describe, expect, it, vi } from "vitest";

/**
 * Achado da revisão pré-merge (item 3): getClient() precisa distinguir
 * "não encontrado / acesso negado" (client_not_found,
 * insufficient_permission — vira 404 de propósito, mesmo princípio de
 * leads/[id]) de uma falha operacional de verdade (rede, banco fora do
 * ar) — essa última precisa acionar o estado de erro com "Tentar
 * novamente" (ClientDetailLoadError, capturado por
 * clientes/[id]/error.tsx), nunca um 404 enganoso. generateMetadata()
 * chama getClient() também — cobrindo aqui porque um erro não tratado ali
 * some silenciosamente sem o teste explícito.
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));

const { getClient, ClientDetailLoadError } = await import("@/modules/clients/queries");

describe("getClient", () => {
  it("client_not_found vira null (404), não um erro jogado", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: null,
      error: { message: "client_not_found" },
    }));

    await expect(getClient("client-1")).resolves.toBeNull();
  });

  it("insufficient_permission também vira null (404) — mesmo tratamento de 'não encontrado'", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: null,
      error: { message: "insufficient_permission" },
    }));

    await expect(getClient("client-1")).resolves.toBeNull();
  });

  it("uma falha operacional (rede/banco) joga ClientDetailLoadError — nunca vira 404 disfarçado", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: null,
      error: { message: "conexão perdida com o banco (simulado)" },
    }));

    await expect(getClient("client-1")).rejects.toThrow(ClientDetailLoadError);
  });

  it("devolve o cliente normalmente quando a busca funciona, incluindo origin quando presente", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: {
        id: "client-1",
        workspace_id: "workspace-1",
        contact_id: "contact-1",
        contact_name: "Contato Teste",
        owner_user_id: null,
        owner_name: null,
        status: "ativo",
        lock_version: 0,
        created_at: "2026-09-11T10:00:00.000Z",
        updated_at: "2026-09-11T10:00:00.000Z",
        origin: { opportunity_id: "opp-1", legal_area: "Empresarial" },
        history: [],
      },
      error: null,
    }));

    const result = await getClient("client-1");
    expect(result?.origin).toEqual({ opportunityId: "opp-1", legalArea: "Empresarial" });
  });

  it("origin null (oportunidade de origem fora do alcance) nunca é substituída por outra — fica null mesmo", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: {
        id: "client-1",
        workspace_id: "workspace-1",
        contact_id: "contact-1",
        contact_name: "Contato Teste",
        owner_user_id: null,
        owner_name: null,
        status: "ativo",
        lock_version: 0,
        created_at: "2026-09-11T10:00:00.000Z",
        updated_at: "2026-09-11T10:00:00.000Z",
        origin: null,
        history: [
          {
            opportunity_id: "opp-2",
            legal_area: "Tributário",
            won_at: "2026-09-10T10:00:00.000Z",
            signed_at: null,
            handoff_id: "handoff-2",
            handoff_status: "pendente",
            handoff_target_system: null,
            handoff_awaiting_integration: true,
            handoff_attempts: 0,
            handoff_completed_at: null,
            handoff_created_at: "2026-09-10T10:00:00.000Z",
          },
        ],
      },
      error: null,
    }));

    const result = await getClient("client-1");
    expect(result?.origin).toBeNull();
    expect(result?.history).toHaveLength(1);
    expect(result?.history[0]?.opportunityId).toBe("opp-2");
  });
});

describe("generateMetadata da página de cliente", () => {
  it("propaga a falha operacional de getClient() em vez de engolir o erro (Next.js roteia para o error.tsx mais próximo)", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: null,
      error: { message: "conexão perdida com o banco (simulado)" },
    }));

    const { generateMetadata } = await import("@/app/(app)/clientes/[id]/page");
    await expect(generateMetadata({ params: Promise.resolve({ id: "client-1" }) })).rejects.toThrow(
      ClientDetailLoadError,
    );
  });
});
