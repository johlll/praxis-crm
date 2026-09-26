import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * A11 — fixture TEMPORÁRIA de QA (`/api/cron/qa-create-pending-outbox`).
 *
 * Existe só para o teste real de recuperação de outbox contra
 * `praxis-crm-dev`, provando o reconciliador com ciphertext REAL (a
 * mesma função de cifra da ingestão real), sem depender da chave ativa
 * do Preview (mascarada) e sem passar pela rota pública, que já
 * publicaria inline. Nunca será mesclada em `main` — este teste também é
 * removido junto da rota, ao final daquele teste.
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
    "VERCEL_ENV",
  ]) {
    delete process.env[key];
  }
}

const rpcCalls: { name: string; args: unknown }[] = [];

vi.mock("@/server/supabase/admin", () => ({
  createAdminSupabaseClient: () => ({
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name === "ingest_form_event") {
        return Promise.resolve({
          data: {
            webhook_event_id: "11111111-0000-4000-8000-000000000001",
            outbox_id: "22222222-0000-4000-8000-000000000002",
            created: true,
            protocol: "qa-fixture-protocolo",
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { message: "rpc inesperada em teste" } });
    },
  }),
}));

describe("POST /api/cron/qa-create-pending-outbox (fixture temporária de QA)", () => {
  beforeEach(() => {
    vi.resetModules();
    rpcCalls.length = 0;
    setConfigEnv();
  });

  afterEach(() => {
    clearConfigEnv();
  });

  it("fora do Preview: 404, mesmo com segredo correto", async () => {
    delete process.env.VERCEL_ENV;
    const { POST } = await import("@/app/api/cron/qa-create-pending-outbox/route");
    const response = await POST(
      new Request("http://localhost/api/cron/qa-create-pending-outbox", {
        method: "POST",
        headers: { authorization: "Bearer cron-secret-de-teste-0000" },
      }),
    );
    expect(response.status).toBe(404);
    expect(rpcCalls).toHaveLength(0);
  });

  it("Preview sem Authorization: 401", async () => {
    process.env.VERCEL_ENV = "preview";
    const { POST } = await import("@/app/api/cron/qa-create-pending-outbox/route");
    const response = await POST(new Request("http://localhost/api/cron/qa-create-pending-outbox", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(rpcCalls).toHaveLength(0);
  });

  it("Preview com segredo incorreto: 401", async () => {
    process.env.VERCEL_ENV = "preview";
    const { POST } = await import("@/app/api/cron/qa-create-pending-outbox/route");
    const response = await POST(
      new Request("http://localhost/api/cron/qa-create-pending-outbox", {
        method: "POST",
        headers: { authorization: "Bearer valor-errado" },
      }),
    );
    expect(response.status).toBe(401);
    expect(rpcCalls).toHaveLength(0);
  });

  it("Preview autenticado: cria exatamente um evento e uma outbox, sem chamar publicador", async () => {
    process.env.VERCEL_ENV = "preview";
    const { POST } = await import("@/app/api/cron/qa-create-pending-outbox/route");
    const response = await POST(
      new Request("http://localhost/api/cron/qa-create-pending-outbox", {
        method: "POST",
        headers: { authorization: "Bearer cron-secret-de-teste-0000" },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.webhook_event_id).toBe("11111111-0000-4000-8000-000000000001");
    expect(body.outbox_id).toBe("22222222-0000-4000-8000-000000000002");

    // Exatamente UMA chamada de RPC no total: só ingest_form_event.
    // Nenhuma chamada a claim_outbox_batch, mark_outbox_published ou a
    // qualquer publicador — a fixture nunca publica.
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.name).toBe("ingest_form_event");
  });

  it("Preview autenticado: o payload cifrado é decifrável pela MESMA rotina do worker", async () => {
    process.env.VERCEL_ENV = "preview";
    const { POST } = await import("@/app/api/cron/qa-create-pending-outbox/route");
    const { decryptPayload } = await import("@/server/ingest/payload-crypto");
    const { submissionSchema } = await import("@/server/ingest/submission");

    await POST(
      new Request("http://localhost/api/cron/qa-create-pending-outbox", {
        method: "POST",
        headers: { authorization: "Bearer cron-secret-de-teste-0000" },
      }),
    );

    expect(rpcCalls).toHaveLength(1);
    const args = rpcCalls[0]!.args as {
      p_payload_ciphertext: string;
      p_payload_iv: string;
      p_payload_auth_tag: string;
      p_payload_algorithm: string;
      p_payload_key_version: string;
    };

    const hexToBuffer = (value: string) => Buffer.from(value.replace(/^\\x/, ""), "hex");
    const plaintext = decryptPayload({
      ciphertext: hexToBuffer(args.p_payload_ciphertext),
      iv: hexToBuffer(args.p_payload_iv),
      authTag: hexToBuffer(args.p_payload_auth_tag),
      algorithm: args.p_payload_algorithm,
      keyVersion: args.p_payload_key_version,
    });

    const parsed = submissionSchema.safeParse(JSON.parse(plaintext));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.contact.name).toMatch(/^QA Outbox Reconciler /);
      expect(parsed.data.consent?.decision).toBe("granted");
    }
  });
});
