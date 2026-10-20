/**
 * @vitest-environment node
 *
 * B3.1, revisão da PR #42 — ponto 4: corpo realmente bruto do webhook.
 *
 * Três etapas separadas:
 *  1. leitura dos BYTES exatos da requisição;
 *  2. verificação da assinatura sobre esses bytes;
 *  3. decodificação (UTF-8 estrita) e normalização — só de um corpo que a
 *     etapa 2 aprovou.
 *
 * Escritos ANTES da correção, contra o HEAD 3bdb181.
 */
import { describe, expect, it, vi } from "vitest";

import {
  SIMULATED_SIGNATURE_HEADER,
  signSimulatedWebhook,
  SimulatedWhatsAppProvider,
} from "@/server/whatsapp/provider/simulated";

const SECRET = "segredo-simulado-de-teste-0003";
const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

const loadWebhook = () => import("@/server/whatsapp/webhook");

const provider = new SimulatedWhatsAppProvider();
const encoder = new TextEncoder();

function payload(text: string, newline = "\n") {
  return (
    `{"version":1,${newline}"events":[{"type":"message.inbound","id":"e1","routingKey":"sim-1",` +
    `"messageId":"m1","occurredAt":"2026-10-20T12:00:00Z","from":"+5511999990000","text":${JSON.stringify(text)}}]}`
  );
}

function headersFor(bytes: Uint8Array) {
  return new Headers({ [SIMULATED_SIGNATURE_HEADER]: signSimulatedWebhook(bytes, SECRET, NOW_S) });
}

function verify(bytes: Uint8Array, headers: Headers) {
  return provider.verifyWebhook({ rawBody: bytes, headers, secret: SECRET, nowMs: NOW_MS });
}

const MULTIBYTE = "Olá, ação — 東京 🚀";

describe("1. leitura dos bytes exatos", () => {
  it("preserva byte a byte: BOM, CRLF, multibyte e byte inválido em UTF-8", async () => {
    const { readWhatsAppWebhookBody } = await loadWebhook();
    const original = new Uint8Array([
      0xef, 0xbb, 0xbf, // BOM
      ...encoder.encode('{"a":"ção 🚀"}'),
      0x0d, 0x0a, // CRLF
      0xff, // inválido em UTF-8
      0x0a,
    ]);
    const request = new Request("https://exemplo.invalid/webhook", { method: "POST", body: original });

    const result = await readWhatsAppWebhookBody(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.bytes)).toEqual(Array.from(original));
  });

  it("corpo acima do limite é recusado sem ser processado", async () => {
    const { readWhatsAppWebhookBody } = await loadWebhook();
    const request = new Request("https://exemplo.invalid/webhook", { method: "POST", body: new Uint8Array(2048) });
    await expect(readWhatsAppWebhookBody(request, { maxBytes: 1024 })).resolves.toEqual({ ok: false, reason: "payload_too_large" });
  });

  it("Content-Length acima do limite é recusado antes de ler", async () => {
    const { readWhatsAppWebhookBody } = await loadWebhook();
    const request = new Request("https://exemplo.invalid/webhook", {
      method: "POST",
      body: "x",
      headers: { "content-length": "999999" },
    });
    await expect(readWhatsAppWebhookBody(request, { maxBytes: 1024 })).resolves.toEqual({ ok: false, reason: "payload_too_large" });
  });
});

describe("2. assinatura conferida sobre os bytes", () => {
  it("corpo como string (já decodificado) não é aceito pelo contrato", () => {
    const text = payload(MULTIBYTE);
    const headers = headersFor(encoder.encode(text));
    const result = provider.verifyWebhook({
      // @ts-expect-error — o contrato só aceita bytes.
      rawBody: text,
      headers,
      secret: SECRET,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_body" });
  });

  it("UTF-8 multibyte assinado sobre os bytes confere", () => {
    const bytes = encoder.encode(payload(MULTIBYTE));
    const result = verify(bytes, headersFor(bytes));
    expect(result.ok).toBe(true);
  });

  it("alterar um único byte (dentro de um caractere multibyte) não confere", () => {
    const bytes = encoder.encode(payload(MULTIBYTE));
    const headers = headersFor(bytes);
    const index = bytes.indexOf(0xc3); // primeiro byte de "á"
    expect(index).toBeGreaterThan(0);
    const altered = bytes.slice();
    altered[index + 1] = altered[index + 1]! ^ 0x01;
    expect(verify(altered, headers)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("assinado com LF, recebido com CRLF (e vice-versa): não confere", () => {
    const lf = encoder.encode(payload("x", "\n"));
    const crlf = encoder.encode(payload("x", "\r\n"));
    expect(verify(crlf, headersFor(lf))).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(verify(lf, headersFor(crlf))).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("NFC × NFD (mesmo texto visível, bytes diferentes): não confere", () => {
    const nfc = encoder.encode(payload("ação".normalize("NFC")));
    const nfd = encoder.encode(payload("ação".normalize("NFD")));
    expect(Array.from(nfc)).not.toEqual(Array.from(nfd));
    expect(verify(nfd, headersFor(nfc))).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("BOM: a assinatura vale para os bytes com BOM, não para o texto decodificado sem ele", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(payload("x"))]);
    const headers = headersFor(withBom);
    expect(verify(withBom, headers).ok).toBe(true);
    // O que um TextDecoder padrão faria: remove o BOM ao decodificar.
    const decodedAndReencoded = encoder.encode(new TextDecoder().decode(withBom));
    expect(decodedAndReencoded.length).toBe(withBom.length - 3);
    expect(verify(decodedAndReencoded, headers)).toEqual({ ok: false, reason: "signature_mismatch" });
  });
});

describe("3. decodificação e normalização só depois da assinatura", () => {
  it("bytes não verificados não são normalizados", () => {
    const bytes = encoder.encode(payload("x"));
    // @ts-expect-error — normalizar exige o corpo devolvido pela verificação.
    expect(provider.normalizeEvents(bytes)).toEqual({ ok: false, reason: "unverified_body" });
    // @ts-expect-error — idem para texto.
    expect(provider.normalizeEvents(payload("x"))).toEqual({ ok: false, reason: "unverified_body" });
  });

  it("multibyte verificado é decodificado sem perda", () => {
    const bytes = encoder.encode(payload(MULTIBYTE));
    const verified = verify(bytes, headersFor(bytes));
    if (!verified.ok || !("verified" in verified)) throw new Error("deveria conferir");
    const result = provider.normalizeEvents(verified.verified);
    expect(result.ok && result.events[0]).toMatchObject({ kind: "message.inbound", text: MULTIBYTE });
  });

  it("o corpo verificado é uma cópia: mexer no buffer original depois não muda o que se normaliza", () => {
    const bytes = encoder.encode(payload("original"));
    const verified = verify(bytes, headersFor(bytes));
    if (!verified.ok || !("verified" in verified)) throw new Error("deveria conferir");
    const at = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf("original");
    expect(at).toBeGreaterThan(0);
    bytes.set(encoder.encode("alterado"), at);
    const result = provider.normalizeEvents(verified.verified);
    expect(result.ok && result.events[0]).toMatchObject({ text: "original" });
  });

  it("UTF-8 inválido com assinatura válida: confere, mas a normalização recusa", () => {
    // `..."text":"xÿ"}]}` — um decodificador tolerante trocaria o byte por U+FFFD e aceitaria.
    const bytes = new Uint8Array([...encoder.encode(payload("x")).slice(0, -4), 0xff, 0x22, 0x7d, 0x5d, 0x7d]);
    const verified = verify(bytes, headersFor(bytes));
    expect(verified.ok).toBe(true);
    if (!verified.ok || !("verified" in verified)) throw new Error("deveria conferir");
    expect(provider.normalizeEvents(verified.verified)).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("BOM verificado: a normalização estrita recusa (nenhum BOM é removido em silêncio)", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(payload("x"))]);
    const verified = verify(withBom, headersFor(withBom));
    if (!verified.ok || !("verified" in verified)) throw new Error("deveria conferir");
    expect(provider.normalizeEvents(verified.verified)).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("pipeline: assinatura recusada → normalização nem é chamada", async () => {
    const { verifyAndNormalizeWhatsAppWebhook } = await loadWebhook();
    const spy = vi.spyOn(provider, "normalizeEvents");
    const bytes = encoder.encode(payload("x"));
    const headers = headersFor(encoder.encode(payload("y")));

    const result = verifyAndNormalizeWhatsAppWebhook(provider, { rawBody: bytes, headers, secret: SECRET, nowMs: NOW_MS });

    expect(result).toEqual({ ok: false, stage: "signature", reason: "signature_mismatch" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("pipeline: assinatura válida → eventos normalizados", async () => {
    const { verifyAndNormalizeWhatsAppWebhook } = await loadWebhook();
    const bytes = encoder.encode(payload(MULTIBYTE));
    const result = verifyAndNormalizeWhatsAppWebhook(provider, {
      rawBody: bytes,
      headers: headersFor(bytes),
      secret: SECRET,
      nowMs: NOW_MS,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.events[0]).toMatchObject({ text: MULTIBYTE });
  });
});
