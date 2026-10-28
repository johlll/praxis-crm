import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import type { WhatsAppEnvironment } from "@/server/whatsapp/environment";
import {
  whatsappContactIdentity,
  type NormalizedMessageStatus,
  type ProviderReportedCost,
  type WhatsAppContentKind,
  type WhatsAppOriginCandidate,
  type WhatsAppProviderKind,
} from "@/server/whatsapp/provider/contract";
import { projectWhatsAppMessageStatus, projectWhatsAppProviderCost } from "@/server/whatsapp/status-projection";

/**
 * Modelo do domínio do WhatsApp sobre a A7 (B3.2d-2b1,
 * docs/decisoes/b3-whatsapp-real.md §21): contratos PUROS que a B3.2d-2b2
 * (RPCs atômicas dos efeitos) vai usar. Nada aqui fala com o banco nem com
 * o provedor.
 *
 * Os mesmos vocabulários e regras estão no banco
 * (20261028120100_b3_2d2b1_whatsapp_domain_model.sql); os testes conferem os
 * dois lados.
 */

export class WhatsAppDomainError extends Error {
  constructor(public readonly code: "invalid_identity" | "invalid_ledger_key" | "invalid_source") {
    super(code);
    this.name = "WhatsAppDomainError";
  }
}

// ---------------------------------------------------------------------
// Origem técnica e classificação do remetente — SEPARADAS
// ---------------------------------------------------------------------

/** `internal` nunca é origem: é classificação do remetente. */
export const WHATSAPP_MESSAGE_ORIGINS = ["inbound", "crm", "business_app", "chatbot", "external_api", "history"] as const;
export type WhatsAppMessageOrigin = (typeof WHATSAPP_MESSAGE_ORIGINS)[number];

export const WHATSAPP_SENDER_CLASSIFICATIONS = ["external", "internal", "automation", "unresolved"] as const;
export type WhatsAppSenderClassification = (typeof WHATSAPP_SENDER_CLASSIFICATIONS)[number];

/** Combinações permitidas (igual à restrição `messages_origin_classification`). */
export const WHATSAPP_ALLOWED_CLASSIFICATIONS: Readonly<Record<WhatsAppMessageOrigin, readonly WhatsAppSenderClassification[]>> = {
  inbound: ["external", "internal", "unresolved"],
  crm: ["internal", "automation"],
  business_app: ["internal"],
  chatbot: ["automation"],
  external_api: ["unresolved", "automation"],
  history: ["external", "internal", "automation", "unresolved"],
};

const ORIGINS: ReadonlySet<string> = new Set(WHATSAPP_MESSAGE_ORIGINS);

export function isAllowedWhatsAppOriginClassification(origin: unknown, classification: unknown): boolean {
  if (typeof origin !== "string" || !ORIGINS.has(origin) || typeof classification !== "string") return false;
  return (WHATSAPP_ALLOWED_CLASSIFICATIONS[origin as WhatsAppMessageOrigin] as readonly string[]).includes(classification);
}

/** Direção de cada origem (igual à restrição `messages_origin_direction`). */
export function whatsappOriginDirection(origin: WhatsAppMessageOrigin): "inbound" | "outbound" | "either" {
  if (origin === "inbound") return "inbound";
  if (origin === "history") return "either";
  return "outbound";
}

/** Prova POSITIVA e confiável da origem, vinda do próprio sistema (a outbox
 * do CRM ou um pedido registrado do chatbot) — nunca do provedor. */
export type WhatsAppTrustedCorrelation =
  | { kind: "chatbot_request"; ref: string }
  | { kind: "crm_outbox"; ref: string; author: "user" | "automation" };

/** Resultado do casamento do remetente com as identidades internas ativas
 * do canal. `undetermined`: não dá para comparar (ex.: só um BSUID e
 * identidades internas só com telefone). */
export type WhatsAppInternalMatch = "internal" | "not_internal" | "undetermined";

const CORRELATION_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validCorrelation(value: WhatsAppTrustedCorrelation | null | undefined): WhatsAppTrustedCorrelation | null {
  if (!value || typeof value.ref !== "string" || !CORRELATION_REF.test(value.ref)) return null;
  if (value.kind === "chatbot_request") return value;
  if (value.kind === "crm_outbox" && (value.author === "user" || value.author === "automation")) return value;
  return null;
}

/**
 * Origem e classificação de uma mensagem a partir do CAMINHO pelo qual ela
 * chegou, do casamento com as identidades internas e de uma correlação
 * confiável. Nunca lê o texto da mensagem, e o `externalId` do provedor é
 * só um valor opaco: o formato dele nunca prova quem enviou.
 *  - recebida: interna → inbound/internal; externa → inbound/external; sem
 *    como comparar → inbound/unresolved;
 *  - eco do aplicativo do escritório → business_app/internal;
 *  - saída por API: chatbot SÓ com correlação positiva com um pedido do
 *    chatbot; casada com a própria outbox → crm; sem prova →
 *    external_api/unresolved;
 *  - envio do CRM → crm/internal (usuário) ou crm/automation;
 *  - histórico importado: interna → internal; senão unresolved.
 */
export function classifyWhatsAppMessage(input: {
  source: WhatsAppOriginCandidate | "crm" | "history";
  internalMatch: WhatsAppInternalMatch;
  trustedCorrelation?: WhatsAppTrustedCorrelation | null;
  externalId?: string | null;
}): { origin: WhatsAppMessageOrigin; senderClassification: WhatsAppSenderClassification } {
  const correlation = validCorrelation(input.trustedCorrelation);
  switch (input.source) {
    case "inbound":
      return {
        origin: "inbound",
        senderClassification:
          input.internalMatch === "internal" ? "internal" : input.internalMatch === "not_internal" ? "external" : "unresolved",
      };
    case "business_app":
      return { origin: "business_app", senderClassification: "internal" };
    case "external_api":
      if (correlation?.kind === "chatbot_request") return { origin: "chatbot", senderClassification: "automation" };
      if (correlation?.kind === "crm_outbox") {
        return { origin: "crm", senderClassification: correlation.author === "automation" ? "automation" : "internal" };
      }
      return { origin: "external_api", senderClassification: "unresolved" };
    case "crm":
      return {
        origin: "crm",
        senderClassification: correlation?.kind === "crm_outbox" && correlation.author === "automation" ? "automation" : "internal",
      };
    case "history":
      return { origin: "history", senderClassification: input.internalMatch === "internal" ? "internal" : "unresolved" };
    default:
      throw new WhatsAppDomainError("invalid_source");
  }
}

/** Lead só para inbound + external (igual a `private.whatsapp_may_create_lead`). */
export function whatsappMayCreateLead(origin: WhatsAppMessageOrigin, classification: WhatsAppSenderClassification): boolean {
  return origin === "inbound" && classification === "external";
}

// ---------------------------------------------------------------------
// Identidade
// ---------------------------------------------------------------------

export type WhatsAppIdentityKey = Readonly<{ phoneE164: string | null; bsuid: string | null }>;

/**
 * Telefone, BSUID ou os dois — nunca nenhum. O tipo declarado tem de bater
 * com os campos, e cada identificador presente tem de ser válido (falha
 * fechada). Nenhum telefone é derivado do BSUID, nem quando ele parece um
 * número.
 */
export function whatsappIdentityKey(identity: unknown): WhatsAppIdentityKey {
  if (typeof identity !== "object" || identity === null) throw new WhatsAppDomainError("invalid_identity");
  const { kind, phoneE164, bsuid } = identity as Record<string, unknown>;
  const phone = typeof phoneE164 === "string" ? phoneE164 : phoneE164 == null ? null : undefined;
  const id = typeof bsuid === "string" ? bsuid : bsuid == null ? null : undefined;
  if (phone === undefined || id === undefined) throw new WhatsAppDomainError("invalid_identity");
  const checked = whatsappContactIdentity({ phoneE164: phone, bsuid: id });
  if (!checked) throw new WhatsAppDomainError("invalid_identity");
  // Vazio é ausência só para quem não declarou o identificador.
  if ((phone !== null && checked.phoneE164 === null) || (id !== null && checked.bsuid === null)) {
    throw new WhatsAppDomainError("invalid_identity");
  }
  if (kind !== checked.kind) throw new WhatsAppDomainError("invalid_identity");
  return Object.freeze({ phoneE164: checked.phoneE164, bsuid: checked.bsuid });
}

// ---------------------------------------------------------------------
// Conteúdo
// ---------------------------------------------------------------------

export const WHATSAPP_CONTENT_KINDS = [
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contacts",
  "interactive",
  "button",
  "reaction",
  "order",
  "request_welcome",
  "template",
  "unsupported",
  "other",
] as const satisfies readonly WhatsAppContentKind[];

const CONTENT_KINDS: ReadonlySet<string> = new Set(WHATSAPP_CONTENT_KINDS);
const MAX_TEXT = 4096;

/** Texto exige corpo; mídia e os demais tipos aceitam ficar sem texto
 * (legenda vazia vira null). */
export function validateWhatsAppMessageContent(input: {
  contentKind: string;
  text: string | null;
}): { ok: true; contentKind: WhatsAppContentKind; text: string | null } | { ok: false; reason: "invalid_content_kind" | "text_required" | "text_too_long" } {
  if (!CONTENT_KINDS.has(input.contentKind)) return { ok: false, reason: "invalid_content_kind" };
  const text = typeof input.text === "string" && input.text.trim() !== "" ? input.text : null;
  if (input.contentKind === "text" && text === null) return { ok: false, reason: "text_required" };
  if (text !== null && text.length > MAX_TEXT) return { ok: false, reason: "text_too_long" };
  return { ok: true, contentKind: input.contentKind as WhatsAppContentKind, text };
}

// ---------------------------------------------------------------------
// Status e custo (regra da B3.2a, §1.3)
// ---------------------------------------------------------------------

export { projectWhatsAppMessageStatus, projectWhatsAppProviderCost };

/** Igual a `private.whatsapp_message_status_should_apply`. */
export function whatsappStatusShouldApply(current: NormalizedMessageStatus | null, incoming: NormalizedMessageStatus): boolean {
  return projectWhatsAppMessageStatus(current, incoming).changed;
}

const CURRENCY = /^[A-Z]{3}$/;
const CATEGORY = /^[a-z][a-z0-9_]{0,63}$/;

/** Custo informado pelo provedor, conferido. Categoria futura bem formada é
 * preservada; malformada vira null sem perder o valor. Valor, moeda ou
 * finalidade inválidos descartam o custo inteiro. */
export function sanitizeWhatsAppProviderCost(input: unknown): ProviderReportedCost | null {
  if (typeof input !== "object" || input === null) return null;
  const { amount, currency, category, finality } = input as Record<string, unknown>;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
  if (typeof currency !== "string" || !CURRENCY.test(currency)) return null;
  if (finality !== "estimated" && finality !== "final") return null;
  return {
    source: "provider",
    category: typeof category === "string" && CATEGORY.test(category) ? category : null,
    amount,
    currency,
    finality,
  };
}

/** Mensagem que falhou não é cobrada: o custo que vier fica estimativa. */
export function whatsappCostForStatus(status: NormalizedMessageStatus, cost: ProviderReportedCost | null): ProviderReportedCost | null {
  if (cost === null) return null;
  return status === "failed" && cost.finality === "final" ? { ...cost, finality: "estimated" } : cost;
}

/** Só o custo final entra no total cobrado. */
export function whatsappBillableCostAmount(cost: ProviderReportedCost | null): number {
  return cost?.finality === "final" ? cost.amount : 0;
}

// ---------------------------------------------------------------------
// Ledger de efeitos
// ---------------------------------------------------------------------

export type WhatsAppEffectLedgerKey = Readonly<{
  environment: WhatsAppEnvironment;
  channelId: string;
  provider: WhatsAppProviderKind;
  providerEventId: string;
}>;

const ledgerKeySchema = z.object({
  environment: z.enum(["production", "preview"]),
  channelId: uuidSchema,
  provider: z.enum(["simulated", "ycloud", "meta"]),
  providerEventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
});

/** Chave do ledger: ambiente, canal, provedor e id estável do evento — e
 * nada mais. Qualquer outro campo (texto, telefone, BSUID, payload) é
 * descartado. */
export function whatsappEffectLedgerKey(input: unknown): WhatsAppEffectLedgerKey {
  const parsed = ledgerKeySchema.safeParse(input);
  if (!parsed.success) throw new WhatsAppDomainError("invalid_ledger_key");
  const { environment, channelId, provider, providerEventId } = parsed.data;
  return Object.freeze({ environment, channelId: channelId.toLowerCase(), provider, providerEventId });
}
