import { describe, expect, it, vi } from "vitest";

/**
 * listFormEndpoints() — item 2 da terceira rodada de auditoria pós-dry-
 * run: `answers_config` corrompido no banco não pode virar `{fields: []}`
 * em silêncio. Um fallback assim já causou perda de dados de verdade — a
 * tela de edição nascia achando que o endpoint não tinha campo nenhum, e
 * salvar QUALQUER outra alteração reenviava esse fallback vazio como se
 * fosse a configuração atual, apagando os campos realmente gravados no
 * banco. Mesmo princípio de `ClientsLoadError`/`ConversationsLoadError`:
 * falha de leitura sempre LANÇA, nunca vira dado disfarçado.
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));

const { listFormEndpoints, FormEndpointsLoadError } = await import("@/modules/forms/queries");

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "endpoint-1",
    name: "Captação",
    status: "active",
    disabled_at: null,
    pipeline_id: "pipeline-1",
    pipeline_name: "Padrão",
    stage_id: "stage-1",
    stage_name: "Novo",
    legal_area: "Cível",
    initial_activity_type: "call",
    initial_activity_due_minutes: 60,
    capture_mode: "new_intake",
    contract_version: 1,
    turnstile_action: "formulario",
    allowed_hostnames: ["exemplo.test"],
    answers_config: { fields: [] },
    public_key: "chave-publica",
    revoked_key_count: 0,
    received_events: 0,
    created_at: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("listFormEndpoints", () => {
  it("joga FormEndpointsLoadError quando a RPC falha", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: null,
      error: { message: "conexão perdida com o banco (simulado)" },
    }));

    await expect(listFormEndpoints("workspace-1")).rejects.toThrow(FormEndpointsLoadError);
  });

  it("answers_config CORROMPIDO no banco joga FormEndpointsLoadError — nunca vira {fields: []} em silêncio", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: [baseRow({ answers_config: { fields: [{ key: "CHAVE INVALIDA", label: "x", type: "text" }] } })],
      error: null,
    }));

    await expect(listFormEndpoints("workspace-1")).rejects.toThrow(FormEndpointsLoadError);
  });

  it("answers_config com maxLength não inteiro também joga FormEndpointsLoadError", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: [
        baseRow({
          answers_config: { fields: [{ key: "motivo", label: "Motivo", type: "text", maxLength: 1.5 }] },
        }),
      ],
      error: null,
    }));

    await expect(listFormEndpoints("workspace-1")).rejects.toThrow(FormEndpointsLoadError);
  });

  it("answers_config LEGITIMAMENTE vazio ({fields: []}) carrega normalmente — não é tratado como corrompido", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: [baseRow({ answers_config: { fields: [] } })],
      error: null,
    }));

    const result = await listFormEndpoints("workspace-1");
    expect(result).toHaveLength(1);
    expect(result[0]?.answersConfig).toEqual({ fields: [] });
  });

  it("answers_config VÁLIDO com campos é lido fielmente — é isso que a edição precisa para não apagar nada ao salvar", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({
      data: [
        baseRow({
          answers_config: { fields: [{ key: "motivo", label: "Motivo", type: "text", required: true, maxLength: 500 }] },
        }),
      ],
      error: null,
    }));

    const result = await listFormEndpoints("workspace-1");
    expect(result[0]?.answersConfig.fields).toEqual([
      { key: "motivo", label: "Motivo", type: "text", required: true, maxLength: 500 },
    ]);
  });

  it("um workspace sem endpoint nenhum continua distinguível de uma falha", async () => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({ data: [], error: null }));

    const result = await listFormEndpoints("workspace-1");
    expect(result).toEqual([]);
  });
});
