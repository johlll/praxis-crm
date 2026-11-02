/**
 * Construtores de teste do consumidor da inbox do WhatsApp (B3.2d-2b3):
 * linha de claim cifrada, eventos normalizados fictícios e um adaptador
 * fictício. Nada aqui usa mock: quem importa é que declara os mocks.
 * Tudo fictício.
 */
import { createHash } from "node:crypto";

import { encryptWhatsAppInboxBody } from "@/server/whatsapp/inbox-crypto";
import type { NormalizedWhatsAppEvent, WhatsAppProvider } from "@/server/whatsapp/provider/contract";

export const WS = "10000000-0000-0000-0000-000000000001";
export const CHANNEL = "36000000-0000-0000-0000-000000000001";
export const INBOX_ID = "46000000-0000-4000-8000-000000000001";
export const TOKEN = "6f1d2c3b-4a59-4e8f-9a1b-2c3d4e5f6a7b";
export const TOKEN_2 = "7a2e3d4c-5b6a-4f90-8b2c-3d4e5f6a7b8c";
export const ROUTING = "sim-consumidor-2b3";
export const INBOX_KEY = Buffer.alloc(32, 7).toString("base64");
export const PHONE = "+5511999990000";
export const PHONE_2 = "+5511988887777";
export const BSUID = "BR.1234567890";
export const TEXT = "Olá, quero falar sobre a ação — mensagem fictícia";
export const EVENT_ID = "evt-2b3-1";
export const OCCURRED = "2026-11-02T12:00:00.000Z";
export const WABA_REF = "waba-ref-2b3";
export const MESSAGE_ID = "5c000000-0000-4000-8000-000000000001";
export const CONVERSATION_ID = "5d000000-0000-4000-8000-000000000001";
export const IDENTITY_ID = "5e000000-0000-4000-8000-000000000001";

const bytesOf = (text: string) => new TextEncoder().encode(text);
export const sha256 = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");

/** Corpo qualquer: o adaptador fictício ignora o conteúdo, mas o claim
 * decifra e confere o hash de verdade. */
const BODY = bytesOf(JSON.stringify({ version: 1, events: [{ type: "fake", id: EVENT_ID }] }));

/** Linha que o banco devolve num claim bem-sucedido, cifrada com a AAD da
 * própria linha. */
export function claimRow(overrides: Record<string, unknown> = {}) {
  const enc = encryptWhatsAppInboxBody(BODY, {
    environment: "preview",
    workspaceId: WS,
    channelId: CHANNEL,
    provider: "simulated",
    providerEventId: EVENT_ID,
  } as never);
  return {
    outcome: "claimed",
    inbox_id: INBOX_ID,
    claim_token: TOKEN,
    claim_count: 1,
    claimed_at: "2026-11-02T12:00:00.000000+00:00",
    lease_until: "2026-11-02T12:05:00.000000+00:00",
    environment: "preview",
    workspace_id: WS,
    channel_id: CHANNEL,
    channel_status: "active",
    provider: "simulated",
    routing_key: ROUTING,
    provider_event_id: EVENT_ID,
    provider_event_type: "message.inbound",
    body_sha256: sha256(BODY),
    received_at: "2026-11-02T11:59:59.000000+00:00",
    retain_until: "2026-11-02T12:59:59.000000+00:00",
    key_version: enc.keyVersion,
    nonce: enc.nonce,
    ciphertext: enc.ciphertext,
    auth_tag: enc.authTag,
    ...overrides,
  };
}

const BASE = { providerEventId: EVENT_ID, occurredAt: new Date(OCCURRED) };
const PHONE_ID = { kind: "phone", phoneE164: PHONE, bsuid: null } as const;
const PHONE_ID_2 = { kind: "phone", phoneE164: PHONE_2, bsuid: null } as const;
const BOTH_ID = { kind: "phone_and_bsuid", phoneE164: PHONE, bsuid: BSUID } as const;

/** Um evento normalizado de cada tipo, como o adaptador entregaria. */
export const EVENTS = {
  inbound: {
    ...BASE,
    kind: "message.inbound",
    originCandidate: "inbound",
    routingKey: ROUTING,
    providerMessageId: "m-in-1",
    waMessageId: "wamid.IN1",
    sender: PHONE_ID,
    senderProfileName: "Cliente Fictício",
    contentKind: "text",
    text: TEXT,
  },
  outbound: {
    ...BASE,
    kind: "message.outbound_observed",
    originCandidate: "business_app",
    providerType: "smb_message_echoes",
    routingKey: ROUTING,
    providerMessageId: "m-out-1",
    waMessageId: "wamid.OUT1",
    recipient: PHONE_ID,
    contentKind: "text",
    text: TEXT,
  },
  status: {
    ...BASE,
    kind: "message.status",
    originCandidate: "external_api",
    routingKey: ROUTING,
    providerMessageId: "m-out-1",
    waMessageId: "wamid.OUT1",
    externalId: "ext-1",
    status: "delivered",
    errorCode: null,
    recipient: PHONE_ID,
    providerCost: { source: "provider", category: "service", amount: 0.0125, currency: "USD", finality: "final" },
  },
  identity: {
    ...BASE,
    kind: "contact.identity_changed",
    change: "phone_number",
    routingKey: ROUTING,
    previous: PHONE_ID,
    next: PHONE_ID_2,
  },
  accountWaba: {
    ...BASE,
    kind: "account",
    scope: "business_account",
    providerType: "whatsapp.business_account.deleted",
    providerAccountRef: WABA_REF,
    businessPhoneE164: null,
    routingKey: null,
    code: null,
  },
  accountPhone: {
    ...BASE,
    kind: "account",
    scope: "phone_number",
    providerType: "whatsapp.phone_number.deleted",
    providerAccountRef: WABA_REF,
    businessPhoneE164: PHONE,
    routingKey: ROUTING,
    code: "DELETED",
  },
  ignoredHistory: { ...BASE, kind: "ignored", reason: "history", providerType: "history", routingKey: ROUTING },
  ignoredGroup: { ...BASE, kind: "ignored", reason: "group_message", providerType: "group", routingKey: null },
  ignoredProduct: { ...BASE, kind: "ignored", reason: "non_whatsapp_product", providerType: "instagram", routingKey: null },
  unsupported: { ...BASE, kind: "unsupported", routingKey: null, providerType: "flows" },
} as const;

export const BOTH = BOTH_ID;

export const ev = (event: object, patch: Record<string, unknown> = {}) => ({ ...event, ...patch }) as unknown as NormalizedWhatsAppEvent;

/** O tipo bruto que o provedor gravou na linha: o `providerType` do evento,
 * quando ele existe. */
export const rawTypeOf = (event: object) => (event as { providerType?: string }).providerType ?? "message.inbound";

export function fakeAdapter(opts: {
  events?: NormalizedWhatsAppEvent[];
  normalized?: ReturnType<WhatsAppProvider["normalizeEvents"]>;
  envelope?: ReturnType<WhatsAppProvider["inspectEnvelope"]>;
  envelopeType?: string;
  onNormalize?: () => void;
}): WhatsAppProvider {
  return {
    kind: "simulated",
    describeCapabilities: () => ({ verifyWebhook: true, normalizeEvents: true, sendText: false, sendTemplate: false, lookupMessage: false, fetchMedia: false }),
    verifyWebhook: () => ({ ok: false, reason: "invalid_body" }),
    inspectEnvelope: () =>
      opts.envelope ?? {
        ok: true,
        envelope: { providerEventId: EVENT_ID, providerEventType: opts.envelopeType ?? "message.inbound", envelopeVersion: "1", eventCount: 1 },
      },
    normalizeEvents: () => {
      opts.onNormalize?.();
      return opts.normalized ?? { ok: true, events: opts.events ?? [ev(EVENTS.inbound)] };
    },
    sendText: async () => ({ ok: false, reason: "unsupported", capability: "sendText" }),
    sendTemplate: async () => ({ ok: false, reason: "unsupported", capability: "sendTemplate" }),
    lookupMessage: async () => ({ ok: false, reason: "unsupported", capability: "lookupMessage" }),
    fetchMedia: async () => ({ ok: false, reason: "unsupported", capability: "fetchMedia" }),
  };
}
