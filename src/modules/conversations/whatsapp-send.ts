import { toUserMessage } from "@/lib/errors";
import {
  adminGetWhatsAppSendContext,
  WhatsAppOutboundError,
  type ReserveContent,
  type WhatsAppSendContext,
  type WhatsAppSendTemplateOption,
} from "@/server/whatsapp/admin/outbound";
import { isWhatsAppEnvironmentConfigured } from "@/server/whatsapp/environment";
import { sendWhatsAppHumanMessage, type HumanSendResult } from "@/server/whatsapp/outbound";

import { mapSendMessageResult } from "./queries";
import type { SendMessageActionResult } from "./actions";

/**
 * Saída humana pela outbox do WhatsApp (B3.3, docs/decisoes/b3-whatsapp-real.md
 * §28.18), vista da camada de conversas. NÃO é Server Action (sem "use server"):
 * quem chama é `sendMessageAction`/`sendWhatsAppTemplateAction`, DEPOIS de
 * `conversation.send` ter sido verificada na sessão. Workspace e usuário vêm
 * só dessa verificação.
 *
 * Conversa de canal legado da A7 não passa por aqui (`handled: false`) e segue
 * pelo `send_message` da A7, como antes.
 */

/** O que a tela precisa para o compositor do canal real. Serializável. */
export type WhatsAppSendUi = Extract<WhatsAppSendContext, { route: "b3" }>;
export type { WhatsAppSendTemplateOption };

type Session = { workspaceId: string; actorUserId: string };

/** Contexto de envio da conversa para a página; `null` = caminho legado da A7. */
export async function loadWhatsAppSendUi(session: Session, conversationId: string): Promise<WhatsAppSendUi | null> {
  if (!isWhatsAppEnvironmentConfigured()) return null;
  try {
    const context = await adminGetWhatsAppSendContext({ ...session, conversationId });
    return context.route === "b3" ? context : null;
  } catch {
    return null;
  }
}

function failure(code: string): { ok: false; error: string } {
  return { ok: false, error: toUserMessage({ message: code }) };
}

function toActionResult(result: HumanSendResult): SendMessageActionResult {
  const mapped = mapSendMessageResult(result.row as unknown as Record<string, unknown>);

  if (result.row.content_conflict) {
    // A MESMA chave com outro conteúdo: devolve o que foi REALMENTE gravado.
    return {
      ok: false,
      error: "Esta tentativa de envio já tinha sido registrada com outro conteúdo — a mensagem realmente enviada foi recuperada.",
      conflict: true,
      persisted: mapped.message,
    };
  }
  if (result.state === "rejected") {
    return { ...failure(result.errorCode ?? "send_rejected"), persisted: mapped.message };
  }
  if (result.state === "uncertain") {
    return { ...failure("send_uncertain"), persisted: mapped.message };
  }
  // accepted, ou ainda em andamento (reserved/sending): a mensagem persistida manda.
  return { ok: true, message: mapped.message, duplicateSubmit: mapped.duplicateSubmit };
}

export type RoutedSend = { handled: false } | { handled: true; result: SendMessageActionResult };

export async function sendViaWhatsAppOutbox(
  session: Session & { conversationId: string; clientDedupeKey: string; content: ReserveContent },
): Promise<RoutedSend> {
  if (!isWhatsAppEnvironmentConfigured()) return { handled: false };

  try {
    const context = await adminGetWhatsAppSendContext({
      workspaceId: session.workspaceId,
      actorUserId: session.actorUserId,
      conversationId: session.conversationId,
    });
    if (context.route !== "b3") return { handled: false };
    const result = await sendWhatsAppHumanMessage({ ...session, context });
    return { handled: true, result: toActionResult(result) };
  } catch (error) {
    // Sem ambiente assinado no banco, a conversa segue o caminho da A7 (que
    // recusa canal da B3 por conta própria).
    if (error instanceof WhatsAppOutboundError && error.code === "whatsapp_environment_required") return { handled: false };
    // Só o código simbólico vira texto; nenhuma mensagem original, conteúdo ou credencial.
    return { handled: true, result: failure(error instanceof WhatsAppOutboundError ? error.code : "unknown") };
  }
}
