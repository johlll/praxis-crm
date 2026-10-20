/**
 * @vitest-environment node
 *
 * B3.1, revisão da PR #42 — ponto 3: identidade sem telefone.
 *
 * O contrato próprio do CRM representa o contato do WhatsApp por uma
 * identidade explícita: telefone, BSUID, ambos — nunca nenhum dos dois. O
 * contrato-base não pode nascer incompatível com a B3.2 (BSUID sem
 * telefone, docs/decisoes/b3-whatsapp-real.md §4). Nada aqui persiste
 * contato nem envia.
 *
 * Escritos ANTES da correção, contra o HEAD 3bdb181.
 */
import { describe, expect, it } from "vitest";

import { whatsappContactIdentity } from "@/server/whatsapp/provider/contract";
import {
  SIMULATED_SIGNATURE_HEADER,
  signSimulatedWebhook,
  SimulatedWhatsAppProvider,
} from "@/server/whatsapp/provider/simulated";

const SECRET = "segredo-simulado-de-teste-0002";
const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const PHONE = "+5511999990000";
const BSUID = "BR.1a2b3c4d5e6f";

const provider = new SimulatedWhatsAppProvider();

function normalize(payload: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const headers = new Headers({ [SIMULATED_SIGNATURE_HEADER]: signSimulatedWebhook(bytes, SECRET, NOW_S) });
  const verified = provider.verifyWebhook({ rawBody: bytes, headers, secret: SECRET, nowMs: NOW_MS });
  if (!verified.ok || !("verified" in verified)) throw new Error("assinatura deveria conferir");
  return provider.normalizeEvents(verified.verified);
}

function inbound(identity: Record<string, string>) {
  return {
    version: 1,
    events: [
      { type: "message.inbound", id: "e1", routingKey: "sim-1", messageId: "m1", occurredAt: "2026-10-20T12:00:00Z", text: "Olá", ...identity },
    ],
  };
}

describe("identidade explícita do contato", () => {
  it("só telefone", () => {
    expect(whatsappContactIdentity({ phoneE164: PHONE })).toEqual({ kind: "phone", phoneE164: PHONE, bsuid: null });
  });

  it("só BSUID", () => {
    expect(whatsappContactIdentity({ bsuid: BSUID })).toEqual({ kind: "bsuid", phoneE164: null, bsuid: BSUID });
  });

  it("telefone e BSUID", () => {
    expect(whatsappContactIdentity({ phoneE164: PHONE, bsuid: BSUID })).toEqual({
      kind: "phone_and_bsuid",
      phoneE164: PHONE,
      bsuid: BSUID,
    });
  });

  it.each([
    ["nenhum dos dois", {}],
    ["os dois nulos", { phoneE164: null, bsuid: null }],
    ["strings vazias", { phoneE164: "", bsuid: "" }],
    ["telefone fora de E.164 e nada mais", { phoneE164: "11999990000" }],
    ["BSUID com caractere inválido", { bsuid: "BR 123" }],
    ["telefone válido com BSUID inválido (falha fechada)", { phoneE164: PHONE, bsuid: "BR 123" }],
    ["BSUID válido com telefone inválido (falha fechada)", { phoneE164: "123", bsuid: BSUID }],
  ])("%s → sem identidade", (_nome, input) => {
    expect(whatsappContactIdentity(input)).toBeNull();
  });
});

describe("simulador produz a identidade no evento de entrada", () => {
  it("com telefone (caso atual)", () => {
    const result = normalize(inbound({ from: PHONE }));
    expect(result.ok && result.events[0]).toMatchObject({
      kind: "message.inbound",
      sender: { kind: "phone", phoneE164: PHONE, bsuid: null },
    });
  });

  it("somente com BSUID, sem telefone", () => {
    const result = normalize(inbound({ fromBsuid: BSUID }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.events[0]).toMatchObject({
      kind: "message.inbound",
      sender: { kind: "bsuid", phoneE164: null, bsuid: BSUID },
    });
    expect(JSON.stringify(result)).not.toContain("senderPhoneE164");
  });

  it("com os dois", () => {
    const result = normalize(inbound({ from: PHONE, fromBsuid: BSUID }));
    expect(result.ok && result.events[0]).toMatchObject({
      sender: { kind: "phone_and_bsuid", phoneE164: PHONE, bsuid: BSUID },
    });
  });

  it("sem nenhum dos dois → payload inválido", () => {
    expect(normalize(inbound({}))).toEqual({ ok: false, reason: "invalid_payload" });
  });
});

describe("saída declara destinatário pela mesma identidade (continua unsupported)", () => {
  it("envio para destinatário só com BSUID responde unsupported, não erro de tipo", async () => {
    const recipient = whatsappContactIdentity({ bsuid: BSUID });
    expect(recipient).not.toBeNull();
    await expect(
      provider.sendText({ routingKey: "sim-1", recipient: recipient!, text: "oi", correlationId: "c" }),
    ).resolves.toEqual({ ok: false, reason: "unsupported", capability: "sendText" });
  });
});
