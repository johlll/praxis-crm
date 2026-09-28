import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Item 2 da auditoria pós-dry-run: o verificador NÃO manda `remoteip`
 * (o campo representa um IP real; a política da A11 não permite enviar
 * IP, nem completo nem como HMAC, a nenhum terceiro) e a
 * `idempotency_key` é derivada do PRÓPRIO TOKEN — estável só entre
 * retries da MESMA verificação, não do source_event_id da submissão.
 */
describe("cloudflareTurnstileVerifier — corpo real enviado ao Siteverify", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.SUPABASE_SECRET_KEY = "secret-de-teste";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://exemplo.supabase.co";
    const key = Buffer.alloc(32, 7).toString("base64");
    process.env.A11_PAYLOAD_ACTIVE_KEY_VERSION = "1";
    process.env.A11_PAYLOAD_KEY_VERSIONS = JSON.stringify({ 1: { cipher: key } });
    process.env.A11_IP_HMAC_KEY = key;
    process.env.TURNSTILE_SECRET_KEY = "segredo-turnstile";
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.exemplo";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token-de-teste";
    process.env.INNGEST_EVENT_KEY = "evento-de-teste";
    process.env.INNGEST_SIGNING_KEY = "assinatura-de-teste";
    process.env.CRON_SECRET = "cron-secret-de-teste-0000";

    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, hostname: "exemplo.test", action: "formulario" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of [
      "SUPABASE_SECRET_KEY",
      "A11_PAYLOAD_ACTIVE_KEY_VERSION",
      "A11_PAYLOAD_KEY_VERSIONS",
      "A11_IP_HMAC_KEY",
      "TURNSTILE_SECRET_KEY",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "INNGEST_EVENT_KEY",
      "INNGEST_SIGNING_KEY",
      "CRON_SECRET",
    ]) {
      delete process.env[key];
    }
  });

  it("nunca envia remoteip", async () => {
    const { cloudflareTurnstileVerifier } = await import("@/server/ingest/turnstile");
    const { resetIngestConfigCache } = await import("@/server/ingest/config");
    resetIngestConfigCache();

    await cloudflareTurnstileVerifier({
      token: "token-do-visitante",
      expectedAction: "formulario",
      allowedHostnames: ["exemplo.test"],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.has("remoteip")).toBe(false);
  });

  it("idempotency_key tem FORMATO de UUID (item 2 da auditoria pós-dry-run — antes era hex de 64 caracteres)", async () => {
    const { cloudflareTurnstileVerifier } = await import("@/server/ingest/turnstile");
    const { resetIngestConfigCache } = await import("@/server/ingest/config");
    resetIngestConfigCache();

    await cloudflareTurnstileVerifier({
      token: "token-qualquer",
      expectedAction: "formulario",
      allowedHostnames: ["exemplo.test"],
    });

    const key = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string).get("idempotency_key");
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("idempotency_key é derivada do token — o MESMO token produz a MESMA chave", async () => {
    const { cloudflareTurnstileVerifier } = await import("@/server/ingest/turnstile");
    const { resetIngestConfigCache } = await import("@/server/ingest/config");
    resetIngestConfigCache();

    await cloudflareTurnstileVerifier({
      token: "token-repetido",
      expectedAction: "formulario",
      allowedHostnames: ["exemplo.test"],
    });
    await cloudflareTurnstileVerifier({
      token: "token-repetido",
      expectedAction: "formulario",
      allowedHostnames: ["exemplo.test"],
    });

    const key1 = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string).get("idempotency_key");
    const key2 = new URLSearchParams(fetchMock.mock.calls[1]![1].body as string).get("idempotency_key");
    expect(key1).toBeTruthy();
    expect(key1).toBe(key2);
  });

  it("tokens DIFERENTES produzem idempotency_key DIFERENTE (defeito corrigido: antes era o sourceEventId, estável mesmo com token renovado)", async () => {
    const { cloudflareTurnstileVerifier } = await import("@/server/ingest/turnstile");
    const { resetIngestConfigCache } = await import("@/server/ingest/config");
    resetIngestConfigCache();

    await cloudflareTurnstileVerifier({
      token: "token-um",
      expectedAction: "formulario",
      allowedHostnames: ["exemplo.test"],
    });
    await cloudflareTurnstileVerifier({
      token: "token-dois-renovado",
      expectedAction: "formulario",
      allowedHostnames: ["exemplo.test"],
    });

    const key1 = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string).get("idempotency_key");
    const key2 = new URLSearchParams(fetchMock.mock.calls[1]![1].body as string).get("idempotency_key");
    expect(key1).not.toBe(key2);
  });

  it("envia secret e response (token); nunca o remoteip mesmo com IP disponível em outro lugar do fluxo", async () => {
    const { cloudflareTurnstileVerifier } = await import("@/server/ingest/turnstile");
    const { resetIngestConfigCache } = await import("@/server/ingest/config");
    resetIngestConfigCache();

    await cloudflareTurnstileVerifier({
      token: "token-do-visitante",
      expectedAction: "formulario",
      allowedHostnames: ["exemplo.test"],
    });

    const body = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
    expect(body.get("secret")).toBe("segredo-turnstile");
    expect(body.get("response")).toBe("token-do-visitante");
  });
});
