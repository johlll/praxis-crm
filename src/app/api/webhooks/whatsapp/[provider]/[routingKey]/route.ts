import { handleWhatsAppWebhookRequest } from "@/server/whatsapp/webhook-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook de WhatsApp (B3.2c). Pública: sem sessão, autenticada pela
 * assinatura com o segredo do canal da routing key. O tratamento inteiro
 * está em `handleWhatsAppWebhookRequest`; sem provedor habilitado neste
 * ambiente (hoje, em Preview e Production), responde 404 sem tocar no banco.
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string; routingKey: string }> }) {
  const { provider, routingKey } = await params;
  return handleWhatsAppWebhookRequest(request, { provider, routingKey });
}
