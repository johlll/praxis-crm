import type { SupabaseClient } from "@supabase/supabase-js";

import { answersConfigSchema, buildAnswersSchema, EMPTY_ANSWERS_CONFIG } from "@/modules/forms/schema";
import { contentHash } from "@/server/ingest/canonical";
import { matchAllowedOrigin } from "@/server/ingest/cors";
import { IngestConfigError, getIngestConfig, usesTestAdapters } from "@/server/ingest/config";
import { clientIpFromHeaders, shouldTrustForwardedFor } from "@/server/ingest/client-ip";
import { encryptPayload, hmacIp } from "@/server/ingest/payload-crypto";
import { logInvalidSubmission, sanitizeZodIssues } from "@/server/ingest/observability";
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
  | "origin_not_allowed"
  | "form_endpoint_misconfigured"
  | "service_unavailable";

export type IngestResult =
  | { ok: true; protocol: string; corsOrigin: string | null }
  | { ok: false; failure: PublicFailure; corsOrigin: string | null };

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
  answers_config: unknown;
};

/**
 * Resolve o endpoint só pela CHAVE da URL — sem depender do corpo. Usado
 * tanto pelo preflight (OPTIONS, que não tem corpo) quanto pelo início
 * do POST, para que a decisão de CORS exista mesmo quando a submissão
 * falha por outro motivo (tamanho, schema, honeypot).
 */
export async function resolveEndpointForCors(
  supabase: SupabaseClient,
  endpointKey: string,
): Promise<EndpointConfig | null> {
  const { data, error } = await supabase.rpc("resolve_form_endpoint", { p_public_key: endpointKey });
  if (error || !data) return null;
  return data as unknown as EndpointConfig;
}

export async function handleFormSubmission(
  endpointKey: string,
  request: Request,
  deps: IngestDeps,
): Promise<IngestResult> {
  // 1. Configuração obrigatória. Sem ela (Turnstile, rate limit, Inngest,
  //    cifra), a ingestão para AQUI — antes de ler o corpo, antes de
  //    qualquer gravação. Nunca se desliga uma proteção porque a variável
  //    faltou. Sem configuração não há como resolver nada com segurança,
  //    então também não há CORS a oferecer.
  try {
    getIngestConfig();
  } catch (error) {
    if (error instanceof IngestConfigError) return { ok: false, failure: "service_unavailable", corsOrigin: null };
    throw error;
  }

  // 2. Endpoint resolvido JÁ AQUI (só pela chave da URL, sem corpo): é o
  //    que permite que TODA resposta daqui para frente — sucesso ou
  //    qualquer recusa — carregue os cabeçalhos de CORS corretos para uma
  //    origem autorizada, não só a resposta de sucesso.
  const endpoint = await resolveEndpointForCors(deps.supabase, endpointKey);
  const corsOrigin = endpoint
    ? matchAllowedOrigin(request.headers.get("origin"), endpoint.allowed_hostnames)
    : null;
  if (!endpoint) return { ok: false, failure: "form_endpoint_unavailable", corsOrigin };

  // 2b. `Origin` PRESENTE e não autorizado é recusado AQUI, antes de ler
  //     o corpo ou gravar qualquer coisa (defeito corrigido — item 7 da
  //     auditoria pós-dry-run): o CORS do navegador só impede o JS de LER
  //     a resposta, nunca impede o SERVIDOR de processar a requisição —
  //     um cliente que não é navegador (curl, outro site postando via
  //     <form> sem fetch) pode forjar um `Origin` qualquer, e antes desta
  //     recusa o evento era gravado normalmente mesmo vindo de uma
  //     origem fora da lista do endpoint. Sem `Origin` (chamada
  //     servidor-a-servidor) continua permitida — CORS é mecanismo de
  //     navegador, e a ausência do cabeçalho nunca é tratada como origem
  //     inválida.
  const originHeader = request.headers.get("origin");
  if (originHeader && !corsOrigin) {
    return { ok: false, failure: "origin_not_allowed", corsOrigin };
  }

  // 3. Limite de corpo, antes de desserializar.
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, failure: "payload_too_large", corsOrigin };
  }

  const logContext = { form_endpoint_id: endpoint.id, workspace_id: endpoint.workspace_id };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    logInvalidSubmission("json_parse_error", logContext);
    return { ok: false, failure: "invalid_submission", corsOrigin };
  }

  // 4. Schema estrito: campo desconhecido é recusa, não "ignora e segue".
  const parsed = submissionSchema.safeParse(json);
  if (!parsed.success) {
    logInvalidSubmission("schema_validation_failed", logContext, {
      issues: sanitizeZodIssues(parsed.error.issues),
    });
    return { ok: false, failure: "invalid_submission", corsOrigin };
  }
  const submission = parsed.data;

  // 5. Honeypot: preenchido = robô. Mesma recusa genérica.
  if (submission.website && submission.website.trim() !== "") {
    logInvalidSubmission("honeypot_filled", logContext);
    return { ok: false, failure: "invalid_submission", corsOrigin };
  }

  if (endpoint.contract_version !== submission.contractVersion) {
    logInvalidSubmission("contract_version_mismatch", logContext, {
      expected: endpoint.contract_version,
      received: submission.contractVersion,
    });
    return { ok: false, failure: "invalid_submission", corsOrigin };
  }

  // 5b. `answers` só pode conter os campos que o ENDPOINT configura:
  //     campo desconhecido, obrigatório ausente ou tipo/tamanho errado
  //     são recusados aqui — a borda nunca aceita e guarda "o que der".
  //
  //     Config AUSENTE (`answers_config` nulo — endpoint que nunca
  //     configurou campo nenhum) é um `{fields: []}` LEGÍTIMO. Config
  //     PRESENTE mas que não passa no MESMO schema usado na tela de
  //     configuração é CORRUPÇÃO — nunca vira `{fields: []}` em silêncio
  //     (defeito corrigido — item 4 da auditoria pós-dry-run: a borda
  //     aceitava a submissão como se o endpoint não tivesse campo nenhum
  //     configurado, mascarando o problema em vez de falhar fechada).
  const answersConfigResult = answersConfigSchema.safeParse(endpoint.answers_config ?? EMPTY_ANSWERS_CONFIG);
  if (!answersConfigResult.success) {
    return { ok: false, failure: "form_endpoint_misconfigured", corsOrigin };
  }
  const answersConfig = answersConfigResult.data;
  const answersResult = buildAnswersSchema(answersConfig).safeParse(submission.answers);
  if (!answersResult.success) {
    logInvalidSubmission("answers_schema_validation_failed", logContext, {
      issues: sanitizeZodIssues(answersResult.error.issues),
    });
    return { ok: false, failure: "invalid_submission", corsOrigin };
  }

  // 6. IP: só de cabeçalho confiável da borda, nunca do corpo. Só o HMAC
  //    sai daqui.
  const ip = clientIpFromHeaders(request.headers, { trustForwardedFor: shouldTrustForwardedFor() });
  if (!ip.ok) {
    logInvalidSubmission("client_ip_unresolved", logContext, { header_reason: ip.reason });
    return { ok: false, failure: "invalid_submission", corsOrigin };
  }
  const ipHmac = hmacIp(ip.ip);
  const ipHmacHex = ipHmac.toString("hex");

  // 7. Rate limit antes do Turnstile: é a proteção mais barata e a que
  //    contém a enxurrada sem gastar chamada externa.
  const limited = await deps.rateLimit({ endpointId: endpoint.id, ipHmacHex });
  if (!limited.ok) return { ok: false, failure: "rate_limited", corsOrigin };

  // 8. Turnstile com hostname e action conferidos (não só `success`). A
  //    chave de idempotência do siteverify é derivada do PRÓPRIO TOKEN,
  //    dentro do verificador — nunca do IP (que nunca é enviado à
  //    Cloudflare, nem como HMAC) nem do sourceEventId (que ficaria
  //    estável mesmo quando o token muda).
  const captcha = await deps.verifyTurnstile({
    token: submission.turnstileToken,
    expectedAction: endpoint.turnstile_action,
    allowedHostnames: endpoint.allowed_hostnames,
  });
  if (!captcha.ok) return { ok: false, failure: "captcha_failed", corsOrigin };

  // 9. Hash canônico do conteúdo de negócio e cifra do payload bruto.
  const hash = contentHash(businessContent(submission));
  const encrypted = encryptPayload(JSON.stringify(submission));

  // 10. Transação de ingestão. `answers_config_snapshot` fotografa a
  //     configuração vigente AGORA — é contra ELA (não contra uma edição
  //     posterior do endpoint) que o worker revalida antes de processar.
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
    p_answers_config_snapshot: answersConfig,
  });

  if (ingestError) {
    if (ingestError.message?.includes("idempotency_payload_conflict")) {
      return { ok: false, failure: "idempotency_payload_conflict", corsOrigin };
    }
    if (ingestError.message?.includes("form_endpoint_unavailable")) {
      return { ok: false, failure: "form_endpoint_unavailable", corsOrigin };
    }
    return { ok: false, failure: "service_unavailable", corsOrigin };
  }

  const result = ingested as unknown as {
    protocol: string;
    created: boolean;
    webhook_event_id: string;
    outbox_id: string | null;
  };

  // 11. Publicação DEPOIS do commit. Falha aqui não desfaz nada e não
  //     muda a resposta: a outbox já está gravada e o cron recupera —
  //     mas o RESULTADO da tentativa inicial precisa refletir na outbox
  //     (defeito corrigido: antes, nem sucesso nem falha marcavam nada,
  //     deixando a linha sempre "pending" até o cron reconciliar por
  //     acaso ou o evento ser processado por outro caminho).
  if (result.created && result.outbox_id) {
    try {
      await deps.publish({
        webhookEventId: result.webhook_event_id,
        workspaceId: endpoint.workspace_id,
      });
      await deps.supabase.rpc("mark_outbox_published", { p_outbox_id: result.outbox_id });
    } catch {
      // Silêncio proposital para o VISITANTE: ele não precisa (nem deve)
      // saber que a fila está fora do ar — o evento não se perdeu. Mas a
      // outbox precisa saber, para que o cron reconcilie sem esperar o
      // próximo lock expirar.
      await deps.supabase.rpc("mark_outbox_failed", {
        p_outbox_id: result.outbox_id,
        p_error_code: "initial_publish_failed",
      });
    }
  }

  return { ok: true, protocol: result.protocol, corsOrigin };
}

export function isTestAdapterMode(): boolean {
  return usesTestAdapters();
}
