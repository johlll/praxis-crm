/**
 * @vitest-environment node
 *
 * B3.1, revisão da PR #42 — pontos 1 e 2.
 *
 * 1. Toda leitura de credencial exige um contexto CONFIÁVEL do canal
 *    (workspace, ambiente, provedor, canal e routing key), obtido por
 *    resolução interna — nunca só o UUID, nunca valores do formulário. O
 *    webhook tem resolução própria e atômica por (provedor, routing key).
 * 2. O adaptador é escolhido pelo provedor GRAVADO no canal; a variável de
 *    ambiente só habilita ou desabilita. Antes de ler credencial ou chamar
 *    qualquer coisa: adaptador.kind === canal.provider === credencial.provider.
 *
 * Escritos ANTES da correção, contra o HEAD 3bdb181. O banco é simulado:
 * só se observa o que é pedido a ele.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: rpcMock }),
}));

const channels = await import("@/server/whatsapp/admin/channels");
const { encryptWhatsAppCredential } = await import("@/server/whatsapp/credential-crypto");
const { SimulatedWhatsAppProvider } = await import("@/server/whatsapp/provider/simulated");

const WS = "10000000-0000-0000-0000-000000000001";
const OTHER_WS = "10000000-0000-0000-0000-000000000002";
const USER = "20000000-0000-0000-0000-000000000001";
const CHANNEL = "30000000-0000-0000-0000-000000000001";
const OTHER_CHANNEL = "30000000-0000-0000-0000-000000000002";
const KEY = Buffer.alloc(32, 7).toString("base64");

type Provider = "simulated" | "ycloud" | "meta";
type Purpose = "api_key" | "webhook_secret";

function configure() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_PROVIDER", "simulated");
  vi.stubEnv("WHATSAPP_CREDENTIAL_KEY_VERSIONS", JSON.stringify({ "1": KEY }));
  vi.stubEnv("WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION", "1");
}

function safeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL,
    label: "Canal",
    provider: "simulated",
    environment: "preview",
    routing_key: "sim-1",
    display_phone_number: "+55 11 0000-0001",
    is_simulator: true,
    status: "active",
    send_enabled: false,
    status_changed_at: null,
    created_at: "2026-10-20T12:00:00Z",
    updated_at: "2026-10-20T12:00:00Z",
    credential_purposes: ["webhook_secret"],
    ...overrides,
  };
}

/** Linha de credencial cifrada com a AAD da PRÓPRIA linha: se o código
 * decifrasse com a identidade da linha (e não com a do contexto esperado),
 * a decifragem passaria. */
function credentialRow(
  plain: string,
  row: {
    channel_id?: string;
    workspace_id?: string;
    environment?: "preview" | "production";
    provider?: Provider;
    routing_key?: string;
    purpose?: Purpose;
  } = {},
) {
  const full = {
    channel_id: CHANNEL,
    workspace_id: WS,
    environment: "preview" as const,
    provider: "simulated" as Provider,
    routing_key: "sim-1",
    purpose: "webhook_secret" as Purpose,
    ...row,
  };
  const enc = encryptWhatsAppCredential(plain, {
    environment: full.environment,
    workspaceId: full.workspace_id,
    channelId: full.channel_id,
    provider: full.provider,
    purpose: full.purpose,
  });
  return { ...full, ciphertext: enc.ciphertextBase64, key_version: enc.keyVersion };
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function code(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code ?? (error as Error | null)?.message;
}

/** Resolve o canal pelo caminho interno (sessão já verificada): é a única
 * forma de obter um contexto confiável fora do webhook. */
async function trustedContext(row: Record<string, unknown> = {}) {
  rpcMock.mockResolvedValueOnce({ data: safeRow(row), error: null });
  const resolved = await channels.adminResolveManagedWhatsAppChannel({
    workspaceId: WS,
    actorUserId: USER,
    channelId: CHANNEL,
  });
  rpcMock.mockClear();
  return resolved.context;
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  rpcMock.mockReset();
  configure();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("rede proibida neste teste"));
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function consoleOutput(): string {
  return JSON.stringify(consoleSpies.map((spy) => spy.mock.calls));
}

describe("1. leitura de credencial exige contexto confiável do canal", () => {
  it("só o UUID de um canal de outro workspace não basta: recusado antes do banco, nada decifrado", async () => {
    const foreign = credentialRow("segredo-do-outro-workspace", { channel_id: OTHER_CHANNEL, workspace_id: OTHER_WS });
    rpcMock.mockResolvedValue({ data: [foreign], error: null });

    const outcome = await settle(
      // @ts-expect-error — formato antigo (só UUID + propósito) não é mais aceito.
      channels.adminReadWhatsAppChannelCredential({ channelId: OTHER_CHANNEL, purpose: "webhook_secret" }),
    );

    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("segredo-do-outro-workspace");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("contexto montado à mão (sem resolução interna) é recusado antes do banco", async () => {
    rpcMock.mockResolvedValue({ data: [credentialRow("segredo")], error: null });
    const forged = { channelId: CHANNEL, workspaceId: WS, environment: "preview", provider: "simulated", routingKey: "sim-1" };

    const outcome = await settle(
      channels.adminReadWhatsAppChannelCredential({
        // @ts-expect-error — um objeto literal não é um contexto resolvido.
        channel: forged,
        adapter: new SimulatedWhatsAppProvider(),
        purpose: "webhook_secret",
      }),
    );

    expect(outcome.ok).toBe(false);
    expect(code(!outcome.ok && outcome.error)).toBe("channel_context_untrusted");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("o pedido ao banco leva canal, workspace, provedor, routing key e propósito do contexto", async () => {
    const channel = await trustedContext();
    rpcMock.mockResolvedValueOnce({ data: [credentialRow("segredo")], error: null });

    const value = await channels.adminReadWhatsAppChannelCredential({
      channel,
      adapter: new SimulatedWhatsAppProvider(),
      purpose: "webhook_secret",
    });

    expect(value).toBe("segredo");
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("whatsapp_get_channel_credential", {
      p_channel_id: CHANNEL,
      p_workspace_id: WS,
      p_provider: "simulated",
      p_routing_key: "sim-1",
      p_purpose: "webhook_secret",
    });
  });

  it.each([
    ["outro workspace no mesmo ambiente", { workspace_id: OTHER_WS }],
    ["outro canal", { channel_id: OTHER_CHANNEL }],
    ["provedor divergente", { provider: "ycloud" as const }],
    ["routing key divergente", { routing_key: "sim-outra" }],
    ["outro ambiente", { environment: "production" as const }],
    ["outro propósito", { purpose: "api_key" as const }],
  ])("linha devolvida com %s é recusada ANTES de decifrar", async (_nome, divergence) => {
    const channel = await trustedContext();
    rpcMock.mockResolvedValueOnce({ data: [credentialRow("segredo-divergente", divergence)], error: null });

    const outcome = await settle(
      channels.adminReadWhatsAppChannelCredential({
        channel,
        adapter: new SimulatedWhatsAppProvider(),
        purpose: "webhook_secret",
      }),
    );

    expect(outcome.ok).toBe(false);
    // Recusa por divergência de identidade, não por falha da cifra: a
    // decifragem nem chegou a ser tentada.
    expect(["channel_context_mismatch", "provider_mismatch"]).toContain(code(!outcome.ok && outcome.error));
    expect(JSON.stringify(outcome)).not.toContain("segredo-divergente");
  });

  it("canal de outro ambiente na resolução interna é recusado", async () => {
    rpcMock.mockResolvedValueOnce({ data: safeRow({ environment: "production" }), error: null });
    const outcome = await settle(
      channels.adminResolveManagedWhatsAppChannel({ workspaceId: WS, actorUserId: USER, channelId: CHANNEL }),
    );
    expect(outcome.ok).toBe(false);
    expect(code(!outcome.ok && outcome.error)).toBe("channel_environment_mismatch");
  });

  it("recusa do banco vira código simbólico, sem texto cifrado", async () => {
    const channel = await trustedContext();
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "channel_not_found" } });
    const outcome = await settle(
      channels.adminReadWhatsAppChannelCredential({
        channel,
        adapter: new SimulatedWhatsAppProvider(),
        purpose: "webhook_secret",
      }),
    );
    expect(code(!outcome.ok && outcome.error)).toBe("channel_not_found");
  });

  it("nenhum texto cifrado ou segredo aparece em resposta, erro ou log", async () => {
    const channel = await trustedContext();
    const good = credentialRow("segredo-em-claro-0001");
    const tampered = { ...good, ciphertext: good.ciphertext.slice(0, -4) + "AAAA" };
    rpcMock.mockResolvedValueOnce({ data: [tampered], error: null });

    const outcome = await settle(
      channels.adminReadWhatsAppChannelCredential({
        channel,
        adapter: new SimulatedWhatsAppProvider(),
        purpose: "webhook_secret",
      }),
    );

    expect(outcome.ok).toBe(false);
    const visible = JSON.stringify(outcome) + String(!outcome.ok && (outcome.error as Error).message) + consoleOutput();
    expect(visible).not.toContain(good.ciphertext);
    expect(visible).not.toContain(tampered.ciphertext);
    expect(visible).not.toContain("segredo-em-claro-0001");
  });
});

describe("1. webhook: resolução própria e atômica por (provedor, routing key)", () => {
  function webhookRow(overrides: Record<string, unknown> = {}, plain = "segredo-webhook") {
    const base = credentialRow(plain, overrides as Parameters<typeof credentialRow>[1]);
    return {
      channel_id: base.channel_id,
      workspace_id: base.workspace_id,
      environment: base.environment,
      provider: base.provider,
      routing_key: base.routing_key,
      status: "active",
      ciphertext: base.ciphertext,
      key_version: base.key_version,
      ...("status" in overrides ? { status: overrides.status } : {}),
    };
  }

  it("pede ao banco só provedor e routing key, numa chamada, e devolve contexto + segredo do webhook", async () => {
    rpcMock.mockResolvedValueOnce({ data: [webhookRow()], error: null });

    const resolved = await channels.adminResolveWhatsAppWebhookChannel({ provider: "simulated", routingKey: "sim-1" });

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("whatsapp_resolve_webhook_channel", {
      p_provider: "simulated",
      p_routing_key: "sim-1",
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.webhookSecret).toBe("segredo-webhook");
    expect(resolved!.adapter.kind).toBe("simulated");
    expect(resolved!.channel).toMatchObject({
      channelId: CHANNEL,
      workspaceId: WS,
      environment: "preview",
      provider: "simulated",
      routingKey: "sim-1",
    });
  });

  it("nenhum canal para a routing key → null, sem decifrar nada", async () => {
    rpcMock.mockResolvedValueOnce({ data: [], error: null });
    await expect(channels.adminResolveWhatsAppWebhookChannel({ provider: "simulated", routingKey: "sim-x" })).resolves.toBeNull();
  });

  it.each([
    ["routing key diferente da pedida", { routing_key: "sim-outra" }],
    ["provedor diferente do pedido", { provider: "ycloud" }],
    ["outro ambiente", { environment: "production" }],
  ])("linha com %s é recusada antes de decifrar", async (_nome, divergence) => {
    rpcMock.mockResolvedValueOnce({ data: [webhookRow(divergence, "segredo-errado")], error: null });
    const outcome = await settle(channels.adminResolveWhatsAppWebhookChannel({ provider: "simulated", routingKey: "sim-1" }));
    expect(outcome.ok).toBe(false);
    expect(["channel_context_mismatch", "provider_mismatch", "channel_environment_mismatch"]).toContain(
      code(!outcome.ok && outcome.error),
    );
    expect(JSON.stringify(outcome)).not.toContain("segredo-errado");
  });

  it("mais de uma linha (não deveria existir) → recusado", async () => {
    rpcMock.mockResolvedValueOnce({ data: [webhookRow(), webhookRow()], error: null });
    const outcome = await settle(channels.adminResolveWhatsAppWebhookChannel({ provider: "simulated", routingKey: "sim-1" }));
    expect(outcome.ok).toBe(false);
  });
});

describe("2. o adaptador é o do provedor gravado no canal", () => {
  it("webhook de provedor não habilitado: nada é pedido ao banco nem à rede", async () => {
    // A variável diz `simulated`; o pedido é de um canal YCloud.
    const outcome = await settle(channels.adminResolveWhatsAppWebhookChannel({ provider: "ycloud", routingKey: "yc-1" }));
    expect(outcome.ok).toBe(false);
    expect(code(!outcome.ok && outcome.error)).toBe("whatsapp_provider_unavailable");
    expect(rpcMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("canal YCloud com WHATSAPP_PROVIDER=simulated jamais usa o simulador", async () => {
    const channel = await trustedContext({ provider: "ycloud", is_simulator: false, routing_key: "yc-1" });
    expect(channel.provider).toBe("ycloud");

    const outcome = await settle(channels.adminPrepareWhatsAppChannelCall({ channel, purpose: "api_key" }));

    expect(outcome.ok).toBe(false);
    expect(code(!outcome.ok && outcome.error)).toBe("whatsapp_provider_unavailable");
    expect(rpcMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("adaptador de outro provedor é recusado antes do banco", async () => {
    const channel = await trustedContext({ provider: "ycloud", is_simulator: false, routing_key: "yc-1" });
    const outcome = await settle(
      channels.adminReadWhatsAppChannelCredential({
        channel,
        adapter: new SimulatedWhatsAppProvider(),
        purpose: "api_key",
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(code(!outcome.ok && outcome.error)).toBe("provider_mismatch");
    expect(rpcMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("canal simulado com WHATSAPP_PROVIDER=ycloud: desligado, nada é pedido ao banco", async () => {
    const channel = await trustedContext();
    vi.stubEnv("WHATSAPP_PROVIDER", "ycloud");
    const outcome = await settle(channels.adminPrepareWhatsAppChannelCall({ channel, purpose: "webhook_secret" }));
    expect(outcome.ok).toBe(false);
    expect(code(!outcome.ok && outcome.error)).toBe("whatsapp_provider_unavailable");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("caminho feliz: adaptador.kind === canal.provider === credencial.provider", async () => {
    const channel = await trustedContext();
    rpcMock.mockResolvedValueOnce({ data: [credentialRow("segredo")], error: null });

    const prepared = await channels.adminPrepareWhatsAppChannelCall({ channel, purpose: "webhook_secret" });

    expect(prepared.adapter.kind).toBe("simulated");
    expect(channel.provider).toBe("simulated");
    expect(prepared.credential).toBe("segredo");
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
