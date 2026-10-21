/**
 * @vitest-environment node
 *
 * B3.2a, revisão da PR #48 — pontos 1 e 2.
 *
 * 1. Versão do evento: só `apiVersion: "v2"`. Uma v3 futura nunca é lida
 *    com o schema da v2.
 * 2. Custo devolvido pela YCloud no `whatsapp.message.updated`
 *    (`pricingCategory`, `totalPrice`, `currency`). Guia oficial de preço:
 *    `accepted`/`sent` = estimativa; `delivered`/`read` = valor final;
 *    `failed` = não cobrado. É custo do PROVEDOR, nunca estimativa do CRM.
 *
 * Escritos ANTES da correção, contra o HEAD a8db0ef.
 */
import { describe, expect, it } from "vitest";

import { body, bytes, FICT, inboundText, NOW_MS, signedHeaders, statusUpdated } from "../support/ycloud-fixtures";

const load = () => import("@/server/whatsapp/provider/ycloud");
const loadProjection = () => import("@/server/whatsapp/status-projection");

async function normalizeRaw(raw: Uint8Array) {
  const { YCloudWhatsAppProvider } = await load();
  const provider = new YCloudWhatsAppProvider();
  const verified = provider.verifyWebhook({ rawBody: raw, headers: signedHeaders(raw), secret: FICT.secret, nowMs: NOW_MS });
  if (!verified.ok) throw new Error(`assinatura recusada no teste: ${verified.reason}`);
  return provider.normalizeEvents(verified.verified);
}

const normalize = (event: unknown) => normalizeRaw(bytes(body(event)));

async function single(event: unknown) {
  const result = await normalize(event);
  if (!result.ok) throw new Error(`normalização recusada: ${result.reason}`);
  return result.events[0]!;
}

async function costOf(status: string, extra: Record<string, unknown> = {}) {
  const event = await single(statusUpdated(status, extra));
  if (event.kind !== "message.status") throw new Error(`esperava status, veio ${event.kind}`);
  return (event as { providerCost?: unknown }).providerCost;
}

describe("1. versão do evento", () => {
  it("v2 é aceita", async () => {
    expect((await normalize(inboundText)).ok).toBe(true);
    expect((await normalize(statusUpdated("sent"))).ok).toBe(true);
  });

  it.each([
    ["ausente", undefined],
    ["vazia", ""],
    ["v1", "v1"],
    ["v3", "v3"],
    ["V2 em maiúscula", "V2"],
    ["v2 com espaço", " v2"],
    ["número", 2],
    ["null", null],
    ["objeto", { v: 2 }],
  ])("versão %s → invalid_payload", async (_name, apiVersion) => {
    expect(await normalize({ ...inboundText, apiVersion })).toEqual({ ok: false, reason: "invalid_payload" });
    expect(await normalize({ ...statusUpdated("delivered"), apiVersion })).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("uma v3 com corpo idêntico ao da v2 não é interpretada", async () => {
    expect(await normalize({ ...statusUpdated("read"), apiVersion: "v3" })).toEqual({ ok: false, reason: "invalid_payload" });
  });
});

describe("2. custo informado pelo provedor", () => {
  it("delivered: valor final, com categoria, valor e moeda", async () => {
    expect(await costOf("delivered", { pricingCategory: "marketing", totalPrice: 0.05, currency: "USD" })).toEqual({
      source: "provider",
      category: "marketing",
      amount: 0.05,
      currency: "USD",
      finality: "final",
    });
  });

  it("read também é final", async () => {
    expect(await costOf("read", { totalPrice: 0.05 })).toMatchObject({ finality: "final", amount: 0.05 });
  });

  it.each(["accepted", "sent", "failed"])("%s: estimativa, nunca final", async (status) => {
    expect(await costOf(status, { totalPrice: 0.05 })).toMatchObject({ source: "provider", finality: "estimated" });
  });

  it("valor zero é um custo válido (mensagem gratuita)", async () => {
    expect(await costOf("delivered", { totalPrice: 0, pricingCategory: "service" })).toEqual({
      source: "provider",
      category: "service",
      amount: 0,
      currency: "USD",
      finality: "final",
    });
  });

  it("valor decimal é preservado", async () => {
    expect(await costOf("delivered", { totalPrice: 0.0125 })).toMatchObject({ amount: 0.0125 });
  });

  it("categoria futura é preservada como valor opaco", async () => {
    expect(await costOf("delivered", { pricingCategory: "categoria_futura_2027" })).toMatchObject({ category: "categoria_futura_2027" });
  });

  it("sem categoria: custo sem categoria", async () => {
    const event = statusUpdated("delivered");
    delete (event.whatsappMessage as Partial<typeof event.whatsappMessage>).pricingCategory;
    expect((await single(event)) as unknown).toMatchObject({ providerCost: { category: null, amount: 0, currency: "USD" } });
  });

  it("sem nenhum campo de preço: providerCost null", async () => {
    const event = statusUpdated("delivered");
    const message = event.whatsappMessage as Partial<typeof event.whatsappMessage>;
    delete message.pricingCategory;
    delete message.totalPrice;
    delete message.currency;
    expect((await single(event)) as unknown).toMatchObject({ providerCost: null });
  });

  it.each([
    ["valor sem moeda", ["currency"]],
    ["moeda sem valor", ["totalPrice"]],
    ["só a categoria", ["totalPrice", "currency"]],
  ] as const)("parcial (%s): nunca vira custo aparentemente confiável", async (_name, remove) => {
    const event = statusUpdated("delivered");
    const message = event.whatsappMessage as Record<string, unknown>;
    for (const key of remove) delete message[key];
    expect((await single(event)) as unknown).toMatchObject({ providerCost: null });
  });

  it("contraditório: tipo gratuito com valor positivo não vira custo", async () => {
    expect(await costOf("delivered", { pricingType: "free_customer_service", totalPrice: 0.05 })).toBeNull();
    expect(await costOf("delivered", { pricingType: "free_entry_point", totalPrice: 0.01 })).toBeNull();
  });

  it.each([
    ["valor negativo", { totalPrice: -0.01 }],
    ["valor em texto", { totalPrice: "0.05" }],
    ["moeda minúscula", { currency: "usd" }],
    ["moeda com 2 letras", { currency: "US" }],
    ["moeda por extenso", { currency: "DOLAR" }],
    ["moeda não textual", { currency: 840 }],
    ["categoria malformada", { pricingCategory: "Marketing Promo!" }],
    ["categoria vazia", { pricingCategory: "" }],
  ])("recusa: %s", async (_name, patch) => {
    expect(await normalize(statusUpdated("delivered", patch))).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("valor infinito (1e400 no JSON) é recusado", async () => {
    const text = body(statusUpdated("delivered")).replace('"totalPrice": 0', '"totalPrice": 1e400');
    expect(text).toContain("1e400");
    expect(await normalizeRaw(bytes(text))).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("o simulado não inventa custo", async () => {
    const { SimulatedWhatsAppProvider, signSimulatedWebhook, SIMULATED_SIGNATURE_HEADER } = await import(
      "@/server/whatsapp/provider/simulated"
    );
    const provider = new SimulatedWhatsAppProvider();
    const raw = bytes(
      JSON.stringify({
        version: 1,
        events: [{ type: "message.status", id: "e1", routingKey: "r", messageId: "m", occurredAt: "2026-10-20T12:00:00Z", status: "delivered" }],
      }),
    );
    const headers = new Headers({ [SIMULATED_SIGNATURE_HEADER]: signSimulatedWebhook(raw, "s", Math.floor(NOW_MS / 1000)) });
    const verified = provider.verifyWebhook({ rawBody: raw, headers, secret: "s", nowMs: NOW_MS });
    const result = verified.ok ? provider.normalizeEvents(verified.verified) : null;
    expect(result?.ok && (result.events[0] as unknown)).toMatchObject({ providerCost: null });
  });
});

describe("2b. projeção do custo junto com o status", () => {
  const estimated = { source: "provider", category: "marketing", amount: 0.05, currency: "USD", finality: "estimated" } as const;
  const final = { source: "provider", category: "marketing", amount: 0.04, currency: "USD", finality: "final" } as const;

  it("estimativa é substituída pelo valor final", async () => {
    const { projectWhatsAppProviderCost } = await loadProjection();
    expect(projectWhatsAppProviderCost(estimated, final)).toEqual(final);
    expect(projectWhatsAppProviderCost(null, estimated)).toEqual(estimated);
  });

  it("valor final nunca volta a ser estimativa nem some", async () => {
    const { projectWhatsAppProviderCost } = await loadProjection();
    expect(projectWhatsAppProviderCost(final, estimated)).toEqual(final);
    expect(projectWhatsAppProviderCost(final, null)).toEqual(final);
  });

  it("failed com estimativa, depois delivered com valor final: status e custo finais", async () => {
    const { projectWhatsAppMessageStatus, projectWhatsAppProviderCost } = await loadProjection();
    let status = projectWhatsAppMessageStatus(null, "failed").status;
    let cost = projectWhatsAppProviderCost(null, { ...estimated, amount: 0 });
    status = projectWhatsAppMessageStatus(status, "delivered").status;
    cost = projectWhatsAppProviderCost(cost, final);
    expect(status).toBe("delivered");
    expect(cost).toEqual(final);
  });

  it("de ponta a ponta: o custo do failed normalizado é estimativa e o do delivered é final", async () => {
    const { projectWhatsAppProviderCost } = await loadProjection();
    const failed = (await single(statusUpdated("failed", { totalPrice: 0 }))) as unknown as { providerCost: typeof estimated };
    const delivered = (await single(statusUpdated("delivered", { totalPrice: 0.04 }))) as unknown as { providerCost: typeof final };
    const cost = projectWhatsAppProviderCost(failed.providerCost, delivered.providerCost);
    expect(cost).toMatchObject({ finality: "final", amount: 0.04 });
  });
});
