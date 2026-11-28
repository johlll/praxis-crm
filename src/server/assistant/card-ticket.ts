import { createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/server/env";

/**
 * Vínculo do cartão de cadastro do Assistente com quem o abriu (docs/decisoes/assistente.md).
 *
 * O servidor emite, junto com cada cartão, um comprovante assinado (HMAC-SHA256) que amarra a chave da
 * solicitação à pessoa e ao escritório ativos NAQUELE momento. Na confirmação, o servidor confere o
 * comprovante contra a sessão ATUAL: se o escritório ativo mudou (inclusive por outra aba) ou a sessão é
 * de outra pessoa, a confirmação é recusada sem gravar em escritório nenhum.
 *
 * A chave de assinatura é derivada do segredo do cookie de escritório ativo, com rótulo próprio: não
 * exige configuração nova, e um comprovante nunca serve como cookie (nem o contrário).
 */

const LABEL = "praxis.assistant.card-ticket.v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CardBinding = { userId: string; workspaceId: string; requestId: string };
export type CardTicketCheck = "ok" | "workspace_changed" | "invalid";

function key(): Buffer {
  return createHmac("sha256", getEnv().WORKSPACE_ACTIVE_COOKIE_SECRET).update(LABEL).digest();
}

function mac({ userId, workspaceId, requestId }: CardBinding): Buffer {
  return createHmac("sha256", key()).update(`${userId}|${workspaceId}|${requestId}`).digest();
}

/** Comprovante do cartão: `<escritório>.<assinatura>`. O escritório vai à vista só para explicar a recusa. */
export function issueCardTicket(binding: CardBinding): string {
  return `${binding.workspaceId}.${mac(binding).toString("hex")}`;
}

/** Confere o comprovante contra a sessão atual. Nunca confia no escritório escrito nele sem a assinatura. */
export function verifyCardTicket(ticket: string, current: CardBinding): CardTicketCheck {
  const separator = ticket.lastIndexOf(".");
  if (separator <= 0) return "invalid";
  const workspaceId = ticket.slice(0, separator);
  const signature = Buffer.from(ticket.slice(separator + 1), "hex");
  if (!UUID_RE.test(workspaceId)) return "invalid";

  // A assinatura cobre a pessoa e a solicitação ATUAIS: emitido para outra pessoa ou outra chave, não bate.
  const expected = mac({ ...current, workspaceId });
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return "invalid";
  // Autêntico, mas emitido em outro escritório: a troca aconteceu depois que o cartão foi aberto.
  return workspaceId === current.workspaceId ? "ok" : "workspace_changed";
}
