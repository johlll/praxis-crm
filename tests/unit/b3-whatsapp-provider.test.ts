/**
 * @vitest-environment node
 *
 * B3.1 — contrato do provedor de WhatsApp, seleção por WHATSAPP_PROVIDER e
 * provedor simulado. Nenhuma chamada externa.
 */
import { describe, expect, it } from "vitest";

import { WHATSAPP_CAPABILITIES } from "@/server/whatsapp/provider/contract";
import { getWhatsAppProvider, resolveWhatsAppProvider } from "@/server/whatsapp/provider";
import {
  SIMULATED_SIGNATURE_HEADER,
  signSimulatedWebhook,
  SimulatedWhatsAppProvider,
} from "@/server/whatsapp/provider/simulated";

const SECRET = "segredo-simulado-de-teste-0001";
const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

describe("seleção do provedor (falha fechada)", () => {
  it.each([
    ["ausente", {}, "missing"],
    ["vazio", { WHATSAPP_PROVIDER: "" }, "missing"],
    ["só espaços", { WHATSAPP_PROVIDER: "   " }, "missing"],
    ["desconhecido", { WHATSAPP_PROVIDER: "twilio" }, "unknown"],
    ["maiúsculas não valem", { WHATSAPP_PROVIDER: "SIMULATED" }, "unknown"],
    ["ycloud ainda não existe", { WHATSAPP_PROVIDER: "ycloud" }, "not_available"],
    ["meta ainda não existe", { WHATSAPP_PROVIDER: "meta" }, "not_available"],
    ["simulado nunca em Production", { WHATSAPP_PROVIDER: "simulated", VERCEL_ENV: "production" }, "simulated_not_allowed_in_production"],
  ])("%s → desligado", (_nome, env, reason) => {
    expect(resolveWhatsAppProvider(env)).toEqual({ status: "disabled", reason });
    expect(getWhatsAppProvider(env)).toBeNull();
  });

  it("simulated fora de Production → provedor simulado", () => {
    const resolution = resolveWhatsAppProvider({ WHATSAPP_PROVIDER: "simulated", VERCEL_ENV: "preview" });
    expect(resolution.status).toBe("enabled");
    expect(resolution.status === "enabled" && resolution.provider.kind).toBe("simulated");
  });
});

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
    const send = { routingKey: "r", recipientPhoneE164: "+5511999990000", text: "oi", correlationId: "c" };
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
  const body = JSON.stringify({ version: 1, events: [] });
  const headers = (value?: string) => new Headers(value ? { [SIMULATED_SIGNATURE_HEADER]: value } : {});

  it("assinatura válida", () => {
    const value = signSimulatedWebhook(body, SECRET, NOW_S);
    expect(provider.verifyWebhook({ rawBody: body, headers: headers(value), secret: SECRET, nowMs: NOW_MS })).toEqual({ ok: true });
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
      [body + " ", value],
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

  it("entrada, status e tipo não suportado viram eventos normalizados", () => {
    const body = JSON.stringify({
      version: 1,
      events: [
        { type: "message.inbound", id: "e1", routingKey: "sim-1", messageId: "m1", occurredAt: "2026-10-19T12:00:00Z", from: "+5511999990000", text: "Olá" },
        { type: "message.status", id: "e2", routingKey: "sim-1", messageId: "m0", occurredAt: "2026-10-19T12:00:01Z", status: "delivered" },
        { type: "other", id: "e3", routingKey: "sim-1", occurredAt: "2026-10-19T12:00:02Z", providerType: "reaction" },
      ],
    });
    const result = provider.normalizeEvents(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toEqual([
      {
        kind: "message.inbound",
        providerEventId: "e1",
        routingKey: "sim-1",
        providerMessageId: "m1",
        occurredAt: new Date("2026-10-19T12:00:00Z"),
        senderPhoneE164: "+5511999990000",
        text: "Olá",
      },
      {
        kind: "message.status",
        providerEventId: "e2",
        routingKey: "sim-1",
        providerMessageId: "m0",
        occurredAt: new Date("2026-10-19T12:00:01Z"),
        status: "delivered",
        errorCode: null,
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
    expect(provider.normalizeEvents(body)).toEqual({ ok: false, reason: "invalid_payload" });
  });
});
