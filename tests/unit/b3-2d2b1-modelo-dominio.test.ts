/**
 * @vitest-environment node
 *
 * B3.2d-2b1 — contratos puros do domínio do WhatsApp que a próxima etapa
 * (B3.2d-2b2, RPCs dos efeitos) vai usar:
 *  - origem técnica (`origin`) e classificação do remetente
 *    (`sender_classification`) modeladas SEPARADAMENTE, com as combinações
 *    permitidas e proibidas;
 *  - a classificação nunca lê o texto da mensagem nem o formato de um
 *    identificador: `chatbot` só com correlação confiável;
 *  - identidade por telefone, por BSUID ou pelos dois, nunca nenhum, e
 *    nunca um telefone fabricado a partir do BSUID;
 *  - conteúdo: texto, mídia com legenda e mídia sem texto;
 *  - status com `accepted`, correções depois de `failed`, e custo
 *    estimado × final;
 *  - lead só para `inbound + external`;
 *  - chave do ledger de efeitos sem conteúdo.
 *
 * Escritos ANTES da implementação, contra a main 6633084. Tudo fictício.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const loadModel = () => import("@/server/whatsapp/domain-model");

const PHONE = "+5511999990000";
const BSUID = "BR.1234567890";
const CHANNEL = "36000000-0000-0000-0000-000000000001";
const ORIGINS = ["inbound", "crm", "business_app", "chatbot", "external_api", "history"];
const CLASSIFICATIONS = ["external", "internal", "automation", "unresolved"];

// ---------------------------------------------------------------------
// 1. Origem e classificação
// ---------------------------------------------------------------------

describe("1. origem e classificação do remetente", () => {
  it("valores exatos de origin e sender_classification; `internal` nunca é origem", async () => {
    const m = await loadModel();
    expect([...m.WHATSAPP_MESSAGE_ORIGINS]).toEqual(ORIGINS);
    expect([...m.WHATSAPP_SENDER_CLASSIFICATIONS]).toEqual(CLASSIFICATIONS);
    expect(m.WHATSAPP_MESSAGE_ORIGINS).not.toContain("internal");
  });

  const allowed: [string, string[]][] = [
    ["inbound", ["external", "internal", "unresolved"]],
    ["crm", ["internal", "automation"]],
    ["business_app", ["internal"]],
    ["chatbot", ["automation"]],
    ["external_api", ["unresolved", "automation"]],
    ["history", ["external", "internal", "automation", "unresolved"]],
  ];

  it.each(allowed)("%s: permite exatamente %j", async (origin, classes) => {
    const m = await loadModel();
    for (const cls of CLASSIFICATIONS) {
      expect(m.isAllowedWhatsAppOriginClassification(origin, cls), `${origin} + ${cls}`).toBe(classes.includes(cls));
    }
  });

  it("valores fora do vocabulário nunca são permitidos", async () => {
    const m = await loadModel();
    for (const [origin, cls] of [["internal", "internal"], ["chatbot", "chatbot"], ["inbound", "bot"], ["", "external"], [null, "external"]]) {
      expect(m.isAllowedWhatsAppOriginClassification(origin, cls)).toBe(false);
    }
  });

  it("direção de cada origem: inbound entra; crm, business_app, chatbot e external_api saem; history pode ser qualquer uma", async () => {
    const m = await loadModel();
    expect(ORIGINS.map((o) => m.whatsappOriginDirection(o as never))).toEqual(["inbound", "outbound", "outbound", "outbound", "outbound", "either"]);
  });
});

describe("2. classificação sem inferência", () => {
  it.each([
    ["recebida de número interno (comando do advogado)", { source: "inbound", internalMatch: "internal" }, "inbound", "internal"],
    ["recebida de número externo", { source: "inbound", internalMatch: "not_internal" }, "inbound", "external"],
    ["recebida sem como comparar com as identidades internas", { source: "inbound", internalMatch: "undetermined" }, "inbound", "unresolved"],
    ["eco do aplicativo (advogado pelo celular)", { source: "business_app", internalMatch: "undetermined" }, "business_app", "internal"],
    ["saída por API sem prova", { source: "external_api", internalMatch: "undetermined" }, "external_api", "unresolved"],
    ["saída por API com correlação positiva do chatbot", { source: "external_api", internalMatch: "undetermined", trustedCorrelation: { kind: "chatbot_request", ref: "req-123" } }, "chatbot", "automation"],
    ["saída por API casada com a própria outbox (usuário)", { source: "external_api", internalMatch: "undetermined", trustedCorrelation: { kind: "crm_outbox", ref: "out-1", author: "user" } }, "crm", "internal"],
    ["saída por API casada com a própria outbox (automação)", { source: "external_api", internalMatch: "undetermined", trustedCorrelation: { kind: "crm_outbox", ref: "out-2", author: "automation" } }, "crm", "automation"],
    ["envio do CRM por usuário", { source: "crm", internalMatch: "undetermined" }, "crm", "internal"],
    ["histórico importado de número interno", { source: "history", internalMatch: "internal" }, "history", "internal"],
    ["histórico importado sem prova", { source: "history", internalMatch: "not_internal" }, "history", "unresolved"],
  ])("%s → %s + %s", async (_name, input, origin, cls) => {
    const m = await loadModel();
    expect(m.classifyWhatsAppMessage(input as never)).toEqual({ origin, senderClassification: cls });
    expect(m.isAllowedWhatsAppOriginClassification(origin, cls)).toBe(true);
  });

  it.each([
    "chatbot:abc",
    "praxis-chatbot-req-1",
    "bot_123",
    "req-123",
    "CRM-OUTBOX-1",
  ])("external_api com externalId %j e sem correlação confiável: continua external_api + unresolved", async (externalId) => {
    const m = await loadModel();
    expect(m.classifyWhatsAppMessage({ source: "external_api", internalMatch: "undetermined", externalId } as never)).toEqual({
      origin: "external_api",
      senderClassification: "unresolved",
    });
  });

  it("correlação com referência malformada não vale como prova", async () => {
    const m = await loadModel();
    for (const ref of ["", " ", "ref com espaço", "x".repeat(129), `+${PHONE}`]) {
      expect(m.classifyWhatsAppMessage({ source: "external_api", internalMatch: "undetermined", trustedCorrelation: { kind: "chatbot_request", ref } } as never)).toEqual({
        origin: "external_api",
        senderClassification: "unresolved",
      });
    }
  });

  it("o texto da mensagem nunca muda a classificação", async () => {
    const m = await loadModel();
    for (const text of ["Sou o chatbot do escritório", "Mensagem automática", "Dr. Vizentini aqui", "[bot]", ""]) {
      for (const source of ["inbound", "external_api", "business_app", "history"]) {
        const base = m.classifyWhatsAppMessage({ source, internalMatch: "not_internal" } as never);
        expect(m.classifyWhatsAppMessage({ source, internalMatch: "not_internal", text, body: text, bodyText: text } as never)).toEqual(base);
      }
    }
  });

  it("estático: a classificação não referencia texto, corpo nem o formato do externalId", () => {
    const src = readFileSync(join(process.cwd(), "src/server/whatsapp/domain-model.ts"), "utf8");
    const start = src.indexOf("export function classifyWhatsAppMessage");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\nexport ", start + 10);
    const body = src.slice(start, end === -1 ? undefined : end).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(body).not.toMatch(/\btext\b|\bbody|externalId\.|\.startsWith\(|\.includes\(|RegExp|\/\^/);
  });

  it("fonte desconhecida é recusada, nunca adivinhada", async () => {
    const m = await loadModel();
    expect(() => m.classifyWhatsAppMessage({ source: "chatbot", internalMatch: "undetermined" } as never)).toThrow();
    expect(() => m.classifyWhatsAppMessage({ source: "whatever", internalMatch: "undetermined" } as never)).toThrow();
  });

  it("lead só para inbound + external", async () => {
    const m = await loadModel();
    for (const origin of ORIGINS) {
      for (const cls of CLASSIFICATIONS) {
        expect(m.whatsappMayCreateLead(origin as never, cls as never), `${origin} + ${cls}`).toBe(origin === "inbound" && cls === "external");
      }
    }
  });
});

// ---------------------------------------------------------------------
// 3. Identidade
// ---------------------------------------------------------------------

describe("3. identidade: telefone, BSUID ou os dois — nunca nenhum", () => {
  it.each([
    ["só telefone", { kind: "phone", phoneE164: PHONE, bsuid: null }, { phoneE164: PHONE, bsuid: null }],
    ["só BSUID", { kind: "bsuid", phoneE164: null, bsuid: BSUID }, { phoneE164: null, bsuid: BSUID }],
    ["os dois", { kind: "phone_and_bsuid", phoneE164: PHONE, bsuid: BSUID }, { phoneE164: PHONE, bsuid: BSUID }],
  ])("%s", async (_name, identity, expected) => {
    const m = await loadModel();
    expect(m.whatsappIdentityKey(identity)).toEqual(expected);
  });

  it.each([
    "5511999990000",
    "551199999",
    "BR.5511999990000",
  ])("BSUID com cara de telefone (%j) continua BSUID: nenhum telefone é fabricado", async (bsuid) => {
    const m = await loadModel();
    const key = m.whatsappIdentityKey({ kind: "bsuid", phoneE164: null, bsuid });
    expect(key.phoneE164).toBeNull();
  });

  it("BSUID-only válido nunca ganha telefone, nem quando parece um número", async () => {
    const m = await loadModel();
    expect(m.whatsappIdentityKey({ kind: "bsuid", phoneE164: null, bsuid: "5511999990000" })).toEqual({ phoneE164: null, bsuid: "5511999990000" });
  });

  it.each([
    ["vazia", { kind: "phone", phoneE164: null, bsuid: null }],
    ["sem tipo", { phoneE164: null, bsuid: null }],
    ["nula", null],
    ["telefone vazio", { kind: "phone", phoneE164: "", bsuid: null }],
    ["BSUID só com espaços", { kind: "bsuid", phoneE164: null, bsuid: "   " }],
    ["telefone fora do E.164", { kind: "phone", phoneE164: "11999990000", bsuid: null }],
    ["tipo incoerente (phone com BSUID)", { kind: "phone", phoneE164: PHONE, bsuid: BSUID }],
    ["tipo incoerente (bsuid com telefone)", { kind: "bsuid", phoneE164: PHONE, bsuid: BSUID }],
    ["BSUID com espaço", { kind: "bsuid", phoneE164: null, bsuid: "BR 123" }],
  ])("identidade %s: recusada", async (_name, identity) => {
    const m = await loadModel();
    expect(() => m.whatsappIdentityKey(identity)).toThrow(expect.objectContaining({ code: "invalid_identity" }));
  });
});

// ---------------------------------------------------------------------
// 4. Conteúdo
// ---------------------------------------------------------------------

describe("4. conteúdo: texto, mídia e mídia sem texto", () => {
  it("texto exige corpo", async () => {
    const m = await loadModel();
    expect(m.validateWhatsAppMessageContent({ contentKind: "text", text: "Olá" })).toEqual({ ok: true, contentKind: "text", text: "Olá" });
    expect(m.validateWhatsAppMessageContent({ contentKind: "text", text: null })).toEqual({ ok: false, reason: "text_required" });
    expect(m.validateWhatsAppMessageContent({ contentKind: "text", text: "   " })).toEqual({ ok: false, reason: "text_required" });
  });

  it.each(["image", "video", "audio", "document", "sticker", "location", "contacts", "reaction", "unsupported", "other"])(
    "%s sem texto é aceito (texto vira null)",
    async (contentKind) => {
      const m = await loadModel();
      expect(m.validateWhatsAppMessageContent({ contentKind, text: null })).toEqual({ ok: true, contentKind, text: null });
      expect(m.validateWhatsAppMessageContent({ contentKind, text: "" })).toEqual({ ok: true, contentKind, text: null });
    },
  );

  it("mídia com legenda guarda a legenda", async () => {
    const m = await loadModel();
    expect(m.validateWhatsAppMessageContent({ contentKind: "image", text: "Foto do documento" })).toEqual({ ok: true, contentKind: "image", text: "Foto do documento" });
  });

  it("tipo desconhecido e texto longo demais são recusados", async () => {
    const m = await loadModel();
    expect(m.validateWhatsAppMessageContent({ contentKind: "hologram", text: null })).toEqual({ ok: false, reason: "invalid_content_kind" });
    expect(m.validateWhatsAppMessageContent({ contentKind: "text", text: "x".repeat(4097) })).toEqual({ ok: false, reason: "text_too_long" });
  });

  it("os tipos de conteúdo são exatamente os do contrato do adaptador", async () => {
    const m = await loadModel();
    expect([...m.WHATSAPP_CONTENT_KINDS].sort()).toEqual(
      ["text", "image", "video", "audio", "document", "sticker", "location", "contacts", "interactive", "button", "reaction", "order", "request_welcome", "template", "unsupported", "other"].sort(),
    );
  });
});

// ---------------------------------------------------------------------
// 5. Status e custo
// ---------------------------------------------------------------------

describe("5. status com accepted e custo do provedor", () => {
  it.each([
    [null, "accepted", true],
    ["accepted", "sent", true],
    ["sent", "accepted", false],
    ["accepted", "delivered", true],
    ["delivered", "read", true],
    ["read", "delivered", false],
    ["accepted", "failed", true],
    ["sent", "failed", true],
    ["failed", "delivered", true],
    ["failed", "read", true],
    ["failed", "sent", false],
    ["failed", "accepted", false],
    ["delivered", "failed", false],
    ["read", "failed", false],
    ["read", "read", false],
  ])("%s → %s: aplica? %s", async (current, incoming, applies) => {
    const m = await loadModel();
    expect(m.whatsappStatusShouldApply(current as never, incoming as never)).toBe(applies);
  });

  const estimated = { source: "provider" as const, category: "service", amount: 0.12, currency: "BRL", finality: "estimated" as const };
  const final = { source: "provider" as const, category: "service", amount: 0.1, currency: "BRL", finality: "final" as const };

  it("custo estimado nunca substitui o final; o final substitui a estimativa", async () => {
    const m = await loadModel();
    expect(m.projectWhatsAppProviderCost(final, estimated)).toEqual(final);
    expect(m.projectWhatsAppProviderCost(estimated, final)).toEqual(final);
    expect(m.projectWhatsAppProviderCost(final, null)).toEqual(final);
  });

  it("só o custo final entra no total cobrado", async () => {
    const m = await loadModel();
    expect(m.whatsappBillableCostAmount(final)).toBe(0.1);
    expect(m.whatsappBillableCostAmount(estimated)).toBe(0);
    expect(m.whatsappBillableCostAmount(null)).toBe(0);
  });

  it("custo informado junto de failed permanece estimado", async () => {
    const m = await loadModel();
    expect(m.whatsappCostForStatus("failed", final)).toEqual({ ...final, finality: "estimated" });
    expect(m.whatsappCostForStatus("delivered", final)).toEqual(final);
    expect(m.whatsappCostForStatus("failed", null)).toBeNull();
  });

  it("categoria futura bem formada é preservada; malformada vira null sem perder o valor", async () => {
    const m = await loadModel();
    expect(m.sanitizeWhatsAppProviderCost({ ...final, category: "marketing_lite_v2" })).toEqual({ ...final, category: "marketing_lite_v2" });
    expect(m.sanitizeWhatsAppProviderCost({ ...final, category: "Marketing Lite" })).toEqual({ ...final, category: null });
    expect(m.sanitizeWhatsAppProviderCost({ ...final, category: null })).toEqual({ ...final, category: null });
  });

  it.each([
    ["valor negativo", { ...final, amount: -1 }],
    ["valor não finito", { ...final, amount: Number.POSITIVE_INFINITY }],
    ["moeda malformada", { ...final, currency: "real" }],
    ["finalidade desconhecida", { ...final, finality: "charged" }],
    ["sem valor", { ...final, amount: undefined }],
  ])("custo com %s: descartado", async (_name, cost) => {
    const m = await loadModel();
    expect(m.sanitizeWhatsAppProviderCost(cost)).toBeNull();
  });

  it("estático: nenhuma tarifa fixa no modelo de domínio nem na projeção", () => {
    for (const file of ["src/server/whatsapp/domain-model.ts", "src/server/whatsapp/status-projection.ts"]) {
      const src = readFileSync(join(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(src, file).not.toMatch(/\b\d+\.\d+\b/);
      expect(src, file).not.toMatch(/tarif|price_?table|PRICING|per_message_price/i);
    }
  });
});

// ---------------------------------------------------------------------
// 6. Chave do ledger de efeitos
// ---------------------------------------------------------------------

describe("6. chave do ledger: ambiente, canal, provedor e evento — sem conteúdo", () => {
  it("só os quatro campos da chave, nada mais", async () => {
    const m = await loadModel();
    const key = m.whatsappEffectLedgerKey({
      environment: "preview",
      channelId: CHANNEL,
      provider: "ycloud",
      providerEventId: "evt-123",
      text: "Olá",
      phone: PHONE,
      bsuid: BSUID,
      payload: { a: 1 },
    } as never);
    expect(key).toEqual({ environment: "preview", channelId: CHANNEL, provider: "ycloud", providerEventId: "evt-123" });
    expect(JSON.stringify(key)).not.toMatch(/Olá|5511|BR\./);
  });

  it.each([
    ["sem ambiente", { channelId: CHANNEL, provider: "ycloud", providerEventId: "evt-1" }],
    ["ambiente desconhecido", { environment: "staging", channelId: CHANNEL, provider: "ycloud", providerEventId: "evt-1" }],
    ["canal inválido", { environment: "preview", channelId: "x", provider: "ycloud", providerEventId: "evt-1" }],
    ["provedor desconhecido", { environment: "preview", channelId: CHANNEL, provider: "twilio", providerEventId: "evt-1" }],
    ["evento com espaço", { environment: "preview", channelId: CHANNEL, provider: "ycloud", providerEventId: "evt 1" }],
    ["evento que é um telefone", { environment: "preview", channelId: CHANNEL, provider: "ycloud", providerEventId: PHONE }],
    ["evento longo demais", { environment: "preview", channelId: CHANNEL, provider: "ycloud", providerEventId: "e".repeat(129) }],
  ])("%s: recusada", async (_name, input) => {
    const m = await loadModel();
    expect(() => m.whatsappEffectLedgerKey(input as never)).toThrow(expect.objectContaining({ code: "invalid_ledger_key" }));
  });
});
