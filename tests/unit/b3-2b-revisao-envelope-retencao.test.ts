/**
 * @vitest-environment node
 *
 * B3.2b, revisão da PR #58:
 *  1. a inbox grava ANTES da normalização completa. Cada adaptador expõe
 *     uma inspeção mínima do envelope verificado (id do evento, tipo bruto,
 *     versão do envelope, exatamente um evento) que não interpreta mensagem,
 *     contato, status, custo ou conteúdo. Evento autêntico com envelope
 *     válido e conteúdo que o normalizador recusa é guardado cifrado; a
 *     falha de normalização é tratada depois (B3.2d);
 *  2. o tipo guardado é o tipo BRUTO do provedor (`provider_event_type`),
 *     nunca o normalizado;
 *  3. o acesso a uma entrada existente não depende do estado atual do canal
 *     (a regra de recebimento é do banco: pgTAP 31);
 *  4. teto técnico da retenção da inbox: 30 dias;
 *  5. o prazo é calculado SÓ pelo banco: a aplicação manda a retenção em
 *     segundos, e o relógio dela (adiantado ou atrasado) não muda nada.
 *
 * Escritos ANTES da correção, contra o HEAD 712ee0d; o item 5, contra o
 * HEAD 3a9ffff. Tudo fictício.
 */
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { body, bytes, FICT, inboundText, NOW_MS, signedHeaders, unknownType } from "../support/ycloud-fixtures";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: rpcMock }),
}));

const loadInbox = () => import("@/server/whatsapp/inbox");
const loadInboxCrypto = () => import("@/server/whatsapp/inbox-crypto");

const channels = await import("@/server/whatsapp/admin/channels");
const { SimulatedWhatsAppProvider, signSimulatedWebhook, SIMULATED_SIGNATURE_HEADER } = await import(
  "@/server/whatsapp/provider/simulated"
);
const { YCloudWhatsAppProvider, ycloudRoutingKey } = await import("@/server/whatsapp/provider/ycloud");
const { VerifiedWebhookBody } = await import("@/server/whatsapp/provider/contract");

const WS = "10000000-0000-0000-0000-000000000001";
const ACTOR = "20000000-0000-0000-0000-000000000001";
const CHANNEL = "33000000-0000-0000-0000-000000000011";
const INBOX_ID = "44000000-0000-0000-0000-000000000011";
const INBOX_KEY = Buffer.alloc(32, 9).toString("base64");
const SIM_SECRET = "segredo-simulado-ficticio-revisao";
const SIM_ROUTING = "sim-revisao-1";
const YC_ROUTING = ycloudRoutingKey(FICT.wabaId, FICT.businessPhone);
const TEXT = "Olá, ação — mensagem fictícia 🚀";
const DAY = 86_400;

function configure() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_ENV_SIGNING_KEY", "chave-de-teste-b3-whatsapp-0123456789");
  vi.stubEnv("WHATSAPP_INBOX_KEY_VERSIONS", JSON.stringify({ "1": INBOX_KEY }));
  vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", "1");
  vi.stubEnv("WHATSAPP_INBOX_RETENTION_SECONDS", "3600");
}

type Status = "active" | "paused" | "disconnected" | "disabled";

function channelRow(provider: "simulated" | "ycloud", status: Status) {
  return {
    id: CHANNEL,
    label: "Canal fictício",
    provider,
    environment: "preview",
    routing_key: provider === "ycloud" ? YC_ROUTING : SIM_ROUTING,
    display_phone_number: FICT.businessPhone,
    is_simulator: provider === "simulated",
    status,
    send_enabled: status === "active",
    status_changed_at: null,
    created_at: "2026-10-20T12:00:00Z",
    updated_at: "2026-10-20T12:00:00Z",
    credential_purposes: ["webhook_secret"],
  };
}

type RpcHandler = (args: Record<string, unknown>) => { data: unknown; error: unknown };
let handlers: Record<string, RpcHandler> = {};

beforeEach(() => {
  configure();
  handlers = {};
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    const handler = handlers[name];
    if (!handler) return { data: null, error: { message: `rpc_nao_esperada:${name}` } };
    return handler(args);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Contexto confiável pela resolução administrada (sessão já autorizada):
 * o único caminho que existe hoje para um canal YCloud, que ainda não está
 * habilitado na resolução de provedor. */
async function managedContext(provider: "simulated" | "ycloud", status: Status = "active") {
  handlers.whatsapp_get_channel_state = () => ({ data: channelRow(provider, status), error: null });
  const { context } = await channels.adminResolveManagedWhatsAppChannel({ channelId: CHANNEL, workspaceId: WS, actorUserId: ACTOR });
  rpcMock.mockClear();
  return context;
}

function verifyYCloud(raw: Uint8Array) {
  const result = new YCloudWhatsAppProvider().verifyWebhook({ rawBody: raw, headers: signedHeaders(raw), secret: FICT.secret, nowMs: NOW_MS });
  if (!result.ok) throw new Error(`assinatura recusada no teste: ${result.reason}`);
  return result.verified;
}

function verifySimulated(raw: Uint8Array) {
  const headers = new Headers({ [SIMULATED_SIGNATURE_HEADER]: signSimulatedWebhook(raw, SIM_SECRET, Math.floor(NOW_MS / 1000)) });
  const result = new SimulatedWhatsAppProvider().verifyWebhook({ rawBody: raw, headers, secret: SIM_SECRET, nowMs: NOW_MS });
  if (!result.ok) throw new Error(`assinatura recusada no teste: ${result.reason}`);
  return result.verified;
}

const sha256 = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");
const storeCalls = () => rpcMock.mock.calls.filter(([name]) => name === "whatsapp_inbox_store");

/** Mensagem recebida AUTÊNTICA, com envelope válido, mas sem identidade do
 * remetente (sem telefone e sem BSUID): o normalizador completo recusa. */
function ycloudInboundWithoutIdentity() {
  const { from: _from, fromUserId: _bsuid, fromParentUserId: _parent, ...message } = inboundText.whatsappInboundMessage;
  return { ...inboundText, id: "evt_ficticio_sem_identidade_01", whatsappInboundMessage: message };
}

const SIM_INBOUND = {
  type: "message.inbound",
  id: "evt-sim-revisao-1",
  routingKey: SIM_ROUTING,
  messageId: "m1",
  occurredAt: "2026-10-20T12:00:00Z",
  from: FICT.customerPhone,
  text: TEXT,
};
const SIM_INBOUND_WITHOUT_IDENTITY = (({ from: _from, ...rest }) => ({ ...rest, id: "evt-sim-sem-identidade" }))(SIM_INBOUND);
const simBody = (events: unknown[], version: unknown = 1) => JSON.stringify({ version, events });

const SENSITIVE = [FICT.customerPhone, FICT.bsuid, FICT.parentBsuid, FICT.profileName, TEXT, "fictícia", FICT.secret, SIM_SECRET, INBOX_KEY];

// ---------------------------------------------------------------------
// 1. Inspeção mínima do envelope — YCloud
// ---------------------------------------------------------------------

describe("1. inspeção mínima do envelope (YCloud)", () => {
  const provider = new YCloudWhatsAppProvider();
  const inspect = (event: unknown) => provider.inspectEnvelope(verifyYCloud(bytes(typeof event === "string" ? event : body(event))));

  it("devolve só id, tipo bruto, versão e a contagem de um evento", () => {
    expect(inspect(inboundText)).toEqual({
      ok: true,
      envelope: {
        providerEventId: inboundText.id,
        providerEventType: "whatsapp.inbound_message.received",
        envelopeVersion: "v2",
        eventCount: 1,
      },
    });
  });

  it("não interpreta o conteúdo: nenhum telefone, BSUID, nome ou texto no resultado", () => {
    const result = inspect(inboundText);
    const text = JSON.stringify(result);
    for (const value of SENSITIVE) expect(text).not.toContain(value);
    expect(result.ok && Object.keys(result.envelope).sort()).toEqual(["envelopeVersion", "eventCount", "providerEventId", "providerEventType"]);
  });

  it("mensagem recebida sem identidade: a inspeção aceita; a normalização completa continua recusando", () => {
    const event = ycloudInboundWithoutIdentity();
    const verified = verifyYCloud(bytes(body(event)));
    expect(provider.inspectEnvelope(verified)).toMatchObject({
      ok: true,
      envelope: { providerEventId: event.id, providerEventType: "whatsapp.inbound_message.received" },
    });
    expect(provider.normalizeEvents(verified)).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("não exige o corpo específico do evento: só id, tipo, versão e data bastam", () => {
    expect(
      inspect({ id: "evt_ficticio_envelope_so", type: "whatsapp.inbound_message.received", apiVersion: "v2", createTime: "2026-10-20T12:00:00.000Z" }),
    ).toMatchObject({ ok: true, envelope: { providerEventId: "evt_ficticio_envelope_so" } });
  });

  it("tipo bruto desconhecido, envelope válido: aceito com o tipo como veio", () => {
    expect(inspect(unknownType)).toMatchObject({ ok: true, envelope: { providerEventType: unknownType.type } });
  });

  it.each([
    ["JSON inválido", "{ não é json", "invalid_json"],
    ["texto que não é objeto", '"só um texto"', "invalid_envelope"],
    ["null", "null", "invalid_envelope"],
    ["lote (lista de eventos)", JSON.stringify([inboundText, inboundText]), "batch_not_supported"],
    ["versão incompatível", { ...inboundText, apiVersion: "v3" }, "unsupported_envelope_version"],
    ["versão antiga", { ...inboundText, apiVersion: "v1" }, "unsupported_envelope_version"],
    ["sem versão", (({ apiVersion: _v, ...rest }) => rest)(inboundText), "invalid_envelope"],
    ["sem id", (({ id: _id, ...rest }) => rest)(inboundText), "invalid_envelope"],
    ["id curto demais", { ...inboundText, id: "abc" }, "invalid_envelope"],
    ["id com espaço", { ...inboundText, id: "evt ficticio 01" }, "invalid_envelope"],
    ["sem tipo", (({ type: _t, ...rest }) => rest)(inboundText), "invalid_envelope"],
    ["tipo malformado", { ...inboundText, type: "Tipo Inválido" }, "invalid_envelope"],
  ])("%s: recusado (%s)", (_name, event, reason) => {
    expect(inspect(event)).toEqual({ ok: false, reason });
  });

  it("UTF-8 inválido: recusado", () => {
    const raw = new Uint8Array([...bytes('{"id":"evt_ficticio_utf8_01","type":"whatsapp.x.y","apiVersion":"v2","n":"'), 0xff, ...bytes('"}')]);
    expect(provider.inspectEnvelope(verifyYCloud(raw))).toEqual({ ok: false, reason: "invalid_json" });
  });

  it.each([
    ["bytes crus", () => bytes(body(inboundText))],
    ["objeto que imita o corpo verificado", () => ({ byteLength: 10, decodeUtf8Strict: () => body(inboundText) })],
  ])("corpo não verificado (%s): recusado", (_name, make) => {
    expect(provider.inspectEnvelope(make() as never)).toEqual({ ok: false, reason: "unverified_body" });
  });
});

// ---------------------------------------------------------------------
// 2. Inspeção mínima do envelope — simulador
// ---------------------------------------------------------------------

describe("2. inspeção mínima do envelope (simulador)", () => {
  const provider = new SimulatedWhatsAppProvider();
  const inspect = (text: string) => provider.inspectEnvelope(verifySimulated(bytes(text)));

  it("devolve só id, tipo bruto, versão e a contagem de um evento", () => {
    expect(inspect(simBody([SIM_INBOUND]))).toEqual({
      ok: true,
      envelope: { providerEventId: "evt-sim-revisao-1", providerEventType: "message.inbound", envelopeVersion: "1", eventCount: 1 },
    });
  });

  it("mensagem recebida sem identidade: a inspeção aceita; a normalização completa continua recusando", () => {
    const verified = verifySimulated(bytes(simBody([SIM_INBOUND_WITHOUT_IDENTITY])));
    expect(provider.inspectEnvelope(verified)).toMatchObject({ ok: true, envelope: { providerEventId: "evt-sim-sem-identidade" } });
    expect(provider.normalizeEvents(verified)).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it.each([
    ["JSON inválido", "{ não é json", "invalid_json"],
    ["lote com dois eventos", simBody([SIM_INBOUND, { ...SIM_INBOUND, id: "evt-sim-revisao-2" }]), "batch_not_supported"],
    ["lista vazia", simBody([]), "invalid_envelope"],
    ["sem lista de eventos", JSON.stringify({ version: 1 }), "invalid_envelope"],
    ["versão incompatível", simBody([SIM_INBOUND], 2), "unsupported_envelope_version"],
    ["sem versão", JSON.stringify({ events: [SIM_INBOUND] }), "invalid_envelope"],
    ["evento sem id", simBody([(({ id: _id, ...rest }) => rest)(SIM_INBOUND)]), "invalid_envelope"],
    ["evento sem tipo", simBody([(({ type: _t, ...rest }) => rest)(SIM_INBOUND)]), "invalid_envelope"],
  ])("%s: recusado (%s)", (_name, text, reason) => {
    expect(inspect(text)).toEqual({ ok: false, reason });
  });

  it("corpo não verificado: recusado", () => {
    expect(provider.inspectEnvelope(bytes(simBody([SIM_INBOUND])) as never)).toEqual({ ok: false, reason: "unverified_body" });
  });
});

// ---------------------------------------------------------------------
// 3. A inbox grava antes da normalização completa (reprodução)
// ---------------------------------------------------------------------

describe("3. a inbox grava antes da normalização completa", () => {
  it("YCloud: mensagem autêntica sem identidade é guardada cifrada, com o tipo bruto só como metadado", async () => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const { decryptWhatsAppInboxBody } = await loadInboxCrypto();
    const channel = await managedContext("ycloud");
    const adapter = new YCloudWhatsAppProvider();
    const event = ycloudInboundWithoutIdentity();
    const raw = bytes(body(event));
    const verified = verifyYCloud(raw);
    handlers.whatsapp_inbox_store = () => ({ data: { outcome: "inserted", inbox_id: INBOX_ID }, error: null });

    await expect(storeWhatsAppWebhookDelivery({ channel, adapter, verified })).resolves.toEqual({ outcome: "inserted", inboxId: INBOX_ID });

    const [[, args]] = storeCalls() as [[string, Record<string, string>]];
    expect(args).toMatchObject({
      p_channel_id: CHANNEL,
      p_workspace_id: WS,
      p_provider: "ycloud",
      p_routing_key: YC_ROUTING,
      p_provider_event_id: event.id,
      p_provider_event_type: "whatsapp.inbound_message.received",
      p_body_sha256: sha256(raw),
    });
    expect(args).not.toHaveProperty("p_event_kind");
    const plain = decryptWhatsAppInboxBody(
      { keyVersion: args.p_key_version!, nonce: args.p_nonce!, ciphertext: args.p_ciphertext!, authTag: args.p_auth_tag! },
      { environment: "preview", workspaceId: WS, channelId: CHANNEL, provider: "ycloud", providerEventId: event.id },
    );
    expect(Array.from(plain)).toEqual(Array.from(raw));

    const sent = JSON.stringify(args);
    for (const value of [...SENSITIVE, Buffer.from(raw).toString("base64"), '"whatsappInboundMessage"']) expect(sent).not.toContain(value);

    // A falha de normalização continua existindo; só não impede a gravação.
    expect(adapter.normalizeEvents(verified)).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("simulador: mensagem autêntica sem identidade também é guardada", async () => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const channel = await managedContext("simulated");
    const verified = verifySimulated(bytes(simBody([SIM_INBOUND_WITHOUT_IDENTITY])));
    handlers.whatsapp_inbox_store = () => ({ data: { outcome: "inserted", inbox_id: INBOX_ID }, error: null });
    await expect(
      storeWhatsAppWebhookDelivery({ channel, adapter: new SimulatedWhatsAppProvider(), verified }),
    ).resolves.toMatchObject({ outcome: "inserted" });
    expect(storeCalls()[0]![1]).toMatchObject({ p_provider_event_id: "evt-sim-sem-identidade", p_provider_event_type: "message.inbound" });
  });

  it("a gravação nunca chama a normalização completa", async () => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const channel = await managedContext("ycloud");
    const adapter = new YCloudWhatsAppProvider();
    const normalize = vi.spyOn(adapter, "normalizeEvents");
    handlers.whatsapp_inbox_store = () => ({ data: { outcome: "inserted", inbox_id: INBOX_ID }, error: null });
    await storeWhatsAppWebhookDelivery({ channel, adapter, verified: verifyYCloud(bytes(body(inboundText))) });
    expect(normalize).not.toHaveBeenCalled();
    expect(storeCalls()[0]![1]).toMatchObject({ p_provider_event_type: "whatsapp.inbound_message.received" });
  });

  it("tipo bruto desconhecido do CRM, envelope válido: guardado com o tipo como veio", async () => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const channel = await managedContext("ycloud");
    handlers.whatsapp_inbox_store = () => ({ data: { outcome: "inserted", inbox_id: INBOX_ID }, error: null });
    await storeWhatsAppWebhookDelivery({ channel, adapter: new YCloudWhatsAppProvider(), verified: verifyYCloud(bytes(body(unknownType))) });
    expect(storeCalls()[0]![1]).toMatchObject({ p_provider_event_type: unknownType.type });
  });

  it.each([
    ["JSON inválido", "{ não é json", "invalid_payload"],
    ["envelope inválido", JSON.stringify({ id: "evt_ficticio_sem_tipo", apiVersion: "v2" }), "invalid_payload"],
    ["versão incompatível", body({ ...inboundText, apiVersion: "v3" }), "unsupported_envelope_version"],
    ["lote", JSON.stringify([inboundText]), "inbox_batch_not_supported"],
  ])("%s: recusado sem gravar (%s)", async (_name, text, code) => {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const channel = await managedContext("ycloud");
    await expect(
      storeWhatsAppWebhookDelivery({ channel, adapter: new YCloudWhatsAppProvider(), verified: verifyYCloud(bytes(text)) }),
    ).rejects.toMatchObject({ code });
    expect(storeCalls()).toHaveLength(0);
  });

  it("leitura e listagem expõem o tipo bruto, nunca um tipo normalizado", async () => {
    const { readPendingWhatsAppWebhookDelivery, listWhatsAppWebhookInbox } = await loadInbox();
    const { encryptWhatsAppInboxBody } = await loadInboxCrypto();
    const channel = await managedContext("ycloud");
    const raw = bytes(body(ycloudInboundWithoutIdentity()));
    const id = ycloudInboundWithoutIdentity().id;
    const enc = encryptWhatsAppInboxBody(raw, { environment: "preview", workspaceId: WS, channelId: CHANNEL, provider: "ycloud", providerEventId: id });
    handlers.whatsapp_inbox_get_pending = () => ({
      data: [
        {
          inbox_id: INBOX_ID,
          channel_id: CHANNEL,
          workspace_id: WS,
          environment: "preview",
          provider: "ycloud",
          routing_key: YC_ROUTING,
          provider_event_id: id,
          provider_event_type: "whatsapp.inbound_message.received",
          body_sha256: sha256(raw),
          key_version: enc.keyVersion,
          nonce: enc.nonce,
          ciphertext: enc.ciphertext,
          auth_tag: enc.authTag,
        },
      ],
      error: null,
    });
    handlers.whatsapp_inbox_list = () => ({ data: [safeRow({ state: "pending", processed_at: null })], error: null });

    const pending = await readPendingWhatsAppWebhookDelivery({ channel, inboxId: INBOX_ID });
    expect(pending).toMatchObject({ inboxId: INBOX_ID, providerEventId: id, providerEventType: "whatsapp.inbound_message.received" });
    expect(pending).not.toHaveProperty("eventKind");
    expect(VerifiedWebhookBody.is(pending!.verified)).toBe(true);

    const [entry] = await listWhatsAppWebhookInbox({ channel, limit: 10 });
    expect(entry).toMatchObject({ providerEventType: "whatsapp.inbound_message.received" });
    expect(entry).not.toHaveProperty("eventKind");
  });
});

function safeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INBOX_ID,
    provider_event_id: "evt_ficticio_sem_identidade_01",
    provider_event_type: "whatsapp.inbound_message.received",
    body_sha256: "a".repeat(64),
    received_at: "2026-10-20T12:00:00Z",
    retain_until: "2026-10-20T13:00:00Z",
    state: "processed",
    processed_at: "2026-10-20T12:00:05Z",
    failed_at: null,
    purged_at: null,
    error_code: null,
    conflict_count: 0,
    last_conflict_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// 4. Entrada existente: acesso não depende do estado atual do canal
// ---------------------------------------------------------------------

describe("4. entrada existente com o canal em outro estado", () => {
  it.each(["paused", "disconnected", "disabled"] as const)(
    "canal %s (contexto da resolução administrada): lista e finaliza a entrada histórica",
    async (status) => {
      const { listWhatsAppWebhookInbox, markWhatsAppWebhookDeliveryProcessed, markWhatsAppWebhookDeliveryFailed } = await loadInbox();
      const channel = await managedContext("ycloud", status);
      handlers.whatsapp_inbox_list = () => ({ data: [safeRow({ state: "pending", processed_at: null })], error: null });
      handlers.whatsapp_inbox_mark_processed = () => ({ data: safeRow(), error: null });
      handlers.whatsapp_inbox_mark_failed = () => ({
        data: safeRow({ state: "failed", processed_at: null, failed_at: "2026-10-20T12:00:05Z", error_code: "canal_desativado" }),
        error: null,
      });
      await expect(listWhatsAppWebhookInbox({ channel, limit: 10 })).resolves.toHaveLength(1);
      await expect(markWhatsAppWebhookDeliveryProcessed({ channel, inboxId: INBOX_ID })).resolves.toMatchObject({ state: "processed" });
      await expect(markWhatsAppWebhookDeliveryFailed({ channel, inboxId: INBOX_ID, errorCode: "canal_desativado" })).resolves.toMatchObject({
        state: "failed",
      });
    },
  );
});

// ---------------------------------------------------------------------
// 5. Retenção: teto técnico de 30 dias
// ---------------------------------------------------------------------

describe("5. retenção da inbox: mínimo de 60 s, teto de 30 dias, sem padrão", () => {
  async function storeWith(value: string | undefined) {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const channel = await managedContext("simulated");
    if (value === undefined) vi.stubEnv("WHATSAPP_INBOX_RETENTION_SECONDS", undefined as unknown as string);
    else vi.stubEnv("WHATSAPP_INBOX_RETENTION_SECONDS", value);
    handlers.whatsapp_inbox_store = () => ({ data: { outcome: "inserted", inbox_id: INBOX_ID }, error: null });
    return storeWhatsAppWebhookDelivery({
      channel,
      adapter: new SimulatedWhatsAppProvider(),
      verified: verifySimulated(bytes(simBody([SIM_INBOUND]))),
    });
  }

  it("o teto exportado é 30 dias", async () => {
    const inbox = await loadInbox();
    expect(inbox.WHATSAPP_INBOX_MAX_RETENTION_SECONDS).toBe(30 * DAY);
    expect(inbox.WHATSAPP_INBOX_MIN_RETENTION_SECONDS).toBe(60);
  });

  it.each([
    ["30 dias", 30 * DAY],
    ["7 dias (fictício)", 7 * DAY],
    ["60 segundos", 60],
  ])("%s: aceito, mandado ao banco em segundos", async (_name, seconds) => {
    await expect(storeWith(String(seconds))).resolves.toMatchObject({ outcome: "inserted" });
    expect(storeCalls()[0]![1]).toMatchObject({ p_retention_seconds: seconds });
    expect(storeCalls()[0]![1]).not.toHaveProperty("p_retain_until");
  });

  it.each([
    ["30 dias mais 1 segundo", String(30 * DAY + 1)],
    ["31 dias", String(31 * DAY)],
    ["3650 dias (teto antigo)", String(3650 * DAY)],
    ["ausente", undefined],
    ["59 segundos", "59"],
  ])("%s: falha fechada, sem gravar", async (_name, value) => {
    await expect(storeWith(value)).rejects.toMatchObject({ code: "retention_not_configured" });
    expect(storeCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// 6. O prazo é do banco: o relógio da aplicação não entra
// ---------------------------------------------------------------------

describe("6. o relógio da aplicação não define o prazo de retenção", () => {
  async function storeAt(appClockMs: number) {
    const { storeWhatsAppWebhookDelivery } = await loadInbox();
    const channel = await managedContext("simulated");
    vi.stubEnv("WHATSAPP_INBOX_RETENTION_SECONDS", String(30 * DAY));
    handlers.whatsapp_inbox_store = () => ({ data: { outcome: "inserted", inbox_id: INBOX_ID }, error: null });
    const verified = verifySimulated(bytes(simBody([SIM_INBOUND])));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(appClockMs);
      await storeWhatsAppWebhookDelivery({ channel, adapter: new SimulatedWhatsAppProvider(), verified });
    } finally {
      vi.useRealTimers();
    }
    const calls = storeCalls();
    expect(calls).toHaveLength(1);
    // Nonce e texto cifrado mudam a cada cifra; o resto tem de ser idêntico.
    const { p_nonce: _n, p_ciphertext: _c, p_auth_tag: _t, ...args } = calls[0]![1] as Record<string, unknown>;
    return args;
  }

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;

  it("manda só os segundos de retenção, nunca um horário absoluto", async () => {
    const args = await storeAt(NOW_MS);
    expect(args.p_retention_seconds).toBe(30 * DAY);
    expect(args).not.toHaveProperty("p_retain_until");
    expect(args).not.toHaveProperty("p_received_at");
    for (const value of Object.values(args)) expect(String(value)).not.toMatch(ISO_DATE);
  });

  it.each([
    ["adiantado 1 hora", NOW_MS + 3_600_000],
    ["atrasado 1 hora", NOW_MS - 3_600_000],
    ["adiantado 2 dias", NOW_MS + 2 * DAY * 1000],
  ])("relógio da aplicação %s: 30 dias aceitos, com os mesmos argumentos", async (_name, clock) => {
    const first = await storeAt(NOW_MS);
    const second = await storeAt(clock);
    expect(second).toEqual(first);
    expect(second).toMatchObject({ p_retention_seconds: 30 * DAY });
  });
});
