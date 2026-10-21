/**
 * @vitest-environment node
 *
 * B3.1 — contrato do provedor de WhatsApp e provedor simulado. A seleção
 * pelo provedor do canal está em b3-1-revisao-provedor.test.ts. Nenhuma
 * chamada externa.
 */
import { describe, expect, it } from "vitest";

import { VerifiedWebhookBody, WHATSAPP_CAPABILITIES, whatsappContactIdentity } from "@/server/whatsapp/provider/contract";
import {
  SIMULATED_SIGNATURE_HEADER,
  signSimulatedWebhook,
  SimulatedWhatsAppProvider,
} from "@/server/whatsapp/provider/simulated";

const SECRET = "segredo-simulado-de-teste-0001";
const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

describe("contrato do provedor simulado", () => {
  const provider = new SimulatedWhatsAppProvider();

  it("descreve todas as capacidades do contrato, e só verificar/normalizar estão ativas", () => {
    const caps = provider.describeCapabilities();
    expect(Object.keys(caps).sort()).toEqual([...WHATSAPP_CAPABILITIES].sort());
    expect(caps).toEqual({
      verifyWebhook: true,
      normalizeEvents: true,
      sendText: false,
      sendTemplate: false,
      lookupMessage: false,
      fetchMedia: false,
    });
  });

  it("capacidades fora da B3.1 respondem 'unsupported' explícito, nunca sucesso", async () => {
    const send = { routingKey: "r", recipient: whatsappContactIdentity({ phoneE164: "+5511999990000" })!, text: "oi", correlationId: "c" };
    await expect(provider.sendText(send)).resolves.toEqual({ ok: false, reason: "unsupported", capability: "sendText" });
    await expect(
      provider.sendTemplate({ ...send, templateName: "t", templateLanguage: "pt_BR", parameters: [] }),
    ).resolves.toEqual({ ok: false, reason: "unsupported", capability: "sendTemplate" });
    await expect(provider.lookupMessage({ routingKey: "r", providerMessageId: "m" })).resolves.toEqual({
      ok: false,
      reason: "unsupported",
      capability: "lookupMessage",
    });
    await expect(provider.fetchMedia({ routingKey: "r", providerMediaRef: "x" })).resolves.toEqual({
      ok: false,
      reason: "unsupported",
      capability: "fetchMedia",
    });
  });
});

describe("verificação de assinatura do webhook simulado", () => {
  const provider = new SimulatedWhatsAppProvider();
  const body = new TextEncoder().encode(JSON.stringify({ version: 1, events: [] }));
  const headers = (value?: string) => new Headers(value ? { [SIMULATED_SIGNATURE_HEADER]: value } : {});

  it("assinatura válida", () => {
    const value = signSimulatedWebhook(body, SECRET, NOW_S);
    expect(provider.verifyWebhook({ rawBody: body, headers: headers(value), secret: SECRET, nowMs: NOW_MS })).toEqual({
      ok: true,
      verified: expect.any(VerifiedWebhookBody),
    });
  });

  it("sem cabeçalho", () => {
    expect(provider.verifyWebhook({ rawBody: body, headers: headers(), secret: SECRET, nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it.each(["t=1", "s=" + "a".repeat(64), "t=abc,s=" + "a".repeat(64), "t=1,s=xyz", "t=1,t=2,s=" + "a".repeat(64)])(
    "cabeçalho malformado %j",
    (value) => {
      expect(provider.verifyWebhook({ rawBody: body, headers: headers(value), secret: SECRET, nowMs: NOW_MS })).toEqual({
        ok: false,
        reason: "malformed_signature",
      });
    },
  );

  it("assinatura vencida", () => {
    const value = signSimulatedWebhook(body, SECRET, NOW_S - 301);
    expect(provider.verifyWebhook({ rawBody: body, headers: headers(value), secret: SECRET, nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: "stale_signature",
    });
  });

  it("corpo alterado, outro segredo ou outro timestamp não conferem", () => {
    const value = signSimulatedWebhook(body, SECRET, NOW_S);
    const other = signSimulatedWebhook(body, "outro-segredo", NOW_S);
    const otherTime = signSimulatedWebhook(body, SECRET, NOW_S - 1).split(",")[1];
    for (const [rawBody, header] of [
      [new Uint8Array([...body, 0x20]), value],
      [body, other],
      [body, `t=${NOW_S},${otherTime}`],
    ] as const) {
      expect(provider.verifyWebhook({ rawBody, headers: headers(header), secret: SECRET, nowMs: NOW_MS })).toEqual({
        ok: false,
        reason: "signature_mismatch",
      });
    }
  });
});

describe("normalização de eventos simulados para tipos próprios do CRM", () => {
  const provider = new SimulatedWhatsAppProvider();

  function normalize(text: string) {
    const bytes = new TextEncoder().encode(text);
    const headers = new Headers({ [SIMULATED_SIGNATURE_HEADER]: signSimulatedWebhook(bytes, SECRET, NOW_S) });
    const verified = provider.verifyWebhook({ rawBody: bytes, headers, secret: SECRET, nowMs: NOW_MS });
    if (!verified.ok || !("verified" in verified)) throw new Error("assinatura deveria conferir");
    return provider.normalizeEvents(verified.verified);
  }

  it("entrada, status e tipo não suportado viram eventos normalizados", () => {
    const body = JSON.stringify({
      version: 1,
      events: [
        { type: "message.inbound", id: "e1", routingKey: "sim-1", messageId: "m1", occurredAt: "2026-10-19T12:00:00Z", from: "+5511999990000", text: "Olá" },
        { type: "message.status", id: "e2", routingKey: "sim-1", messageId: "m0", occurredAt: "2026-10-19T12:00:01Z", status: "delivered" },
        { type: "other", id: "e3", routingKey: "sim-1", occurredAt: "2026-10-19T12:00:02Z", providerType: "reaction" },
      ],
    });
    const result = normalize(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toEqual([
      {
        kind: "message.inbound",
        originCandidate: "inbound",
        providerEventId: "e1",
        routingKey: "sim-1",
        providerMessageId: "m1",
        waMessageId: null,
        occurredAt: new Date("2026-10-19T12:00:00Z"),
        sender: { kind: "phone", phoneE164: "+5511999990000", bsuid: null },
        senderProfileName: null,
        contentKind: "text",
        text: "Olá",
      },
      {
        kind: "message.status",
        originCandidate: "external_api",
        providerEventId: "e2",
        routingKey: "sim-1",
        providerMessageId: "m0",
        waMessageId: null,
        externalId: null,
        occurredAt: new Date("2026-10-19T12:00:01Z"),
        status: "delivered",
        errorCode: null,
        recipient: null,
        providerCost: null,
      },
      { kind: "unsupported", providerEventId: "e3", routingKey: "sim-1", occurredAt: new Date("2026-10-19T12:00:02Z"), providerType: "reaction" },
    ]);
  });

  it.each([
    ["não é JSON", "{"],
    ["versão errada", JSON.stringify({ version: 2, events: [] })],
    ["lista vazia", JSON.stringify({ version: 1, events: [] })],
    ["telefone fora de E.164", JSON.stringify({ version: 1, events: [{ type: "message.inbound", id: "e", routingKey: "r", messageId: "m", occurredAt: "2026-10-19T12:00:00Z", from: "11999990000", text: "x" }] })],
    ["formato da Meta não é aceito pelo simulado", JSON.stringify({ object: "whatsapp_business_account", entry: [] })],
  ])("payload inválido: %s", (_nome, body) => {
    expect(normalize(body)).toEqual({ ok: false, reason: "invalid_payload" });
  });
});
