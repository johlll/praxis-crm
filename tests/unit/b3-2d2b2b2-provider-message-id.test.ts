/**
 * @vitest-environment node
 *
 * B3.2d-2b2b2 — o id da mensagem no provedor (`providerMessageId`) tem UM
 * contrato interno: de 1 a 255 caracteres, o primeiro alfanumérico e os
 * demais em `A-Za-z0-9._:=+/-`. É o limite da coluna e das RPCs.
 *
 *  - o adaptador YCloud aceita 255 e recusa 256 já na normalização
 *    (`invalid_payload`): nenhum evento passa pelo adaptador para falhar só
 *    no efeito;
 *  - os efeitos de mensagem recebida, de saída observada e de status
 *    aceitam 255 e recusam 256 antes do banco;
 *  - o adaptador e os três efeitos usam o mesmo padrão, de um módulo
 *    neutro (o contrato do provedor), e os efeitos não dependem do
 *    adaptador YCloud.
 *
 * O limite é o contrato interno desta fase, não uma garantia da YCloud;
 * pode ser reavaliado com o webhook real.
 *
 * Escritos ANTES da correção, sobre a PR #235 (7eb4be6). O banco é
 * simulado. Tudo fictício.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  body,
  bytes,
  FICT,
  inboundText,
  NOW_MS,
  signedHeaders,
  smbEcho,
  statusUpdated,
} from "../support/ycloud-fixtures";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/server/whatsapp/admin/supabase", () => ({
  createWhatsAppAdminSupabaseClient: () => ({ rpc: rpcMock }),
}));

const { encryptWhatsAppInboxBody } =
  await import("@/server/whatsapp/inbox-crypto");

/** Ids fictícios no conjunto aceito, com o tamanho exato pedido. */
const id = (size: number) => `A${"b1.:=+/-_".repeat(40)}`.slice(0, size);
const ID_255 = id(255);
const ID_256 = id(256);

const WS = "10000000-0000-0000-0000-000000000001";
const CHANNEL = "35000000-0000-0000-0000-000000000004";
const INBOX_ID = "45000000-0000-4000-8000-000000000004";
const TOKEN = "6f1d2c3b-4a59-4e8f-9a1b-2c3d4e5f6a7e";
const MESSAGE_ID = "46000000-0000-4000-8000-000000000004";
const CONVERSATION_ID = "47000000-0000-4000-8000-000000000004";
const EVENT_ID = "evt-limite-id-1";
const PHONE = "+5511988885555";

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv(
    "WHATSAPP_ENV_SIGNING_KEY",
    "chave-de-teste-b3-whatsapp-0123456789",
  );
  vi.stubEnv(
    "WHATSAPP_INBOX_KEY_VERSIONS",
    JSON.stringify({ "1": Buffer.alloc(32, 9).toString("base64") }),
  );
  vi.stubEnv("WHATSAPP_INBOX_ACTIVE_KEY_VERSION", "1");
  vi.stubEnv(
    "WHATSAPP_IDENTITY_KEY_VERSIONS",
    JSON.stringify({ "1": Buffer.alloc(32, 44).toString("base64") }),
  );
  vi.stubEnv("WHATSAPP_IDENTITY_ACTIVE_KEY_VERSION", "1");
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (name: string) => {
    if (name === "whatsapp_inbox_claim")
      return { data: claimRow(), error: null };
    if (name === "whatsapp_effect_inbound_message") {
      return {
        data: {
          outcome: "applied",
          message_id: MESSAGE_ID,
          conversation_id: CONVERSATION_ID,
          sender_classification: "external",
          contact_created: false,
          lead_created: false,
        },
        error: null,
      };
    }
    if (name === "whatsapp_effect_outbound_observed") {
      return {
        data: {
          outcome: "applied",
          message_id: MESSAGE_ID,
          conversation_id: CONVERSATION_ID,
        },
        error: null,
      };
    }
    if (name === "whatsapp_effect_message_status")
      return {
        data: { outcome: "applied", message_id: MESSAGE_ID },
        error: null,
      };
    return { data: null, error: { message: `rpc_nao_esperada:${name}` } };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const RAW = new TextEncoder().encode(
  `{"version":1,"events":[{"type":"message.status","id":"${EVENT_ID}"}]}`,
);

function claimRow() {
  const enc = encryptWhatsAppInboxBody(RAW, {
    environment: "preview",
    workspaceId: WS,
    channelId: CHANNEL,
    provider: "simulated",
    providerEventId: EVENT_ID,
  } as never);
  return {
    outcome: "claimed",
    inbox_id: INBOX_ID,
    claim_token: TOKEN,
    claim_count: 1,
    claimed_at: "2026-10-30T12:00:00.000000+00:00",
    lease_until: "2026-10-30T12:05:00.000000+00:00",
    environment: "preview",
    workspace_id: WS,
    channel_id: CHANNEL,
    channel_status: "active",
    provider: "simulated",
    routing_key: "sim-limite-1",
    provider_event_id: EVENT_ID,
    provider_event_type: "whatsapp.message.updated",
    body_sha256: createHash("sha256").update(RAW).digest("hex"),
    received_at: "2026-10-30T11:59:59.000000+00:00",
    retain_until: "2026-10-30T12:59:59.000000+00:00",
    key_version: enc.keyVersion,
    nonce: enc.nonce,
    ciphertext: enc.ciphertext,
    auth_tag: enc.authTag,
  };
}

async function claimed() {
  const inbox = await import("@/server/whatsapp/inbox");
  const result = await inbox.claimWhatsAppInboxEntry({ inboxId: INBOX_ID });
  if (result.outcome !== "claimed")
    throw new Error(`claim não obtido no teste: ${result.outcome}`);
  return result.claim;
}

const callsOf = (rpc: string) =>
  rpcMock.mock.calls.filter(([n]) => n === rpc) as [
    string,
    Record<string, unknown>,
  ][];

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return (error as { code?: string } | null)?.code ?? null;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function normalize(event: unknown) {
  const { YCloudWhatsAppProvider } =
    await import("@/server/whatsapp/provider/ycloud");
  const provider = new YCloudWhatsAppProvider();
  const raw = bytes(body(event));
  const verified = provider.verifyWebhook({
    rawBody: raw,
    headers: signedHeaders(raw),
    secret: FICT.secret,
    nowMs: NOW_MS,
  });
  if (!verified.ok)
    throw new Error(`assinatura recusada no teste: ${verified.reason}`);
  return provider.normalizeEvents(verified.verified);
}

function withMessageId(
  event: Record<string, unknown>,
  key: "whatsappInboundMessage" | "whatsappMessage",
  messageId: string,
) {
  const copy = clone(event) as Record<string, Record<string, unknown>>;
  copy[key]!.id = messageId;
  return copy;
}

// ---------------------------------------------------------------------
// 1. Adaptador YCloud
// ---------------------------------------------------------------------

describe("1. adaptador YCloud: 255 aceito, 256 recusado na normalização", () => {
  const events: [
    string,
    Record<string, unknown>,
    "whatsappInboundMessage" | "whatsappMessage",
  ][] = [
    ["mensagem recebida", inboundText, "whatsappInboundMessage"],
    ["eco do aplicativo", smbEcho, "whatsappMessage"],
    ["status", statusUpdated("delivered"), "whatsappMessage"],
  ];

  for (const [label, event, key] of events) {
    it(`${label}: id do provedor com 255 caracteres é normalizado inteiro`, async () => {
      const result = await normalize(withMessageId(event, key, ID_255));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.events).toHaveLength(1);
      expect(
        (result.events[0] as { providerMessageId?: string }).providerMessageId,
      ).toBe(ID_255);
    });

    it(`${label}: id do provedor com 256 caracteres termina como invalid_payload, sem evento para o domínio`, async () => {
      expect(await normalize(withMessageId(event, key, ID_256))).toEqual({
        ok: false,
        reason: "invalid_payload",
      });
      expect(rpcMock).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------
// 2. Os três efeitos
// ---------------------------------------------------------------------

describe("2. efeitos: 255 aceito e repassado, 256 recusado antes do banco", () => {
  const effects = [
    {
      label: "mensagem recebida",
      rpc: "whatsapp_effect_inbound_message",
      code: "invalid_inbound_message",
      run: async (claim: never, providerMessageId: string) => {
        const { applyWhatsAppInboundMessage } =
          await import("@/server/whatsapp/effects/inbound-message");
        return applyWhatsAppInboundMessage(claim, {
          providerMessageId,
          contentKind: "text",
          text: "Mensagem fictícia",
          occurredAt: "2026-10-30T11:59:58.000Z",
          sender: { phoneE164: PHONE, bsuid: null },
          profileName: null,
        });
      },
    },
    {
      label: "saída observada",
      rpc: "whatsapp_effect_outbound_observed",
      code: "invalid_outbound_message",
      run: async (claim: never, providerMessageId: string) => {
        const { applyWhatsAppOutboundObserved } =
          await import("@/server/whatsapp/effects/outbound-observed");
        return applyWhatsAppOutboundObserved(claim, {
          providerMessageId,
          waMessageId: null,
          contentKind: "text",
          text: "Mensagem fictícia do escritório",
          occurredAt: "2026-10-30T11:59:58.000Z",
          recipient: { phoneE164: PHONE, bsuid: null },
        });
      },
    },
    {
      label: "status e custo",
      rpc: "whatsapp_effect_message_status",
      code: "invalid_status_update",
      run: async (claim: never, providerMessageId: string) => {
        const { applyWhatsAppMessageStatus } =
          await import("@/server/whatsapp/effects/message-status");
        return applyWhatsAppMessageStatus(claim, {
          providerMessageId,
          waMessageId: null,
          externalId: null,
          status: "delivered",
          errorCode: null,
          occurredAt: "2026-10-30T11:59:58.000Z",
          recipient: null,
          providerCost: null,
        });
      },
    },
  ];

  for (const effect of effects) {
    it(`${effect.label}: 255 caracteres vão ao banco inteiros`, async () => {
      const claim = await claimed();
      await expect(effect.run(claim as never, ID_255)).resolves.toMatchObject({
        outcome: "applied",
      });
      expect(
        callsOf(effect.rpc).map(([, a]) => a.p_provider_message_id),
      ).toEqual([ID_255]);
    });

    it(`${effect.label}: 256 caracteres são recusados (${effect.code}), nada pedido ao banco`, async () => {
      const claim = await claimed();
      expect(await codeOf(effect.run(claim as never, ID_256))).toBe(
        effect.code,
      );
      expect(callsOf(effect.rpc)).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------
// 3. Um contrato só, em módulo neutro
// ---------------------------------------------------------------------

describe("3. o adaptador e os três efeitos usam o mesmo contrato", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const EFFECTS = [
    "src/server/whatsapp/effects/inbound-message.ts",
    "src/server/whatsapp/effects/outbound-observed.ts",
    "src/server/whatsapp/effects/message-status.ts",
  ];

  it("o contrato do provedor exporta o padrão de 1 a 255 caracteres", async () => {
    const contract =
      (await import("@/server/whatsapp/provider/contract")) as Record<
        string,
        unknown
      >;
    const pattern = contract.WHATSAPP_PROVIDER_MESSAGE_ID_PATTERN as
      RegExp | undefined;
    expect(pattern).toBeInstanceOf(RegExp);
    expect(String(pattern)).toBe(
      String.raw`/^[A-Za-z0-9][A-Za-z0-9._:=+/-]{0,254}$/`,
    );
    expect(pattern!.test(ID_255)).toBe(true);
    expect(pattern!.test(ID_256)).toBe(false);
    expect(pattern!.test("")).toBe(false);
    expect(pattern!.test(".comeca-com-ponto")).toBe(false);
    expect(pattern!.test("id com espaço")).toBe(false);
  });

  it("o adaptador e os três efeitos importam o mesmo padrão e não declaram outro", () => {
    for (const p of ["src/server/whatsapp/provider/ycloud.ts", ...EFFECTS]) {
      const src = read(p);
      expect(src, p).toMatch(/WHATSAPP_PROVIDER_MESSAGE_ID_PATTERN/);
      expect(src, p).toMatch(/from "@\/server\/whatsapp\/provider\/contract"/);
      expect(src, p).not.toMatch(/\{0,255\}/);
      expect(src, p).not.toMatch(
        /providerMessageId: z\.string\(\)\.regex\(\/\^/,
      );
    }
    expect(read("src/server/whatsapp/provider/ycloud.ts")).not.toMatch(
      /const MESSAGE_ID = \//,
    );
  });

  it("os efeitos não dependem do adaptador YCloud", () => {
    for (const p of EFFECTS) expect(read(p), p).not.toMatch(/provider\/ycloud/);
    expect(read("src/server/whatsapp/provider/contract.ts")).not.toMatch(
      /provider\/ycloud|effects\//,
    );
  });
});
