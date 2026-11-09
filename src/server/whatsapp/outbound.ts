import {
  adminBeginWhatsAppOutboxSend,
  adminFinishWhatsAppOutboxSend,
  adminGetWhatsAppSendContext,
  adminReserveWhatsAppSend,
  WhatsAppOutboundError,
  type OutboxOutcome,
  type OutboxSnapshot,
  type ReserveContent,
  type WhatsAppSendContext,
} from "@/server/whatsapp/admin/outbound";
import { adminReadWhatsAppSendCredential } from "@/server/whatsapp/admin/channels";
import { whatsappContactIdentity, type SendResult } from "@/server/whatsapp/provider/contract";
import { resolveWhatsAppProvider } from "@/server/whatsapp/provider";

/**
 * Envio humano pelo CRM (B3.3, docs/decisoes/b3-whatsapp-real.md §28.18), em
 * duas fases:
 *
 *  1. RESERVA no banco: papel, acesso, consentimento, canal ativo com envio
 *     habilitado, janela ou template utility aprovado, idempotência por
 *     `clientDedupeKey`. Grava a mensagem do CRM (`queued`) e a outbox.
 *  2. CHAMADA ao provedor, no máximo UMA por intenção: o banco inicia a
 *     tentativa (`begin`) e registra o desfecho (`finish`).
 *
 * Resultado incerto (exceção, tempo esgotado, processo que some no meio) NUNCA é
 * reenviado: a intenção fica `uncertain` e só uma nova intenção, com nova chave,
 * por decisão humana, envia de novo. Nenhum log: nada de conteúdo, telefone ou
 * credencial sai daqui, e os erros são códigos simbólicos.
 *
 * O adaptador é escolhido pelo provedor GRAVADO NO CANAL; `WHATSAPP_PROVIDER`
 * só o habilita. O simulado não usa rede. O da YCloud (§28.19) recebe a chave de
 * API do canal, lida só aqui, DEPOIS do `begin` e ANTES da rede: sem chave,
 * sem envio habilitado ou sem template aprovado e utility, a intenção é
 * recusada sem nenhuma chamada. Mesmo assim, o portão do banco continua
 * recusando ligar o envio de canal YCloud (`whatsapp_enable_channel_send`).
 */

export type HumanSendParams = {
  workspaceId: string;
  actorUserId: string;
  conversationId: string;
  clientDedupeKey: string;
  content: ReserveContent;
  /** Contexto já lido por quem decidiu a rota; sem ele, é lido aqui. */
  context?: WhatsAppSendContext;
};

export type HumanSendResult = {
  state: OutboxSnapshot["state"];
  errorCode: string | null;
  /** Registro da mensagem como foi realmente persistido (mesmas chaves do `send_message` da A7). */
  row: OutboxSnapshot;
};

/** Código de rejeição do provedor como código simbólico seguro. */
function safeRejectionCode(code: string): string {
  const normalized = code.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return /^[a-z]/.test(normalized) ? normalized : "send_rejected";
}

function outcomeOf(result: SendResult): OutboxOutcome {
  if (result.ok) return { outcome: "accepted", providerMessageId: result.providerMessageId };
  if (result.reason === "rejected") return { outcome: "rejected", errorCode: safeRejectionCode(result.errorCode) };
  if (result.reason === "uncertain") return { outcome: "uncertain" };
  return { outcome: "rejected", errorCode: "send_unsupported" };
}

function isApprovedUtilityTemplate(context: Extract<WhatsAppSendContext, { route: "b3" }>, content: { name: string; language: string }): boolean {
  return context.templates.some((t) => t.name === content.name && t.language === content.language);
}

function done(snapshot: OutboxSnapshot): HumanSendResult {
  return { state: snapshot.state, errorCode: snapshot.error_code, row: snapshot };
}

export async function sendWhatsAppHumanMessage(params: HumanSendParams): Promise<HumanSendResult> {
  const actor = { workspaceId: params.workspaceId, actorUserId: params.actorUserId };

  const context = params.context ?? (await adminGetWhatsAppSendContext({ ...actor, conversationId: params.conversationId }));
  // Canal legado da A7 não passa por aqui (a tela usa o caminho da A7).
  if (context.route !== "b3") throw new WhatsAppOutboundError("conversation_not_found");

  // O adaptador é o do provedor GRAVADO no canal; desligado, nada é gravado.
  const resolution = resolveWhatsAppProvider({ channelProvider: context.provider });
  if (resolution.status !== "enabled") throw new WhatsAppOutboundError("whatsapp_provider_unavailable");
  const adapter = resolution.provider;

  // Fase 1: reserva (idempotente por intenção).
  const reserved = await adminReserveWhatsAppSend({
    ...actor,
    conversationId: params.conversationId,
    clientDedupeKey: params.clientDedupeKey,
    content: params.content,
  });
  // Repetição de uma intenção que já avançou: devolve o estado, sem nova chamada.
  if (reserved.state !== "reserved") return done(reserved);
  // Conteúdo diferente com a mesma chave: nunca é tratado como sucesso.
  if (reserved.content_conflict) return done(reserved);

  // Fase 2: no máximo uma tentativa.
  const begin = await adminBeginWhatsAppOutboxSend(reserved.outbox_id);
  if (begin.outcome !== "begin") return done(begin.snapshot);

  let outcome: OutboxOutcome;
  const capabilities = adapter.describeCapabilities();
  const recipient = whatsappContactIdentity({ phoneE164: begin.recipientPhone });
  if (adapter.kind !== begin.provider || !recipient) {
    outcome = { outcome: "rejected", errorCode: "recipient_unavailable" };
  } else if (begin.content.kind === "text" ? !capabilities.sendText : !capabilities.sendTemplate) {
    outcome = { outcome: "rejected", errorCode: "send_unsupported" };
  } else if (begin.content.kind === "template" && !isApprovedUtilityTemplate(context, begin.content)) {
    // Defesa em profundidade: só chega à rede o template que a leitura do
    // contexto listou como aprovado e utility (o banco já recusou os demais).
    outcome = { outcome: "rejected", errorCode: "template_not_approved" };
  } else {
    // Chave do canal (só provedores com rede). Qualquer falha aqui acontece
    // ANTES da chamada: recusada, nunca incerta.
    let credential: string | undefined;
    let credentialOk = true;
    if (adapter.kind !== "simulated") {
      try {
        credential = await adminReadWhatsAppSendCredential({
          workspaceId: params.workspaceId,
          channelId: begin.channelId,
          provider: begin.provider,
          routingKey: begin.routingKey,
        });
      } catch {
        credentialOk = false;
      }
    }

    if (!credentialOk) {
      outcome = { outcome: "rejected", errorCode: "credential_unavailable" };
    } else {
      try {
        const result =
          begin.content.kind === "text"
            ? await adapter.sendText({ routingKey: begin.routingKey, recipient, text: begin.content.text, correlationId: reserved.outbox_id, credential })
            : await adapter.sendTemplate({
                routingKey: begin.routingKey,
                recipient,
                templateName: begin.content.name,
                templateLanguage: begin.content.language,
                parameters: begin.content.params,
                correlationId: reserved.outbox_id,
                credential,
              });
        outcome = outcomeOf(result);
      } catch {
        // A chamada pode ter chegado ao provedor: incerto, nunca reenviado.
        outcome = { outcome: "uncertain" };
      }
    }
  }

  try {
    return done(await adminFinishWhatsAppOutboxSend(reserved.outbox_id, outcome));
  } catch {
    if (outcome.outcome === "accepted") {
      // O provedor aceitou, mas o banco não registrou: tenta registrar como incerta.
      try {
        return done(await adminFinishWhatsAppOutboxSend(reserved.outbox_id, { outcome: "uncertain" }));
      } catch {
        // Sem registro: a lease vence e a próxima leitura a marca como incerta.
      }
    }
    throw new WhatsAppOutboundError("send_result_unconfirmed");
  }
}
