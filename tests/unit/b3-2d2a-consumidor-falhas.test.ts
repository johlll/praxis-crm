/**
 * @vitest-environment node
 *
 * B3.2d-2a — consumidor da inbox com o módulo da inbox isolado: prova o que
 * o consumidor faz com o claim que recebe, sem depender do banco simulado.
 *  - confere de novo o SHA-256 dos bytes contra o hash da linha;
 *  - passa ao adaptador e à finalização o MESMO objeto de claim, sem copiar;
 *  - pede o claim só com o `inboxId` (contexto do chamador ignorado);
 *  - exceção antes da finalização → UMA liberação; exceção na própria
 *    finalização → nenhuma segunda finalização, erro só com código;
 *  - erros do claim viram resultado sanitizado ou erro de nova tentativa.
 *
 * Escritos ANTES da implementação, contra a main 10e617f. Tudo fictício.
 */
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as InboxModule from "@/server/whatsapp/inbox";
import type * as ProviderModule from "@/server/whatsapp/provider";

const inboxMock = vi.hoisted(() => ({
  claimWhatsAppInboxEntry: vi.fn(),
  completeWhatsAppInboxClaim: vi.fn(),
  failWhatsAppInboxClaim: vi.fn(),
  releaseWhatsAppInboxClaim: vi.fn(),
  disposeWhatsAppInboxClaim: vi.fn(),
}));
const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));

vi.mock("@/server/whatsapp/inbox", async (importOriginal) => ({
  ...(await importOriginal<typeof InboxModule>()),
  ...inboxMock,
}));
vi.mock("@/server/whatsapp/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderModule>()),
  resolveWhatsAppProvider: resolveMock,
}));

const { WhatsAppInboxError } = await import("@/server/whatsapp/inbox");
const { VerifiedWebhookBody } = await import("@/server/whatsapp/provider/contract");
const loadConsumer = () => import("@/server/whatsapp/consumer");

const INBOX_ID = "46000000-0000-4000-8000-000000000002";
const WS = "10000000-0000-0000-0000-000000000001";
const CHANNEL = "36000000-0000-0000-0000-000000000001";
const ROUTING = "sim-falhas-1";
const EVENT_ID = "evt-falhas-1";
const PHONE = "+5511988887777";

const RAW = new TextEncoder().encode(
  JSON.stringify({ version: 1, events: [{ type: "other", id: EVENT_ID, routingKey: ROUTING, occurredAt: "2026-10-21T12:00:00Z", providerType: "x" }] }),
);
const sha256 = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");

function fakeClaim(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    inboxId: INBOX_ID,
    environment: "preview",
    workspaceId: WS,
    channelId: CHANNEL,
    channelStatus: "active",
    provider: "simulated",
    routingKey: ROUTING,
    providerEventId: EVENT_ID,
    providerEventType: "other",
    receivedAt: "2026-10-21T11:59:59Z",
    retainUntil: "2026-10-21T12:59:59Z",
    claimCount: 1,
    claimedAt: "2026-10-21T12:00:00Z",
    leaseUntil: "2026-10-21T12:05:00Z",
    bodySha256: sha256(RAW),
    verified: VerifiedWebhookBody.afterSignatureCheck(RAW),
    ...overrides,
  });
}

const finalizers = () =>
  (["completeWhatsAppInboxClaim", "failWhatsAppInboxClaim", "releaseWhatsAppInboxClaim", "disposeWhatsAppInboxClaim"] as const).flatMap((name) =>
    inboxMock[name].mock.calls.map((args) => [name, ...args.slice(1)]),
  );

beforeEach(async () => {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("WHATSAPP_PROVIDER", "simulated");
  for (const fn of Object.values(inboxMock)) fn.mockReset();
  inboxMock.failWhatsAppInboxClaim.mockResolvedValue({ outcome: "failed" });
  inboxMock.releaseWhatsAppInboxClaim.mockResolvedValue({ outcome: "released" });
  inboxMock.disposeWhatsAppInboxClaim.mockResolvedValue({ outcome: "completed" });
  inboxMock.completeWhatsAppInboxClaim.mockResolvedValue({ outcome: "completed" });
  const actual = await vi.importActual<typeof ProviderModule>("@/server/whatsapp/provider");
  resolveMock.mockReset();
  resolveMock.mockImplementation(actual.resolveWhatsAppProvider);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function run(params: Record<string, unknown> = { inboxId: INBOX_ID }) {
  const { processWhatsAppInboxEntry } = await loadConsumer();
  return processWhatsAppInboxEntry(params as never);
}

describe("1. o claim é pedido só pelo inboxId e não é copiado", () => {
  it("contexto extra do chamador não chega ao claim", async () => {
    inboxMock.claimWhatsAppInboxEntry.mockResolvedValue({ outcome: "busy" });
    await run({ inboxId: INBOX_ID, workspaceId: WS, channelId: CHANNEL, routingKey: "x", provider: "ycloud", leaseSeconds: 900 });
    expect(inboxMock.claimWhatsAppInboxEntry).toHaveBeenCalledTimes(1);
    expect(inboxMock.claimWhatsAppInboxEntry).toHaveBeenCalledWith({ inboxId: INBOX_ID });
  });

  it("a finalização recebe o MESMO objeto emitido pelo claim", async () => {
    const claim = fakeClaim();
    inboxMock.claimWhatsAppInboxEntry.mockResolvedValue({ outcome: "claimed", claim });
    await expect(run()).resolves.toEqual({ outcome: "processed", code: "unsupported_event" });
    expect(inboxMock.disposeWhatsAppInboxClaim).toHaveBeenCalledTimes(1);
    expect(inboxMock.disposeWhatsAppInboxClaim.mock.calls[0]?.[0]).toBe(claim);
    expect(inboxMock.disposeWhatsAppInboxClaim.mock.calls[0]?.[1]).toBe("unsupported_event");
    expect(inboxMock.completeWhatsAppInboxClaim).not.toHaveBeenCalled();
  });
});

describe("2. o hash é conferido de novo depois do claim", () => {
  it("bytes que não batem com o hash da linha: fail inbox_integrity_failed, sem normalizar", async () => {
    inboxMock.claimWhatsAppInboxEntry.mockResolvedValue({ outcome: "claimed", claim: fakeClaim({ bodySha256: "c".repeat(64) }) });
    await expect(run()).resolves.toEqual({ outcome: "failed", code: "inbox_integrity_failed" });
    expect(finalizers()).toEqual([["failWhatsAppInboxClaim", "inbox_integrity_failed"]]);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("hash ausente ou malformado: a mesma falha terminal", async () => {
    for (const bodySha256 of [undefined, "", "xyz"]) {
      inboxMock.failWhatsAppInboxClaim.mockClear();
      inboxMock.claimWhatsAppInboxEntry.mockResolvedValue({ outcome: "claimed", claim: fakeClaim({ bodySha256 }) });
      await expect(run()).resolves.toEqual({ outcome: "failed", code: "inbox_integrity_failed" });
    }
  });
});

describe("3. exceções: exatamente uma finalização, ou nenhuma", () => {
  it("exceção inesperada antes da finalização: UMA liberação consumer_transient_error", async () => {
    inboxMock.claimWhatsAppInboxEntry.mockResolvedValue({ outcome: "claimed", claim: fakeClaim() });
    resolveMock.mockImplementation(() => {
      throw new Error(`falha interna ${PHONE}`);
    });
    await expect(run()).resolves.toEqual({ outcome: "released", code: "consumer_transient_error" });
    expect(finalizers()).toEqual([["releaseWhatsAppInboxClaim", "consumer_transient_error"]]);
  });

  it.each([
    ["disposeWhatsAppInboxClaim", fakeClaim()],
    ["releaseWhatsAppInboxClaim", fakeClaim({ channelStatus: "paused" })],
    ["failWhatsAppInboxClaim", fakeClaim({ routingKey: "sim-outro" })],
  ] as const)("%s lança: nenhuma segunda finalização, erro de nova tentativa só com código", async (name, claim) => {
    inboxMock.claimWhatsAppInboxEntry.mockResolvedValue({ outcome: "claimed", claim });
    inboxMock[name].mockRejectedValue(new Error(`socket hang up ${PHONE}`));
    const { WhatsAppConsumerRetryableError } = await loadConsumer();
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppConsumerRetryableError);
    expect(error).toMatchObject({ code: "inbox_finalize_unavailable", message: "inbox_finalize_unavailable" });
    expect(String((error as Error).stack)).not.toContain(PHONE);
    expect(finalizers().map(([n]) => n)).toEqual([name]);
  });

  it("finalização devolve claim_lost: nenhuma outra finalização", async () => {
    inboxMock.claimWhatsAppInboxEntry.mockResolvedValue({ outcome: "claimed", claim: fakeClaim({ channelStatus: "disabled" }) });
    inboxMock.releaseWhatsAppInboxClaim.mockResolvedValue({ outcome: "claim_lost" });
    await expect(run()).resolves.toEqual({ outcome: "claim_lost", code: "channel_disabled" });
    expect(finalizers()).toEqual([["releaseWhatsAppInboxClaim", "channel_disabled"]]);
  });
});

describe("4. erros do próprio claim", () => {
  it.each([
    ["inbox_decrypt_failed", { outcome: "failed", code: "inbox_decrypt_failed" }],
    ["inbox_integrity_failed", { outcome: "failed", code: "inbox_integrity_failed" }],
    ["inbox_crypto_not_configured", { outcome: "released", code: "inbox_crypto_not_configured" }],
    ["inbox_key_version_unknown", { outcome: "released", code: "inbox_key_version_unknown" }],
  ] as const)("%s (o claim já finalizou): resultado sanitizado, sem finalização do consumidor", async (code, expected) => {
    inboxMock.claimWhatsAppInboxEntry.mockRejectedValue(new WhatsAppInboxError(code as never));
    await expect(run()).resolves.toEqual(expected);
    expect(finalizers()).toEqual([]);
  });

  it.each([
    ["erro desconhecido do banco", () => new WhatsAppInboxError("unknown")],
    ["retorno fora do contrato", () => new WhatsAppInboxError("inbox_claim_invalid")],
    ["ambiente divergente", () => new WhatsAppInboxError("channel_environment_mismatch")],
    ["erro bruto", () => new Error(`ECONNREFUSED 10.0.0.1 ${PHONE}`)],
  ])("%s: erro de nova tentativa só com código", async (_name, make) => {
    inboxMock.claimWhatsAppInboxEntry.mockRejectedValue(make());
    const error = await run().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "inbox_unavailable", message: "inbox_unavailable" });
    expect(String((error as Error).stack)).not.toMatch(/10\.0\.0\.1|ECONNREFUSED|5511/);
    expect(finalizers()).toEqual([]);
  });
});
