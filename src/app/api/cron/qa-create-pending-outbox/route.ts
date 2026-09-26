import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { contentHash } from "@/server/ingest/canonical";
import { IngestConfigError, getIngestConfig } from "@/server/ingest/config";
import { encryptPayload } from "@/server/ingest/payload-crypto";
import { businessContent, generatePublicProtocol, submissionSchema } from "@/server/ingest/submission";
import { createAdminSupabaseClient } from "@/server/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * FIXTURE TEMPORÁRIA DE QA — nunca mesclada em `main`.
 *
 * Existe só para provar o reconciliador de outbox (`resolve_stale_outbox_
 * batch` / `claim_outbox_batch`) contra um evento com ciphertext REAL,
 * decifrável pela mesma rotina do worker, sem depender da chave ativa do
 * Preview (mascarada, inacessível fora do runtime da Vercel) e sem usar a
 * rota pública `/api/forms/[endpointKey]` — que, ao ter sucesso, já
 * republica inline e marca a outbox como `published` na mesma requisição,
 * o que impediria o reconciliador de ter algo pendente para reivindicar.
 *
 * Reaproveita exatamente a mesma função de cifra (`encryptPayload`), o
 * mesmo schema (`submissionSchema`), o mesmo hash de conteúdo
 * (`contentHash`/`businessContent`) e a mesma RPC oficial
 * (`ingest_form_event`) que a ingestão real usa — a ÚNICA diferença
 * deliberada é que esta rota NUNCA chama o publicador: para depois do
 * `ingest_form_event`, exatamente o ponto que o reconciliador existe
 * para recuperar.
 *
 * Nunca retorna nem loga payload, ciphertext, IV, auth tag, chave ou
 * qualquer segredo — só os identificadores estruturais (uuid) que o
 * próprio `ingest_form_event` já devolveria.
 */

const QA_FORM_ENDPOINT_ID = "1053f02c-1b90-474c-9b67-17c251b3fbd0"; // "QA A11 Rate Limit" — answers_config vazio

function authorized(request: Request): boolean {
  let secret: string;
  try {
    secret = getIngestConfig().CRON_SECRET;
  } catch (error) {
    if (error instanceof IngestConfigError) return false;
    throw error;
  }
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (process.env.VERCEL_ENV !== "preview") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const suffix = randomUUID().slice(0, 8);
  const nowIso = new Date().toISOString();

  const parsed = submissionSchema.safeParse({
    sourceEventId: randomUUID(),
    contractVersion: 1,
    occurredAt: nowIso,
    turnstileToken: "qa-fixture-nao-verificado-de-verdade",
    contact: { name: `QA Outbox Reconciler ${suffix}`, type: "pf" },
    answers: {},
    attribution: { channel: "formulario" },
    consent: {
      decision: "granted",
      textVersion: "qa-fixture-v1",
      acceptedText: "Aceito o contato para fins de teste de QA (fixture temporária de reconciliador de outbox).",
    },
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "fixture_schema_invalid" }, { status: 500 });
  }
  const submission = parsed.data;

  const supabase = createAdminSupabaseClient();
  const hash = contentHash(businessContent(submission));
  const encrypted = encryptPayload(JSON.stringify(submission));

  const { data: ingested, error: ingestError } = await supabase.rpc("ingest_form_event", {
    p_form_endpoint_id: QA_FORM_ENDPOINT_ID,
    p_source_event_id: submission.sourceEventId,
    p_content_hash: `\\x${hash.toString("hex")}`,
    p_public_protocol: generatePublicProtocol(),
    p_payload_ciphertext: `\\x${encrypted.ciphertext.toString("hex")}`,
    p_payload_iv: `\\x${encrypted.iv.toString("hex")}`,
    p_payload_auth_tag: `\\x${encrypted.authTag.toString("hex")}`,
    p_payload_algorithm: encrypted.algorithm,
    p_payload_key_version: encrypted.keyVersion,
    p_payload_sanitized: {},
    p_occurred_at: submission.occurredAt,
    p_answers_config_snapshot: { fields: [] },
  });

  if (ingestError || !ingested) {
    return NextResponse.json({ error: "ingest_failed" }, { status: 503 });
  }

  const result = ingested as unknown as {
    webhook_event_id: string;
    outbox_id: string | null;
    created: boolean;
  };

  // Deliberadamente SEM publicador aqui: é o ponto inteiro desta fixture.
  return NextResponse.json({
    webhook_event_id: result.webhook_event_id,
    outbox_id: result.outbox_id,
    created: result.created,
  });
}
