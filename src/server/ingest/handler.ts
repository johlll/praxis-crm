import type { SupabaseClient } from "@supabase/supabase-js";

import { contentHash } from "@/server/ingest/canonical";
import { IngestConfigError, getIngestConfig, usesTestAdapters } from "@/server/ingest/config";
import { clientIpFromHeaders, shouldTrustForwardedFor } from "@/server/ingest/client-ip";
import { encryptPayload, hmacIp } from "@/server/ingest/payload-crypto";
import type { EventPublisher } from "@/server/ingest/publisher";
import type { RateLimiter } from "@/server/ingest/rate-limit";
import type { TurnstileVerifier } from "@/server/ingest/turnstile";
import {
  businessContent,
  generatePublicProtocol,
  sanitizedDiagnostics,
  submissionSchema,
} from "@/server/ingest/submission";

/**
 * O fluxo da ingestão pública, separado da rota HTTP para poder ser
 * testado com adaptadores injetados (Turnstile, rate limit e publicação)
 * sem subir rede nenhuma.
 *
 * INVARIANTE DA FRONTEIRA (contrato §1): toda aceitação — evento novo,
 * repetição legítima, evento já processado, purgado ou expirado sem
 * processamento — responde EXATAMENTE igual:
 *   202 { protocol, status: "received" }
 * Nunca 200 para "já processado", nunca id interno, nunca sinal de que o
 * contato já existia. A única recusa distinta é 409 para a mesma chave
 * com conteúdo diferente.
 */

export const MAX_BODY_BYTES = 32 * 1024;

export type PublicFailure =
  | "form_endpoint_unavailable"
  | "invalid_submission"
  | "captcha_failed"
  | "rate_limited"
  | "payload_too_large"
  | "idempotency_payload_conflict"
  | "service_unavailable";

export type IngestResult =
  | { ok: true; protocol: string }
  | { ok: false; failure: PublicFailure };

export type IngestDeps = {
  supabase: SupabaseClient;
  verifyTurnstile: TurnstileVerifier;
  rateLimit: RateLimiter;
  publish: EventPublisher;
};

type EndpointConfig = {
  id: string;
  workspace_id: string;
  contract_version: number;
  turnstile_action: string;
  allowed_hostnames: string[];
};

export async function handleFormSubmission(
  endpointKey: string,
  request: Request,
  deps: IngestDeps,
): Promise<IngestResult> {
  // 1. Configuração obrigatória. Sem ela (Turnstile, rate limit, Inngest,
  //    cifra), a ingestão para AQUI — antes de ler o corpo, antes de
  //    qualquer gravação. Nunca se desliga uma proteção porque a variável
  //    faltou.
  try {
    getIngestConfig();
  } catch (error) {
    if (error instanceof IngestConfigError) return { ok: false, failure: "service_unavailable" };
    throw error;
  }

  // 2. Limite de corpo, antes de desserializar.
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, failure: "payload_too_large" };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, failure: "invalid_submission" };
  }

  // 3. Schema estrito: campo desconhecido é recusa, não "ignora e segue".
  const parsed = submissionSchema.safeParse(json);
  if (!parsed.success) return { ok: false, failure: "invalid_submission" };
  const submission = parsed.data;

  // 4. Honeypot: preenchido = robô. Mesma recusa genérica.
  if (submission.website && submission.website.trim() !== "") {
    return { ok: false, failure: "invalid_submission" };
  }

  // 5. Endpoint. Chave inexistente, chave REVOGADA e endpoint
  //    DESABILITADO são indistinguíveis daqui para fora.
  const { data: endpointData, error: endpointError } = await deps.supabase.rpc("resolve_form_endpoint", {
    p_public_key: endpointKey,
  });
  if (endpointError || !endpointData) return { ok: false, failure: "form_endpoint_unavailable" };
  const endpoint = endpointData as unknown as EndpointConfig;

  if (endpoint.contract_version !== submission.contractVersion) {
    return { ok: false, failure: "invalid_submission" };
  }

  // 6. IP: só de cabeçalho confiável da borda, nunca do corpo. Só o HMAC
  //    sai daqui.
  const ip = clientIpFromHeaders(request.headers, { trustForwardedFor: shouldTrustForwardedFor() });
  if (!ip.ok) return { ok: false, failure: "invalid_submission" };
  const ipHmac = hmacIp(ip.ip);
  const ipHmacHex = ipHmac.toString("hex");

  // 7. Rate limit antes do Turnstile: é a proteção mais barata e a que
  //    contém a enxurrada sem gastar chamada externa.
  const limited = await deps.rateLimit({ endpointId: endpoint.id, ipHmacHex });
  if (!limited.ok) return { ok: false, failure: "rate_limited" };

  // 8. Turnstile com hostname e action conferidos (não só `success`).
  //    `idempotency_key` = a própria chave da submissão: um retry da
  //    mesma submissão revalida o mesmo token sem ser punido.
  const captcha = await deps.verifyTurnstile({
    token: submission.turnstileToken,
    idempotencyKey: submission.sourceEventId,
    remoteIdentifier: ipHmacHex,
    expectedAction: endpoint.turnstile_action,
    allowedHostnames: endpoint.allowed_hostnames,
  });
  if (!captcha.ok) return { ok: false, failure: "captcha_failed" };

  // 9. Hash canônico do conteúdo de negócio e cifra do payload bruto.
  const hash = contentHash(businessContent(submission));
  const encrypted = encryptPayload(JSON.stringify(submission));

  // 10. Transação de ingestão.
  const { data: ingested, error: ingestError } = await deps.supabase.rpc("ingest_form_event", {
    p_form_endpoint_id: endpoint.id,
    p_source_event_id: submission.sourceEventId,
    p_content_hash: `\\x${hash.toString("hex")}`,
    p_public_protocol: generatePublicProtocol(),
    p_payload_ciphertext: `\\x${encrypted.ciphertext.toString("hex")}`,
    p_payload_iv: `\\x${encrypted.iv.toString("hex")}`,
    p_payload_auth_tag: `\\x${encrypted.authTag.toString("hex")}`,
    p_payload_algorithm: encrypted.algorithm,
    p_payload_key_version: encrypted.keyVersion,
    // Diagnóstico SEM PII e sem credencial: o hash do token de
    // continuidade NÃO entra aqui (conhecê-lo equivale a apresentar o
    // token — o worker o recalcula do payload decifrado), e o HMAC do IP
    // também não é persistido nesta fase.
    p_payload_sanitized: sanitizedDiagnostics(submission),
    p_occurred_at: submission.occurredAt,
  });

  if (ingestError) {
    if (ingestError.message?.includes("idempotency_payload_conflict")) {
      return { ok: false, failure: "idempotency_payload_conflict" };
    }
    if (ingestError.message?.includes("form_endpoint_unavailable")) {
      return { ok: false, failure: "form_endpoint_unavailable" };
    }
    return { ok: false, failure: "service_unavailable" };
  }

  const result = ingested as unknown as {
    protocol: string;
    created: boolean;
    webhook_event_id: string;
  };

  // 11. Publicação DEPOIS do commit. Falha aqui não desfaz nada e não
  //     muda a resposta: a outbox já está gravada e o cron recupera.
  if (result.created) {
    try {
      await deps.publish({
        webhookEventId: result.webhook_event_id,
        workspaceId: endpoint.workspace_id,
      });
    } catch {
      // Silêncio proposital: o visitante não precisa (nem deve) saber que
      // a fila está fora do ar — e o evento não se perdeu.
    }
  }

  return { ok: true, protocol: result.protocol };
}

export function isTestAdapterMode(): boolean {
  return usesTestAdapters();
}
