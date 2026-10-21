/**
 * @vitest-environment node
 *
 * B3.2a, revisão da PR #48 — ponto 3: custo limitado pelo cabeçalho
 * `YCloud-Signature` antes de qualquer HMAC.
 *
 * - tamanho máximo do cabeçalho: 1024 caracteres;
 * - no máximo 8 assinaturas `s` (rotação de segredo);
 * - acima disso: recusa sem calcular HMAC nem comparar nada;
 * - continua em tempo constante e aceitando mais de uma assinatura.
 *
 * Arquivo próprio porque o `vi.mock` de `node:crypto` vale para o arquivo
 * inteiro. Escritos ANTES da correção, contra o HEAD a8db0ef.
 */
import type * as NodeCrypto from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const counters = vi.hoisted(() => ({ hmac: 0, compare: 0 }));

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof NodeCrypto>();
  const createHmac = (...args: Parameters<typeof original.createHmac>) => {
    counters.hmac += 1;
    return original.createHmac(...args);
  };
  const timingSafeEqual = (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
    counters.compare += 1;
    return original.timingSafeEqual(a, b);
  };
  return { ...original, default: { ...original, createHmac, timingSafeEqual }, createHmac, timingSafeEqual };
});

import { body, bytes, FICT, inboundText, NOW_MS, NOW_S, referenceSignature } from "../support/ycloud-fixtures";

const RAW = bytes(body(inboundText));
const WRONG = "0".repeat(64);

async function verify(header: string) {
  const { YCloudWhatsAppProvider } = await import("@/server/whatsapp/provider/ycloud");
  const provider = new YCloudWhatsAppProvider();
  counters.hmac = 0;
  counters.compare = 0;
  return provider.verifyWebhook({ rawBody: RAW, headers: new Headers({ "YCloud-Signature": header }), secret: FICT.secret, nowMs: NOW_MS });
}

function header(signatures: string[], padTo?: number) {
  let h = `t=${NOW_S},${signatures.map((s) => `s=${s}`).join(",")}`;
  if (padTo !== undefined) {
    const filler = `,x=`;
    h += filler + "a".repeat(padTo - h.length - filler.length);
  }
  return h;
}

describe("limites do cabeçalho de assinatura", () => {
  beforeEach(() => {
    counters.hmac = 0;
    counters.compare = 0;
  });

  it("exporta os limites", async () => {
    const mod = await import("@/server/whatsapp/provider/ycloud");
    expect(mod.YCLOUD_SIGNATURE_HEADER_MAX_LENGTH).toBe(1024);
    expect(mod.YCLOUD_SIGNATURE_MAX_SIGNATURES).toBe(8);
  });

  it("8 assinaturas (limite exato): aceita e compara exatamente 8 vezes, com 1 HMAC", async () => {
    const result = await verify(header([...Array(7).fill(WRONG), referenceSignature(RAW)]));
    expect(result.ok).toBe(true);
    expect(counters.compare).toBe(8);
    expect(counters.hmac).toBe(1);
  });

  it("9 assinaturas: recusa sem HMAC nem comparação, mesmo com a válida na lista", async () => {
    const result = await verify(header([referenceSignature(RAW), ...Array(8).fill(WRONG)]));
    expect(result).toEqual({ ok: false, reason: "malformed_signature" });
    expect(counters.hmac).toBe(0);
    expect(counters.compare).toBe(0);
  });

  it("cabeçalho com exatamente 1024 caracteres é aceito", async () => {
    const h = header([referenceSignature(RAW)], 1024);
    expect(h).toHaveLength(1024);
    expect((await verify(h)).ok).toBe(true);
  });

  it("cabeçalho com 1025 caracteres é recusado antes de qualquer HMAC", async () => {
    const h = header([referenceSignature(RAW)], 1025);
    expect(h).toHaveLength(1025);
    expect(await verify(h)).toEqual({ ok: false, reason: "malformed_signature" });
    expect(counters.hmac).toBe(0);
    expect(counters.compare).toBe(0);
  });

  it("cabeçalho enorme (100 mil assinaturas) é recusado sem percorrer a lista", async () => {
    const h = header(Array(100_000).fill(WRONG));
    const started = performance.now();
    expect(await verify(h)).toEqual({ ok: false, reason: "malformed_signature" });
    expect(counters.hmac).toBe(0);
    expect(counters.compare).toBe(0);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("rotação: duas assinaturas válidas (segredo antigo e novo) — aceita, comparando as duas", async () => {
    const result = await verify(header([referenceSignature(RAW, "segredo-antigo-ficticio"), referenceSignature(RAW)]));
    expect(result.ok).toBe(true);
    expect(counters.compare).toBe(2);
  });
});
