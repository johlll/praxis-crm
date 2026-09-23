import { beforeEach, describe, expect, it } from "vitest";

/**
 * Worker da A11 — revalidação do `answers_config_snapshot` DEPOIS de
 * decifrar (itens 4 e 6 da auditoria pós-dry-run).
 *
 * A borda (handler.ts) já valida o snapshot antes de gravar, mas ela não
 * é a única chamadora possível de `ingest_form_event` — o worker nunca
 * pode tratar um snapshot corrompido como "endpoint sem campo extra
 * configurado" (`{fields: []}`). Ele revalida com o MESMO schema e devolve
 * um código PERMANENTE, distinto do de "resposta não bate com a
 * configuração", sem nunca chegar a chamar `process_form_event`.
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
const { encryptPayload } = await import("@/server/ingest/payload-crypto");
const { processWebhookEvent } = await import("@/server/ingest/worker");

const VALID_SUBMISSION = {
  sourceEventId: "11111111-2222-4333-8444-555555555555",
  contractVersion: 1,
  occurredAt: new Date().toISOString(),
  turnstileToken: "token-1",
  contact: { name: "Maria Silva", type: "pf" as const },
  answers: {},
  attribution: {},
};

type RpcCall = { fn: string; args: unknown };

function fakeSupabase(event: Record<string, unknown>, calls: RpcCall[]) {
  return {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args });
      if (fn === "get_webhook_event_payload") return Promise.resolve({ data: event, error: null });
      if (fn === "process_form_event") {
        return Promise.resolve({
          data: { already_processed: false, contact_id: "c1", lead_id: "l1", opportunity_id: "o1", touchpoint_id: "t1" },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as never;
}

function eventPayload(overrides: Record<string, unknown>) {
  const encrypted = encryptPayload(JSON.stringify(VALID_SUBMISSION));
  return {
    id: "evt-1",
    status: "received",
    ciphertext: encrypted.ciphertext.toString("base64"),
    iv: encrypted.iv.toString("base64"),
    auth_tag: encrypted.authTag.toString("base64"),
    algorithm: encrypted.algorithm,
    key_version: encrypted.keyVersion,
    ...overrides,
  };
}

describe("processWebhookEvent — revalidação do snapshot (itens 4 e 6)", () => {
  beforeEach(() => {
    resetIngestConfigCache();
    setConfigEnv();
  });

  it("snapshot CORROMPIDO nunca vira {fields: []} — falha com código PERMANENTE, zero processamento", async () => {
    const calls: RpcCall[] = [];
    const supabase = fakeSupabase(
      eventPayload({
        // Chave em maiúscula: não passa no MESMO schema da borda.
        answers_config_snapshot: { fields: [{ key: "CHAVE INVALIDA", label: "x", type: "text" }] },
      }),
      calls,
    );

    const outcome = await processWebhookEvent(supabase, "evt-1");
    expect(outcome).toEqual({ status: "failed", code: "config_snapshot_invalid" });
    expect(calls.some((call) => call.fn === "process_form_event")).toBe(false);
  });

  it("snapshot com fields fora do padrão (não-array) também é recusado fechado", async () => {
    const calls: RpcCall[] = [];
    const supabase = fakeSupabase(eventPayload({ answers_config_snapshot: { fields: "não é um array" } }), calls);

    const outcome = await processWebhookEvent(supabase, "evt-1");
    expect(outcome).toEqual({ status: "failed", code: "config_snapshot_invalid" });
    expect(calls.some((call) => call.fn === "process_form_event")).toBe(false);
  });

  it("snapshot VÁLIDO e vazio ({fields: []}) processa normalmente", async () => {
    const calls: RpcCall[] = [];
    const supabase = fakeSupabase(eventPayload({ answers_config_snapshot: { fields: [] } }), calls);

    const outcome = await processWebhookEvent(supabase, "evt-1");
    expect(outcome.status).toBe("processed");
    expect(calls.some((call) => call.fn === "process_form_event")).toBe(true);
  });
});
