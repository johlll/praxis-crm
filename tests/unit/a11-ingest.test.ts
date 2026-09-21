import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A11 — testes da borda de ingestão.
 *
 * Funcionalidade nova: não há "defeito anterior" a reproduzir. Cada
 * asserção descreve a garantia que o contrato promete.
 *
 * Os adaptadores externos (Turnstile, rate limit, publicação) são
 * INJETADOS — nenhuma chamada de rede acontece aqui. É exatamente a
 * única forma autorizada de substituir uma proteção: em teste, de forma
 * explícita, nunca por variável ausente em produção.
 */

const KEY = Buffer.alloc(32, 7).toString("base64");

function setConfigEnv() {
  process.env.SUPABASE_SECRET_KEY = "secret-de-teste";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://exemplo.supabase.co";
  process.env.A11_PAYLOAD_ACTIVE_KEY_VERSION = "1";
  process.env.A11_PAYLOAD_KEY_VERSIONS = JSON.stringify({ 1: { cipher: KEY } });
  process.env.A11_IP_HMAC_KEY = KEY;
  process.env.TURNSTILE_SECRET_KEY = "turnstile-de-teste";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.exemplo";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token-de-teste";
  process.env.INNGEST_EVENT_KEY = "evento-de-teste";
  process.env.INNGEST_SIGNING_KEY = "assinatura-de-teste";
  process.env.CRON_SECRET = "cron-secret-de-teste-0000";
}

function clearConfigEnv() {
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
}

const { canonicalJson, contentHash, normalizePhone } = await import("@/server/ingest/canonical");
const { businessContent, sanitizedDiagnostics, submissionSchema } = await import(
  "@/server/ingest/submission"
);
const { clientIpFromHeaders } = await import("@/server/ingest/client-ip");
const { encryptPayload, decryptPayload } = await import("@/server/ingest/payload-crypto");
const { resetIngestConfigCache } = await import("@/server/ingest/config");
const { handleFormSubmission } = await import("@/server/ingest/handler");

const VALID = {
  sourceEventId: "11111111-2222-4333-8444-555555555555",
  contractVersion: 1,
  occurredAt: new Date().toISOString(),
  turnstileToken: "token-1",
  contact: { name: "  Maria   Silva ", type: "pf" as const, email: "MARIA@Exemplo.Test", phone: "(11) 98888-7777" },
  answers: { motivo: "rescisão" },
  attribution: { source: "google", channel: "formulario" },
};

describe("canonicalização e hash de conteúdo", () => {
  it("retry da mesma submissão com token diferente produz o MESMO hash", () => {
    const a = submissionSchema.parse({ ...VALID, turnstileToken: "token-1" });
    const b = submissionSchema.parse({ ...VALID, turnstileToken: "token-2-renovado" });
    expect(contentHash(businessContent(a)).toString("hex")).toBe(
      contentHash(businessContent(b)).toString("hex"),
    );
  });

  it("campo vazio e campo ausente são o mesmo conteúdo", () => {
    expect(canonicalJson({ a: "x", b: "" })).toBe(canonicalJson({ a: "x" }));
    expect(canonicalJson({ a: "x", b: null })).toBe(canonicalJson({ a: "x" }));
  });

  it("ordem das chaves não muda o hash, mas ordem de array muda", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
  });

  it("conteúdo materialmente diferente muda o hash", () => {
    const a = submissionSchema.parse(VALID);
    const b = submissionSchema.parse({ ...VALID, contact: { ...VALID.contact, name: "Outra Pessoa" } });
    expect(contentHash(businessContent(a))).not.toEqual(contentHash(businessContent(b)));
  });

  it("telefone digitado de formas diferentes é o mesmo conteúdo", () => {
    expect(normalizePhone("(11) 98888-7777")).toBe(normalizePhone("11988887777"));
  });
});

describe("diagnóstico sanitizado", () => {
  it("não carrega e-mail, telefone nem resposta livre", () => {
    const submission = submissionSchema.parse(VALID);
    const serialized = JSON.stringify(sanitizedDiagnostics(submission));
    expect(serialized).not.toContain("maria@exemplo.test");
    expect(serialized).not.toContain("988887777");
    expect(serialized).not.toContain("rescisão");
    // O que PODE aparecer: domínio, DDD e contagens.
    expect(serialized).toContain("exemplo.test");
    expect(serialized).toContain('"phone_ddd":"11"');
  });
});

describe("cifra do payload", () => {
  beforeEach(() => {
    resetIngestConfigCache();
    setConfigEnv();
  });

  it("decifra o que cifrou, com a versão da linha", () => {
    const encrypted = encryptPayload('{"a":1}');
    expect(encrypted.keyVersion).toBe("1");
    expect(decryptPayload(encrypted)).toBe('{"a":1}');
  });

  it("chave errada não devolve texto parcial: lança", () => {
    const encrypted = encryptPayload('{"a":1}');
    process.env.A11_PAYLOAD_KEY_VERSIONS = JSON.stringify({
      1: { cipher: Buffer.alloc(32, 9).toString("base64") },
    });
    resetIngestConfigCache();
    expect(() => decryptPayload(encrypted)).toThrow();
  });

  it("versão desconhecida lança em vez de improvisar", () => {
    const encrypted = encryptPayload('{"a":1}');
    expect(() => decryptPayload({ ...encrypted, keyVersion: "404" })).toThrow();
  });
});

describe("origem do IP", () => {
  it("usa o cabeçalho da borda da Vercel", () => {
    const headers = new Headers({ "x-vercel-forwarded-for": "203.0.113.7" });
    expect(clientIpFromHeaders(headers, { trustForwardedFor: false })).toEqual({
      ok: true,
      ip: "203.0.113.7",
    });
  });

  it("IGNORA x-forwarded-for forjado quando não é confiável", () => {
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4" });
    expect(clientIpFromHeaders(headers, { trustForwardedFor: false })).toEqual({
      ok: false,
      reason: "missing_trusted_header",
    });
  });

  it("o cabeçalho da borda vence o forjado quando os dois chegam", () => {
    const headers = new Headers({
      "x-vercel-forwarded-for": "203.0.113.7",
      "x-forwarded-for": "1.2.3.4",
    });
    expect(clientIpFromHeaders(headers, { trustForwardedFor: true })).toEqual({
      ok: true,
      ip: "203.0.113.7",
    });
  });
});

// ---------------------------------------------------------------------
// Borda HTTP, com adaptadores injetados
// ---------------------------------------------------------------------

type RpcCall = { fn: string; args: Record<string, unknown> };

function fakeSupabase(options: {
  endpoint?: Record<string, unknown> | null;
  ingest?: { data?: unknown; error?: { message: string } | null };
  calls?: RpcCall[];
}) {
  const endpoint =
    options.endpoint === undefined
      ? {
          id: "endpoint-1",
          workspace_id: "ws-1",
          contract_version: 1,
          turnstile_action: "formulario",
          allowed_hostnames: ["exemplo.test"],
        }
      : options.endpoint;

  return {
    rpc: (fn: string, args: Record<string, unknown>) => {
      options.calls?.push({ fn, args });
      if (fn === "resolve_form_endpoint") {
        return Promise.resolve({ data: endpoint, error: null });
      }
      if (fn === "ingest_form_event") {
        return Promise.resolve(
          options.ingest ?? {
            data: { protocol: "proto-abc", created: true, webhook_event_id: "evt-1" },
            error: null,
          },
        );
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as never;
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.test/api/forms/chave", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vercel-forwarded-for": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const alwaysOkTurnstile = vi.fn(async () => ({ ok: true }) as const);
const alwaysOkRateLimit = vi.fn(async () => ({ ok: true }) as const);
const noopPublish = vi.fn(async () => {});

describe("borda pública de ingestão", () => {
  beforeEach(() => {
    resetIngestConfigCache();
    setConfigEnv();
    alwaysOkTurnstile.mockClear();
    alwaysOkRateLimit.mockClear();
    noopPublish.mockClear();
  });

  const deps = (overrides: Partial<Parameters<typeof handleFormSubmission>[2]> = {}) => ({
    supabase: fakeSupabase({}),
    verifyTurnstile: alwaysOkTurnstile as never,
    rateLimit: alwaysOkRateLimit as never,
    publish: noopPublish as never,
    ...overrides,
  });

  it("aceita uma submissão válida e devolve só o protocolo opaco", async () => {
    const result = await handleFormSubmission("chave", request(VALID), deps());
    expect(result).toEqual({ ok: true, protocol: "proto-abc" });
    // Nada de id interno, contato, lead ou oportunidade na resposta.
    expect(JSON.stringify(result)).not.toContain("evt-1");
  });

  it("repetição legítima devolve o MESMO formato de aceitação", async () => {
    const repeated = deps({
      supabase: fakeSupabase({
        ingest: { data: { protocol: "proto-abc", created: false, webhook_event_id: "evt-1" }, error: null },
      }),
    });
    const result = await handleFormSubmission("chave", request(VALID), repeated);
    // Idêntico ao caso "evento novo": sem 200, sem campo a mais.
    expect(result).toEqual({ ok: true, protocol: "proto-abc" });
    expect(noopPublish).not.toHaveBeenCalled();
  });

  it("mesma chave com conteúdo diferente vira 409", async () => {
    const conflicting = deps({
      supabase: fakeSupabase({
        ingest: { data: null, error: { message: "idempotency_payload_conflict" } },
      }),
    });
    const result = await handleFormSubmission("chave", request(VALID), conflicting);
    expect(result).toEqual({ ok: false, failure: "idempotency_payload_conflict" });
  });

  it("endpoint desconhecido e desativado são indistinguíveis", async () => {
    const unknown = deps({ supabase: fakeSupabase({ endpoint: null }) });
    const result = await handleFormSubmission("chave", request(VALID), unknown);
    expect(result).toEqual({ ok: false, failure: "form_endpoint_unavailable" });
  });

  it("honeypot preenchido é recusado sem gravar nada", async () => {
    const calls: RpcCall[] = [];
    const result = await handleFormSubmission(
      "chave",
      request({ ...VALID, website: "http://spam" }),
      deps({ supabase: fakeSupabase({ calls }) }),
    );
    expect(result).toEqual({ ok: false, failure: "invalid_submission" });
    expect(calls.some((call) => call.fn === "ingest_form_event")).toBe(false);
  });

  it("campo desconhecido é recusado (schema estrito)", async () => {
    const result = await handleFormSubmission(
      "chave",
      request({ ...VALID, campoInesperado: "x" }),
      deps(),
    );
    expect(result).toEqual({ ok: false, failure: "invalid_submission" });
  });

  it("corpo acima do limite é recusado antes de desserializar", async () => {
    const huge = JSON.stringify({ ...VALID, answers: { texto: "a".repeat(40_000) } });
    const result = await handleFormSubmission("chave", request(huge), deps());
    expect(result).toEqual({ ok: false, failure: "payload_too_large" });
  });

  it("rate limit estourado recusa antes do Turnstile", async () => {
    const limited = vi.fn(async () => ({ ok: false, scope: "ip" }) as const);
    const result = await handleFormSubmission("chave", request(VALID), deps({ rateLimit: limited as never }));
    expect(result).toEqual({ ok: false, failure: "rate_limited" });
    expect(alwaysOkTurnstile).not.toHaveBeenCalled();
  });

  it("hostname fora da lista do endpoint é recusado", async () => {
    const wrongHost = vi.fn(async () => ({ ok: false, reason: "hostname_mismatch" }) as const);
    const result = await handleFormSubmission("chave", request(VALID), deps({ verifyTurnstile: wrongHost as never }));
    expect(result).toEqual({ ok: false, failure: "captcha_failed" });
  });

  it("action diferente da esperada é recusada", async () => {
    const wrongAction = vi.fn(async () => ({ ok: false, reason: "action_mismatch" }) as const);
    const result = await handleFormSubmission("chave", request(VALID), deps({ verifyTurnstile: wrongAction as never }));
    expect(result).toEqual({ ok: false, failure: "captcha_failed" });
  });

  it("o Turnstile recebe a action e os hostnames DO ENDPOINT", async () => {
    await handleFormSubmission("chave", request(VALID), deps());
    expect(alwaysOkTurnstile).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAction: "formulario", allowedHostnames: ["exemplo.test"] }),
    );
  });

  it("o rate limit recebe HMAC do IP, nunca o IP", async () => {
    await handleFormSubmission("chave", request(VALID), deps());
    const call = (alwaysOkRateLimit.mock.calls as unknown as [{ ipHmacHex: string }][])[0]![0];
    expect(call.ipHmacHex).toMatch(/^[0-9a-f]{64}$/);
    expect(call.ipHmacHex).not.toContain("203.0.113.7");
  });

  it("IP forjado no corpo é ignorado; sem cabeçalho confiável, recusa", async () => {
    const forged = new Request("https://app.test/api/forms/chave", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID),
    });
    const result = await handleFormSubmission("chave", forged, deps());
    expect(result).toEqual({ ok: false, failure: "invalid_submission" });
  });

  it("versão de contrato divergente é recusada", async () => {
    const result = await handleFormSubmission("chave", request({ ...VALID, contractVersion: 99 }), deps());
    expect(result).toEqual({ ok: false, failure: "invalid_submission" });
  });

  it("falha de publicação NÃO muda a resposta: o evento já está gravado", async () => {
    const failing = vi.fn(async () => {
      throw new Error("inngest fora do ar");
    });
    const result = await handleFormSubmission("chave", request(VALID), deps({ publish: failing as never }));
    expect(result).toEqual({ ok: true, protocol: "proto-abc" });
  });

  it("sem configuração obrigatória, falha FECHADA e sanitizada", async () => {
    clearConfigEnv();
    resetIngestConfigCache();
    const calls: RpcCall[] = [];
    const result = await handleFormSubmission(
      "chave",
      request(VALID),
      deps({ supabase: fakeSupabase({ calls }) }),
    );
    expect(result).toEqual({ ok: false, failure: "service_unavailable" });
    // Nada foi gravado e nenhuma proteção foi pulada.
    expect(calls).toHaveLength(0);
    expect(alwaysOkTurnstile).not.toHaveBeenCalled();
    expect(alwaysOkRateLimit).not.toHaveBeenCalled();
  });
});

describe("telefone em E.164", () => {
  it("assume Brasil só quando o formato é inequívoco", async () => {
    const { toE164BR } = await import("@/server/ingest/canonical");
    expect(toE164BR("(11) 98888-7777")).toBe("+5511988887777");
    expect(toE164BR("1133334444")).toBe("+551133334444");
    expect(toE164BR("5511988887777")).toBe("+5511988887777");
    expect(toE164BR("+351912345678")).toBe("+351912345678");
  });

  it("número ambíguo vira null em vez de um palpite de país", async () => {
    const { toE164BR } = await import("@/server/ingest/canonical");
    // Antes da correção isto virava "+123456" (código de país 1).
    expect(toE164BR("123456")).toBeNull();
    expect(toE164BR("0")).toBeNull();
    expect(toE164BR("019988887777")).toBeNull();
  });
});
