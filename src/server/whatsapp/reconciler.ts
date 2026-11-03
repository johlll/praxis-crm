import { NonRetriableError } from "inngest";
import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { createWhatsAppAdminSupabaseClient } from "@/server/whatsapp/admin/supabase";
import { publishWhatsAppInboxReceived, WhatsAppInboxEventError, whatsappReconciliationAttemptSchema } from "@/server/whatsapp/inbox-events";
import { whatsappInngestClient } from "@/server/whatsapp/inngest";

/**
 * Reconciliador da inbox do WhatsApp (B3.2e, docs/decisoes/b3-whatsapp-real.md
 * §28). Portão obrigatório antes de qualquer webhook real (§18.3).
 *
 * NÃO processa conteúdo e NÃO chama efeitos: encontra entradas elegíveis (no
 * banco), reserva cada uma de forma atômica, republica o evento interno
 * (`publishWhatsAppInboxReceived`, com a tentativa da reserva: `{ id:
 * inboxId:r<tentativa>, name, data: { inboxId } }`) e registra só o resultado
 * técnico. Quem faz claim, decifra, normaliza e aplica é o consumidor normal. Nada
 * aqui muda o estado de uma entrada.
 *
 * A tentativa vem do banco, atribuída atomicamente na reserva, e nunca é contada
 * aqui: a mesma reserva sempre gera o mesmo id, e uma reserva nova, um id novo,
 * que a janela de 24 horas do Inngest não descarta (§28.8).
 *
 * O token da reserva existe só nesta função, na memória, dentro do mesmo
 * `step.run`: não sai no retorno, no erro, no batimento nem no evento.
 *
 * Publicação aceita significa só isto: o Inngest aceitou. Não significa que o
 * consumidor executou; por isso a entrada continua elegível, pelo backoff, enquanto
 * o consumidor não a tratar.
 *
 * Nenhum log. Falha de uma entrada não para as outras; falha geral (banco ou
 * configuração) e rodada em que tudo falhou viram `WhatsAppReconcilerFailed`,
 * uma falha de verdade da execução, sem a mensagem original.
 */

export const WHATSAPP_RECONCILER_BATCH_LIMIT = 25;
/** Vencimento da reserva: maior que o orçamento da rodada. */
export const WHATSAPP_RECONCILER_RESERVATION_SECONDS = 120;
export const WHATSAPP_RECONCILER_PUBLISH_TIMEOUT_MS = 8_000;
/** Depois disso nada mais é publicado: o resto fica para a reserva vencer. */
export const WHATSAPP_RECONCILER_ROUND_BUDGET_MS = 90_000;

export type WhatsAppReconcilerOrigin = "inngest" | "manual_test";
export type WhatsAppReconcilerOutcome = "ok" | "partial" | "failed";

/** Retorno do step: dado puro, serializável. Só desfecho e contagens. */
export type WhatsAppReconcilerSummary = Readonly<{
  outcome: WhatsAppReconcilerOutcome;
  /** Elegíveis no início da rodada (reservadas ou não). */
  candidates: number;
  reserved: number;
  /** Publicações aceitas pelo Inngest. */
  published: number;
  /** Candidatas não reservadas (ocupadas ou além do lote), reservas perdidas antes da confirmação e as que ficaram para a reserva vencer. */
  skipped: number;
  failures: number;
}>;

export type WhatsAppReconcilerFailureCode =
  | "reconciler_not_configured"
  | "reconciler_reserve_failed"
  | "reconciler_round_failed"
  | "reconciler_heartbeat_failed";

/** Falha da rodada como FALHA da execução no Inngest, sem nova tentativa (o
 * próximo ciclo recomeça) e só com o código: nem mensagem original nem pilha. */
export class WhatsAppReconcilerFailed extends NonRetriableError {
  constructor(public readonly code: WhatsAppReconcilerFailureCode) {
    super(code);
    this.name = "WhatsAppReconcilerFailed";
    this.stack = `${this.name}: ${code}`;
  }
}

const reservationSchema = z
  .object({
    candidates: z.number().int().nonnegative(),
    entries: z
      .array(z.object({ inbox_id: uuidSchema, reservation_token: uuidSchema, reconcile_attempt: whatsappReconciliationAttemptSchema }).strict())
      .max(WHATSAPP_RECONCILER_BATCH_LIMIT),
  })
  .strict()
  .refine((v) => v.entries.length <= v.candidates);

const confirmSchema = z.object({ outcome: z.enum(["confirmed", "reservation_lost", "not_found"]) }).strict();
const recordSchema = z.object({ outcome: z.literal("recorded") }).strict();

type Entry = { inboxId: string; token: string; attempt: number };
type Admin = ReturnType<typeof createWhatsAppAdminSupabaseClient>;

/** Publica uma entrada; recusa, erro ou demora viram o código fixo. */
async function publish(entry: Entry): Promise<{ ok: true } | { ok: false; code: "inbox_event_publish_failed" | "inbox_event_not_configured" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      publishWhatsAppInboxReceived({ inboxId: entry.inboxId, reconciliationAttempt: entry.attempt }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WhatsAppInboxEventError("inbox_event_publish_failed")), WHATSAPP_RECONCILER_PUBLISH_TIMEOUT_MS);
      }),
    ]);
    return { ok: true };
  } catch (error) {
    const notConfigured = error instanceof WhatsAppInboxEventError && error.code === "inbox_event_not_configured";
    return { ok: false, code: notConfigured ? "inbox_event_not_configured" : "inbox_event_publish_failed" };
  } finally {
    clearTimeout(timer);
  }
}

async function reserve(admin: Admin): Promise<{ candidates: number; entries: Entry[] }> {
  const { data, error } = await admin.rpc("whatsapp_inbox_reconcile_reserve", {
    p_limit: WHATSAPP_RECONCILER_BATCH_LIMIT,
    p_reservation_seconds: WHATSAPP_RECONCILER_RESERVATION_SECONDS,
  });
  if (error) throw new WhatsAppReconcilerFailed("reconciler_reserve_failed");
  const parsed = reservationSchema.safeParse(data);
  if (!parsed.success) throw new WhatsAppReconcilerFailed("reconciler_reserve_failed");
  return {
    candidates: parsed.data.candidates,
    entries: parsed.data.entries.map((e) => ({ inboxId: e.inbox_id, token: e.reservation_token, attempt: e.reconcile_attempt })),
  };
}

/** Confirmação depois de uma publicação aceita. O evento já saiu: a resposta só
 * decide como a rodada conta a entrada. Nada aqui lança. */
async function confirm(admin: Admin, entry: Entry): Promise<"confirmed" | "lost" | "error"> {
  try {
    const { data, error } = await admin.rpc("whatsapp_inbox_reconcile_confirm", { p_inbox_id: entry.inboxId, p_reservation_token: entry.token });
    if (error) return "error";
    const parsed = confirmSchema.safeParse(data);
    if (!parsed.success) return "error";
    return parsed.data.outcome === "confirmed" ? "confirmed" : "lost";
  } catch {
    return "error";
  }
}

/** Melhor esforço: se o registro falhar, a reserva vence sozinha. */
async function recordFailure(admin: Admin, entry: Entry, code: "inbox_event_publish_failed" | "inbox_event_not_configured"): Promise<void> {
  try {
    await admin.rpc("whatsapp_inbox_reconcile_fail", { p_inbox_id: entry.inboxId, p_reservation_token: entry.token, p_code: code });
  } catch {
    // Sem log: a reserva vence e a entrada volta a ser elegível.
  }
}

async function recordRun(startedAt: string, origin: WhatsAppReconcilerOrigin, summary: WhatsAppReconcilerSummary): Promise<boolean> {
  try {
    const { data, error } = await createWhatsAppAdminSupabaseClient().rpc("whatsapp_reconciler_record_run", {
      p_origin: origin,
      p_started_at: startedAt,
      p_outcome: summary.outcome,
      p_candidates: summary.candidates,
      p_reserved: summary.reserved,
      p_published: summary.published,
      p_skipped: summary.skipped,
      p_failures: summary.failures,
    });
    return !error && recordSchema.safeParse(data).success;
  } catch {
    return false;
  }
}

const FAILED_BEFORE_ANY_WORK: WhatsAppReconcilerSummary = { outcome: "failed", candidates: 0, reserved: 0, published: 0, skipped: 0, failures: 0 };

/**
 * Uma rodada inteira: no máximo 25 entradas, cada uma reservada, publicada e
 * confirmada. Devolve o resumo quando a rodada terminou `ok` ou `partial`; lança
 * `WhatsAppReconcilerFailed` na falha geral, depois de tentar gravar o batimento.
 */
export async function runWhatsAppInboxReconcilerRound(origin: WhatsAppReconcilerOrigin): Promise<WhatsAppReconcilerSummary> {
  const startMs = Date.now();
  const startedAt = new Date(startMs).toISOString();

  // Sem a chave própria nada sai: não reserva, para não gastar tentativas à toa.
  try {
    whatsappInngestClient();
  } catch {
    await recordRun(startedAt, origin, FAILED_BEFORE_ANY_WORK);
    throw new WhatsAppReconcilerFailed("reconciler_not_configured");
  }

  let admin: Admin;
  let reservation: { candidates: number; entries: Entry[] };
  try {
    admin = createWhatsAppAdminSupabaseClient();
    reservation = await reserve(admin);
  } catch {
    await recordRun(startedAt, origin, FAILED_BEFORE_ANY_WORK);
    throw new WhatsAppReconcilerFailed("reconciler_reserve_failed");
  }

  const { candidates, entries } = reservation;
  let published = 0;
  let failures = 0;
  let skipped = candidates - entries.length;

  for (const entry of entries) {
    if (Date.now() - startMs > WHATSAPP_RECONCILER_ROUND_BUDGET_MS) {
      skipped += 1;
      continue;
    }
    const result = await publish(entry);
    if (!result.ok) {
      failures += 1;
      await recordFailure(admin, entry, result.code);
      continue;
    }
    published += 1;
    const confirmation = await confirm(admin, entry);
    if (confirmation === "lost") skipped += 1;
    else if (confirmation === "error") failures += 1;
  }

  const reserved = entries.length;
  const everyEntryFailed = reserved > 0 && failures === reserved;
  const incomplete = failures > 0 || (reserved > 0 && published + failures < reserved);
  const summary: WhatsAppReconcilerSummary = {
    outcome: everyEntryFailed ? "failed" : incomplete ? "partial" : "ok",
    candidates,
    reserved,
    published,
    skipped,
    failures,
  };

  const recorded = await recordRun(startedAt, origin, summary);
  if (summary.outcome === "failed") throw new WhatsAppReconcilerFailed("reconciler_round_failed");
  if (!recorded) throw new WhatsAppReconcilerFailed("reconciler_heartbeat_failed");
  return summary;
}
