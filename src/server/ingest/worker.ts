import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptPayload } from "@/server/ingest/payload-crypto";
import { submissionSchema, workerInput } from "@/server/ingest/submission";

/**
 * Worker da A11 (contrato §6 e §7).
 *
 * Sequência, sem atalho:
 *   1. roda só no servidor, com o cliente administrativo;
 *   2. lê o ciphertext gravado;
 *   3. seleciona a chave pela VERSÃO da linha (não pela ativa);
 *   4. decifra em MEMÓRIA;
 *   5. valida de novo com Zod — nunca confia no que está gravado;
 *   6. normaliza;
 *   7. manda para a RPC só os campos necessários;
 *   8. nunca persiste plaintext temporário;
 *   9. nunca manda plaintext para log, auditoria, erro ou Sentry.
 *
 * Eventos já processados, purgados ou vencidos sem processamento voltam
 * sem efeito nenhum — a própria RPC decide isso sob lock.
 */

export type WorkerOutcome =
  | { status: "processed"; alreadyProcessed: boolean }
  | { status: "ineligible"; reason: string }
  | { status: "failed"; code: string };

type EventPayload = {
  id: string;
  status: string;
  ciphertext: string | null;
  iv: string | null;
  auth_tag: string | null;
  algorithm: string | null;
  key_version: string | null;
};

/**
 * Lê o evento por FUNÇÃO, nunca por SELECT direto: as tabelas da A11 são
 * deny-all e todo acesso passa por função — inclusive o do cliente
 * administrativo, que poderia ignorar a RLS.
 */
async function loadEvent(
  supabase: SupabaseClient,
  webhookEventId: string,
): Promise<EventPayload | null> {
  const { data, error } = await supabase.rpc("get_webhook_event_payload", {
    p_webhook_event_id: webhookEventId,
  });
  if (error) throw new Error("event_load_failed");
  return (data as unknown as EventPayload | null) ?? null;
}

export async function processWebhookEvent(
  supabase: SupabaseClient,
  webhookEventId: string,
): Promise<WorkerOutcome> {
  const event = await loadEvent(supabase, webhookEventId);
  if (!event) return { status: "ineligible", reason: "not_found" };

  if (event.status === "processed") {
    return { status: "processed", alreadyProcessed: true };
  }
  if (event.status === "expired_unprocessed" || event.status === "purged") {
    return { status: "ineligible", reason: event.status };
  }

  if (!event.ciphertext || !event.iv || !event.auth_tag || !event.algorithm || !event.key_version) {
    // Sem payload não há o que processar: ou já foi limpo pela retenção,
    // ou a linha está incompleta. Nunca "processa pela metade".
    return { status: "ineligible", reason: "payload_unavailable" };
  }

  let plaintext: string;
  try {
    plaintext = decryptPayload({
      ciphertext: Buffer.from(event.ciphertext, "base64"),
      iv: Buffer.from(event.iv, "base64"),
      authTag: Buffer.from(event.auth_tag, "base64"),
      algorithm: event.algorithm,
      keyVersion: event.key_version,
    });
  } catch {
    // Nunca inclui o erro original: ele poderia carregar fragmento do
    // conteúdo. Só o código.
    return { status: "failed", code: "decrypt_failed" };
  }

  // Valida DE NOVO, depois de decifrar.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(plaintext);
  } catch {
    return { status: "failed", code: "payload_not_json" };
  }
  const parsed = submissionSchema.safeParse(parsedJson);
  if (!parsed.success) return { status: "failed", code: "payload_schema_invalid" };

  const submission = parsed.data;

  // O hash do token de continuidade é calculado AQUI, a partir do
  // plaintext — nunca lido de uma coluna de diagnóstico (conhecer o hash
  // equivaleria a apresentar o token).
  const continuityTokenHashBase64 = submission.continuityToken
    ? createHash("sha256").update(submission.continuityToken, "utf8").digest().toString("base64")
    : null;

  const { data, error } = await supabase.rpc("process_form_event", {
    p_webhook_event_id: webhookEventId,
    p_input: workerInput(submission, {
      continuityTokenHashBase64,
      // HMAC do IP não é persistido nesta fase (política padrão do
      // contrato §11: só com permissão explícita).
      ipHmacBase64: null,
    }),
  });

  if (error) return { status: "failed", code: "process_failed" };

  const result = data as unknown as {
    already_processed?: boolean;
    ineligible?: boolean;
    status?: string;
  };
  if (result?.ineligible) {
    return { status: "ineligible", reason: result.status ?? "ineligible" };
  }

  return { status: "processed", alreadyProcessed: Boolean(result?.already_processed) };
}
