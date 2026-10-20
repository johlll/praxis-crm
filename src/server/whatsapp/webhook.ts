import type {
  NormalizedWhatsAppEvent,
  NormalizeEventsResult,
  WebhookVerificationInput,
  WebhookVerificationResult,
  WhatsAppProvider,
} from "@/server/whatsapp/provider/contract";

/**
 * Entrada do webhook de WhatsApp em três etapas separadas (B3.1, revisão da
 * PR #42):
 *  1. `readWhatsAppWebhookBody` lê os BYTES exatos da requisição, com
 *     limite de tamanho, sem decodificar;
 *  2. o adaptador confere a assinatura sobre esses bytes;
 *  3. só o corpo devolvido pela etapa 2 é decodificado e normalizado.
 *
 * A rota real do webhook (e a resolução do canal pela routing key) é da
 * B3.2; aqui fica só o caminho que ela vai usar.
 */

export const WHATSAPP_WEBHOOK_MAX_BYTES = 256 * 1024;

export type ReadWebhookBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "payload_too_large" | "unreadable" };

export async function readWhatsAppWebhookBody(
  request: Request,
  options: { maxBytes?: number } = {},
): Promise<ReadWebhookBodyResult> {
  const maxBytes = options.maxBytes ?? WHATSAPP_WEBHOOK_MAX_BYTES;

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared.trim())) return { ok: false, reason: "unreadable" };
    if (Number(declared) > maxBytes) return { ok: false, reason: "payload_too_large" };
  }
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };

  // Conta os bytes enquanto lê: o Content-Length pode faltar ou mentir.
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "payload_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export type WebhookPipelineResult =
  | { ok: true; events: NormalizedWhatsAppEvent[] }
  | { ok: false; stage: "signature"; reason: Extract<WebhookVerificationResult, { ok: false }>["reason"] }
  | { ok: false; stage: "normalize"; reason: Extract<NormalizeEventsResult, { ok: false }>["reason"] };

/** Etapas 2 e 3: a normalização nem é chamada se a assinatura falhar. */
export function verifyAndNormalizeWhatsAppWebhook(
  adapter: WhatsAppProvider,
  input: WebhookVerificationInput,
): WebhookPipelineResult {
  const verification = adapter.verifyWebhook(input);
  if (!verification.ok) return { ok: false, stage: "signature", reason: verification.reason };

  const normalized = adapter.normalizeEvents(verification.verified);
  if (!normalized.ok) return { ok: false, stage: "normalize", reason: normalized.reason };
  return { ok: true, events: normalized.events };
}
