import { uuidSchema } from "@/lib/uuid";
import { adminResolveWhatsAppWebhookRoute, WhatsAppChannelStoreError } from "@/server/whatsapp/admin/channels";
import { isWhatsAppEnvironmentConfigured } from "@/server/whatsapp/environment";
import { storeWhatsAppWebhookDelivery, WhatsAppInboxError } from "@/server/whatsapp/inbox";
import { publishWhatsAppInboxReceived } from "@/server/whatsapp/inbox-events";
import { resolveWhatsAppProvider } from "@/server/whatsapp/provider";
import type { WhatsAppProviderKind } from "@/server/whatsapp/provider/contract";
import { readWhatsAppWebhookBody } from "@/server/whatsapp/webhook";

/**
 * Rota pública do webhook de WhatsApp (B3.2c, docs/decisoes/b3-whatsapp-real.md
 * §18): `POST /api/webhooks/whatsapp/[provider]/[webhookRouteId]`.
 *
 * Ordem, sem atalho:
 *  1. provedor da URL habilitado neste ambiente, com ambiente do WhatsApp
 *     configurado, e localizador que seja um UUID (senão 404, sem banco);
 *  2. bytes EXATOS do corpo, com limite (413);
 *  3. canal pelo localizador OPACO da URL (`webhook_route_id`, UUID
 *     aleatório do canal), no ambiente autenticado (404 para desconhecido,
 *     desativado ou de outro ambiente). O segredo do webhook é por canal:
 *     por isso o canal vem antes da assinatura, e por isso o localizador
 *     está na URL, nunca no corpo ainda não autenticado. A routing key real
 *     só existe por dentro: nunca na URL, na resposta ou no evento;
 *  4. assinatura sobre os bytes, com o segredo DESSE canal (401 igual para
 *     toda falha). O localizador não autentica nada;
 *  5. inspeção mínima do envelope e gravação na inbox cifrada (B3.2b);
 *  6. evento interno `{ inboxId }`, com id = id da inbox, só para canal
 *     ativo e nunca em conflito. Falha aqui não desfaz a gravação: a
 *     entrada fica pendente, durável, para o reconciliador (B3.2e).
 *
 * Nada aqui normaliza o evento, cria contato, lead ou conversa, envia
 * mensagem ou escreve log. As respostas só levam um código fixo.
 */

const KINDS: ReadonlySet<string> = new Set<WhatsAppProviderKind>(["simulated", "ycloud", "meta"]);

/** Caminho do webhook de um canal: provedor + localizador opaco. Nunca
 * WABA, telefone ou routing key. */
export function whatsappWebhookPath(params: { provider: WhatsAppProviderKind; webhookRouteId: string }): string {
  if (!KINDS.has(params.provider)) throw new RangeError("invalid_whatsapp_provider");
  const parsed = uuidSchema.safeParse(params.webhookRouteId);
  if (!parsed.success) throw new RangeError("invalid_webhook_route_id");
  return `/api/webhooks/whatsapp/${params.provider}/${parsed.data.toLowerCase()}`;
}

type Failure = "not_found" | "payload_too_large" | "unreadable" | "invalid_signature" | "invalid_payload" | "service_unavailable";

const STATUS: Record<Failure, number> = {
  not_found: 404,
  payload_too_large: 413,
  unreadable: 400,
  invalid_signature: 401,
  invalid_payload: 400,
  service_unavailable: 503,
};

const NO_STORE = { "cache-control": "no-store" };

function fail(failure: Failure): Response {
  return Response.json({ error: failure }, { status: STATUS[failure], headers: NO_STORE });
}

function received(): Response {
  return Response.json({ status: "received" }, { status: 200, headers: NO_STORE });
}

/** Erros da resolução que significam "este canal não existe para este
 * webhook". O resto (banco, cifra) é indisponibilidade: o provedor tenta de
 * novo. */
const RESOLUTION_NOT_FOUND: ReadonlySet<string> = new Set([
  "channel_not_found",
  "channel_environment_mismatch",
  "channel_context_mismatch",
  "provider_mismatch",
  "whatsapp_provider_unavailable",
]);

const STORE_INVALID_PAYLOAD: ReadonlySet<string> = new Set([
  "invalid_payload",
  "unsupported_envelope_version",
  "inbox_batch_not_supported",
  "invalid_inbox_event",
]);

export async function handleWhatsAppWebhookRequest(
  request: Request,
  params: { provider: string; webhookRouteId: string },
): Promise<Response> {
  try {
    // 1. Desligado → 404 sem banco.
    if (!KINDS.has(params.provider)) return fail("not_found");
    const provider = params.provider as WhatsAppProviderKind;
    if (!isWhatsAppEnvironmentConfigured()) return fail("not_found");
    if (resolveWhatsAppProvider({ channelProvider: provider }).status !== "enabled") return fail("not_found");
    const routeId = uuidSchema.safeParse(params.webhookRouteId);
    if (!routeId.success) return fail("not_found");

    // 2. Bytes exatos.
    const body = await readWhatsAppWebhookBody(request);
    if (!body.ok) return fail(body.reason === "payload_too_large" ? "payload_too_large" : "unreadable");

    // 3. Canal pelo localizador opaco, antes da assinatura (o segredo é do canal).
    let resolved;
    try {
      resolved = await adminResolveWhatsAppWebhookRoute({ provider, webhookRouteId: routeId.data });
    } catch (error) {
      if (error instanceof WhatsAppChannelStoreError && RESOLUTION_NOT_FOUND.has(error.code)) return fail("not_found");
      return fail("service_unavailable");
    }
    if (!resolved) return fail("not_found");

    // 4. Assinatura sobre os bytes, com o segredo desse canal.
    const verification = resolved.adapter.verifyWebhook({
      rawBody: body.bytes,
      headers: request.headers,
      secret: resolved.webhookSecret,
      nowMs: Date.now(),
    });
    if (!verification.ok) {
      if (verification.reason === "body_too_large") return fail("payload_too_large");
      if (verification.reason === "invalid_secret" || verification.reason === "unsupported") return fail("service_unavailable");
      return fail("invalid_signature");
    }

    // 5. Inspeção mínima e inbox cifrada.
    let stored;
    try {
      stored = await storeWhatsAppWebhookDelivery({ channel: resolved.channel, adapter: resolved.adapter, verified: verification.verified });
    } catch (error) {
      if (error instanceof WhatsAppInboxError) {
        if (STORE_INVALID_PAYLOAD.has(error.code)) return fail("invalid_payload");
        if (error.code === "channel_not_found") return fail("not_found");
      }
      return fail("service_unavailable");
    }

    // 6. Evento interno: canal ativo, nunca em conflito. A falha não desfaz
    // a gravação; a entrada fica pendente para o reconciliador (B3.2e).
    if (stored.outcome !== "conflict" && resolved.status === "active") {
      try {
        await publishWhatsAppInboxReceived({ inboxId: stored.inboxId });
      } catch {
        // Sem log: o estado durável está na inbox.
      }
    }
    return received();
  } catch {
    return fail("service_unavailable");
  }
}
