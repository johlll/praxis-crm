import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A11 — observabilidade sanitizada da recusa genérica `invalid_submission`.
 *
 * O contrato público exige que TODA recusa desta família responda
 * exatamente igual (400, mesmo corpo — contrato §1). Sem log interno,
 * uma recusa legítima e uma anomalia real são indistinguíveis também por
 * dentro. Este arquivo comprova duas coisas por caminho: (1) o motivo
 * interno é classificado corretamente; (2) nenhum dado sensível aparece
 * na linha de log.
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

const { resetIngestConfigCache } = await import("@/server/ingest/config");
const { handleFormSubmission } = await import("@/server/ingest/handler");
const { sanitizeZodIssues } = await import("@/server/ingest/observability");

const SEGREDOS = [
  "maria@exemplo.test",
  "988887777",
  "rescisão",
  "203.0.113.7",
  "bypass-secreto",
  "token-turnstile-real",
  "cron-secret-de-teste-0000",
  "turnstile-de-teste",
  "token-de-teste",
];

const VALID = {
  sourceEventId: "11111111-2222-4333-8444-555555555555",
  contractVersion: 1,
  occurredAt: new Date().toISOString(),
  turnstileToken: "token-turnstile-real",
  contact: { name: "Maria Silva", type: "pf" as const, email: "maria@exemplo.test", phone: "(11) 98888-7777" },
  answers: { motivo: "rescisão" },
  attribution: { source: "google", channel: "formulario" },
};

function fakeSupabase(endpoint: Record<string, unknown> | null = {
  id: "endpoint-1",
  workspace_id: "ws-1",
  contract_version: 1,
  turnstile_action: "formulario",
  allowed_hostnames: ["exemplo.test"],
  answers_config: { fields: [{ key: "motivo", label: "Motivo", type: "text", required: false }] },
}) {
  return {
    rpc: (fn: string) => {
      if (fn === "resolve_form_endpoint") return Promise.resolve({ data: endpoint, error: null });
      if (fn === "ingest_form_event") {
        return Promise.resolve({
          data: { protocol: "proto-abc", created: true, webhook_event_id: "evt-1", outbox_id: "outbox-1" },
          error: null,
        });
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

function deps(overrides: Partial<Parameters<typeof handleFormSubmission>[2]> = {}) {
  return {
    supabase: fakeSupabase(),
    verifyTurnstile: alwaysOkTurnstile as never,
    rateLimit: alwaysOkRateLimit as never,
    publish: noopPublish as never,
    ...overrides,
  };
}

describe("sanitizeZodIssues", () => {
  it("mantém só code e path, nunca message nem input", () => {
    const issues = [
      { code: "invalid_type", path: ["contact", "email"], message: "e-mail forjado: maria@exemplo.test" },
    ];
    const sanitized = sanitizeZodIssues(issues as never);
    expect(sanitized).toEqual([{ code: "invalid_type", path: "contact.email" }]);
    expect(JSON.stringify(sanitized)).not.toContain("maria@exemplo.test");
  });
});

describe("observabilidade sanitizada de invalid_submission", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetIngestConfigCache();
    setConfigEnv();
    alwaysOkTurnstile.mockClear();
    alwaysOkRateLimit.mockClear();
    noopPublish.mockClear();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  function lastLog(): Record<string, unknown> {
    expect(warnSpy).toHaveBeenCalledTimes(1);
    return JSON.parse(warnSpy.mock.calls[0]![0] as string);
  }

  function expectNoSecretLeak() {
    const raw = warnSpy.mock.calls.map((call) => call[0]).join("\n");
    for (const segredo of SEGREDOS) {
      expect(raw).not.toContain(segredo);
    }
  }

  it("honeypot preenchido → reason honeypot_filled, sem vazar o valor do campo", async () => {
    const result = await handleFormSubmission("chave", request({ ...VALID, website: "http://spam-secreto.test" }), deps());
    expect(result).toEqual({ ok: false, failure: "invalid_submission", corsOrigin: null });
    const log = lastLog();
    expect(log.event).toBe("a11.ingest.invalid_submission");
    expect(log.reason).toBe("honeypot_filled");
    expect(log.form_endpoint_id).toBe("endpoint-1");
    expect(JSON.stringify(log)).not.toContain("spam-secreto.test");
    expectNoSecretLeak();
  });

  it("campo desconhecido (schema estrito) → reason schema_validation_failed, com code/path mas sem valores", async () => {
    const result = await handleFormSubmission("chave", request({ ...VALID, campoInesperado: "x" }), deps());
    expect(result).toEqual({ ok: false, failure: "invalid_submission", corsOrigin: null });
    const log = lastLog();
    expect(log.reason).toBe("schema_validation_failed");
    expect(Array.isArray(log.issues)).toBe(true);
    expect((log.issues as { code: string }[]).length).toBeGreaterThan(0);
    for (const issue of log.issues as Record<string, unknown>[]) {
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
    expectNoSecretLeak();
  });

  it("versão de contrato divergente → reason contract_version_mismatch, com os NÚMEROS (não segredo) esperado/recebido", async () => {
    const result = await handleFormSubmission("chave", request({ ...VALID, contractVersion: 99 }), deps());
    expect(result).toEqual({ ok: false, failure: "invalid_submission", corsOrigin: null });
    const log = lastLog();
    expect(log.reason).toBe("contract_version_mismatch");
    expect(log.expected).toBe(1);
    expect(log.received).toBe(99);
    expectNoSecretLeak();
  });

  it("campo não configurado em answers → reason answers_schema_validation_failed", async () => {
    const result = await handleFormSubmission(
      "chave",
      request({ ...VALID, answers: { campo_nao_configurado: "valor-secreto-de-resposta" } }),
      deps(),
    );
    expect(result).toEqual({ ok: false, failure: "invalid_submission", corsOrigin: null });
    const log = lastLog();
    expect(log.reason).toBe("answers_schema_validation_failed");
    expect(Array.isArray(log.issues)).toBe(true);
    expect(JSON.stringify(log)).not.toContain("valor-secreto-de-resposta");
    expectNoSecretLeak();
  });

  it("IP forjado sem cabeçalho confiável → reason client_ip_unresolved, nunca o IP", async () => {
    const forged = new Request("https://app.test/api/forms/chave", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID),
    });
    const result = await handleFormSubmission("chave", forged, deps());
    expect(result).toEqual({ ok: false, failure: "invalid_submission", corsOrigin: null });
    const log = lastLog();
    expect(log.reason).toBe("client_ip_unresolved");
    expect(log.header_reason).toBe("missing_trusted_header");
    expect(JSON.stringify(log)).not.toContain("9.9.9.9");
    expectNoSecretLeak();
  });

  it("corpo JSON malformado → reason json_parse_error", async () => {
    const malformed = request("{ isto nao é json");
    const result = await handleFormSubmission("chave", malformed, deps());
    expect(result).toEqual({ ok: false, failure: "invalid_submission", corsOrigin: null });
    const log = lastLog();
    expect(log.reason).toBe("json_parse_error");
    expectNoSecretLeak();
  });

  it("submissão válida não gera nenhum log de invalid_submission", async () => {
    const result = await handleFormSubmission("chave", request(VALID), deps());
    expect(result.ok).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("resposta pública continua exatamente genérica em todos os caminhos (contrato §1 preservado)", async () => {
    const casos = [
      request({ ...VALID, website: "spam" }),
      request({ ...VALID, campoInesperado: "x" }),
      request({ ...VALID, contractVersion: 99 }),
      request({ ...VALID, answers: { campo_nao_configurado: "x" } }),
    ];
    for (const req of casos) {
      const result = await handleFormSubmission("chave", req, deps());
      expect(result).toEqual({ ok: false, failure: "invalid_submission", corsOrigin: null });
    }
  });
});
