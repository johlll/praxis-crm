/**
 * @vitest-environment node
 *
 * B3.2a — a assinatura da YCloud é comparada em tempo constante
 * (`timingSafeEqual`), nunca com `===` ou `Buffer.equals`.
 *
 * Arquivo próprio porque o `vi.mock` de `node:crypto` vale para o arquivo
 * inteiro. Escrito ANTES do adaptador, contra a main 7b97297.
 */
import type * as NodeCrypto from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const spy = vi.hoisted(() => ({ calls: 0 }));

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof NodeCrypto>();
  return {
    ...original,
    default: original,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      spy.calls += 1;
      return original.timingSafeEqual(a, b);
    },
  };
});

import { body, bytes, FICT, inboundText, NOW_MS, signedHeaders } from "../support/ycloud-fixtures";

const RAW = bytes(body(inboundText));

describe("comparação em tempo constante", () => {
  beforeEach(() => {
    spy.calls = 0;
  });

  it("usa timingSafeEqual para aceitar e para recusar", async () => {
    const { YCloudWhatsAppProvider } = await import("@/server/whatsapp/provider/ycloud");
    const provider = new YCloudWhatsAppProvider();

    const ok = provider.verifyWebhook({ rawBody: RAW, headers: signedHeaders(RAW), secret: FICT.secret, nowMs: NOW_MS });
    expect(ok.ok).toBe(true);
    expect(spy.calls).toBeGreaterThan(0);

    spy.calls = 0;
    const bad = provider.verifyWebhook({
      rawBody: RAW,
      headers: signedHeaders(RAW, { secret: "outro-segredo-ficticio" }),
      secret: FICT.secret,
      nowMs: NOW_MS,
    });
    expect(bad).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(spy.calls).toBeGreaterThan(0);
  });
});
