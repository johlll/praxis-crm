import { randomBytes } from "node:crypto";
import { z } from "zod";

import { dddFromE164, normalizeEmail, normalizePhone, toE164BR } from "@/server/ingest/canonical";

/**
 * Contrato público da submissão (A11) — validado com Zod ANTES da cifra
 * (na borda) e DE NOVO depois de decifrar (no worker). O worker nunca
 * confia no que foi gravado: se algo mudou no banco, o esquema recusa.
 */

const trimmed = (max: number) => z.string().trim().max(max);

export const submissionSchema = z
  .object({
    // Gerado no navegador com crypto.randomUUID(), uma vez por submissão.
    sourceEventId: z.string().uuid(),
    contractVersion: z.number().int().min(1),
    // Data declarada pelo cliente. A normalização (e o clamp) acontece no
    // banco, a partir de received_at — aqui só se exige que seja uma data
    // válida: data inválida é recusada ANTES da ingestão (contrato §3).
    occurredAt: z.iso.datetime({ offset: true }),
    turnstileToken: trimmed(4096).min(1),
    // Honeypot: precisa chegar vazio. Preenchido = robô.
    website: trimmed(200).optional(),
    contact: z.object({
      name: trimmed(160).min(1),
      type: z.enum(["pf", "pj"]).default("pf"),
      email: trimmed(320).optional(),
      phone: trimmed(40).optional(),
      city: trimmed(120).optional(),
      uf: trimmed(2).optional(),
    }),
    answers: z.record(z.string().max(60), z.union([z.string().max(2000), z.boolean(), z.number()])).default({}),
    attribution: z
      .object({
        channel: trimmed(40).optional(),
        source: trimmed(120).optional(),
        medium: trimmed(120).optional(),
        campaign: trimmed(160).optional(),
        content: trimmed(160).optional(),
        term: trimmed(160).optional(),
        gclid: trimmed(200).optional(),
        fbclid: trimmed(200).optional(),
        landingUrl: trimmed(600).optional(),
        referrer: trimmed(600).optional(),
      })
      .default({}),
    consent: z
      .object({
        decision: z.enum(["granted", "refused"]),
        textVersion: trimmed(40).optional(),
        acceptedText: trimmed(4000).optional(),
      })
      .optional(),
    // Token opaco de continuidade, quando o visitante veio de um link
    // próprio. Telefone e e-mail NUNCA fazem esse papel.
    continuityToken: trimmed(128).optional(),
    externalIdentity: z
      .object({ provider: trimmed(40).min(1), externalId: trimmed(200).min(1) })
      .optional(),
  })
  .strict();

export type Submission = z.infer<typeof submissionSchema>;

/**
 * O que entra no hash de conteúdo: só o conteúdo de NEGÓCIO. Fora ficam
 * token do Turnstile, honeypot, IP, cabeçalhos e a própria chave
 * idempotente (contrato §2).
 */
export function businessContent(submission: Submission) {
  return {
    contact: {
      name: submission.contact.name,
      type: submission.contact.type,
      email: submission.contact.email ? normalizeEmail(submission.contact.email) : undefined,
      phone: submission.contact.phone ? normalizePhone(submission.contact.phone) : undefined,
      city: submission.contact.city,
      uf: submission.contact.uf?.toUpperCase(),
    },
    answers: submission.answers,
    attribution: submission.attribution,
    consent: submission.consent ? { decision: submission.consent.decision, textVersion: submission.consent.textVersion } : undefined,
    continuity: submission.continuityToken ? "present" : undefined,
    externalIdentity: submission.externalIdentity,
  } as const;
}

/**
 * Diagnóstico SEM PII (contrato §6). Nunca telefone completo, e-mail
 * completo, CPF, resposta livre ou conteúdo de mensagem: só formato,
 * tamanho e presença.
 */
export function sanitizedDiagnostics(submission: Submission) {
  const email = submission.contact.email ? normalizeEmail(submission.contact.email) : undefined;
  const phone = submission.contact.phone ? toE164BR(submission.contact.phone) : null;
  return {
    contract_version: submission.contractVersion,
    answers_count: Object.keys(submission.answers).length,
    answers_total_length: Object.values(submission.answers).reduce<number>(
      (total, value) => total + String(value).length,
      0,
    ),
    name_length: submission.contact.name.length,
    contact_type: submission.contact.type,
    has_email: Boolean(email),
    // Só o domínio — nunca a parte local, que identifica a pessoa.
    email_domain: email?.split("@")[1] ?? null,
    has_phone: Boolean(phone),
    // Só o DDD, nunca o número.
    phone_ddd: dddFromE164(phone),
    phone_length: phone?.length ?? null,
    has_consent: Boolean(submission.consent),
    consent_decision: submission.consent?.decision ?? null,
    has_continuity_token: Boolean(submission.continuityToken),
    has_external_identity: Boolean(submission.externalIdentity),
    uf: submission.contact.uf?.toUpperCase() ?? null,
  };
}

/**
 * O que o worker manda para a RPC: só os campos necessários, já
 * normalizados. Nada além disso cruza a fronteira.
 */
export function workerInput(
  submission: Submission,
  extras: { continuityTokenHashBase64: string | null; ipHmacBase64: string | null },
) {
  // E.164 de verdade: número que não dá para normalizar com segurança
  // vira null, nunca um palpite de código de país.
  const phone = submission.contact.phone ? toE164BR(submission.contact.phone) : null;
  const answersSummary = Object.entries(submission.answers)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");

  return {
    contact: {
      name: submission.contact.name,
      type: submission.contact.type,
      email: submission.contact.email ? normalizeEmail(submission.contact.email) : null,
      phone_e164: phone,
      city: submission.contact.city ?? null,
      uf: submission.contact.uf?.toUpperCase() ?? null,
    },
    attribution: {
      channel: submission.attribution.channel ?? "formulario",
      source: submission.attribution.source ?? null,
      medium: submission.attribution.medium ?? null,
      campaign: submission.attribution.campaign ?? null,
      content: submission.attribution.content ?? null,
      term: submission.attribution.term ?? null,
      gclid: submission.attribution.gclid ?? null,
      fbclid: submission.attribution.fbclid ?? null,
      landing_url: submission.attribution.landingUrl ?? null,
      referrer: submission.attribution.referrer ?? null,
    },
    consent: submission.consent
      ? {
          decision: submission.consent.decision,
          channel: "email",
          legal_basis: "consentimento",
          purpose: "Contato a partir de formulário público",
          text_version: submission.consent.textVersion ?? null,
          accepted_text: submission.consent.acceptedText ?? null,
          evidence: { contract_version: submission.contractVersion },
        }
      : undefined,
    continuity_token_hash: extras.continuityTokenHashBase64,
    external_identity: submission.externalIdentity
      ? { provider: submission.externalIdentity.provider, external_id: submission.externalIdentity.externalId }
      : undefined,
    summary: answersSummary || null,
    ip_hmac: extras.ipHmacBase64,
  };
}

/** Protocolo público opaco: aleatório, sem relação com o id interno. */
export function generatePublicProtocol(): string {
  return randomBytes(18).toString("base64url");
}

/** Chave pública do endpoint: opaca, 32 bytes. */
export function generateEndpointPublicKey(): string {
  return randomBytes(24).toString("base64url");
}
