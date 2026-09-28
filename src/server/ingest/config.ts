import { z } from "zod";

/**
 * Configuração da ingestão pública (A11) — validada SEPARADAMENTE de
 * `src/server/env.ts`, e só no caminho que realmente a usa.
 *
 * Por que separada: `getEnv()` roda em praticamente toda página. Se as
 * variáveis da A11 entrassem lá como obrigatórias, um ambiente que ainda
 * não as tem (exatamente o caso de hoje: Turnstile, Upstash e Inngest
 * ainda não configurados) derrubaria o aplicativo inteiro, não só a
 * captação. Aqui, a ausência derruba apenas `/api/forms/*` e os jobs —
 * que é o comportamento pedido: falha FECHADA e sanitizada, nunca
 * proteção desligada em silêncio.
 *
 * Adaptadores falsos existem só para teste e para desenvolvimento local
 * explicitamente marcado. Em produção e preview eles são RECUSADOS mesmo
 * que a variável esteja presente.
 */

export class IngestConfigError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Configuração de ingestão ausente ou inválida: ${missing.join(", ")}`);
    this.name = "IngestConfigError";
  }
}

const base64Key32 = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    let decoded: Buffer;
    try {
      decoded = Buffer.from(value, "base64");
    } catch {
      ctx.addIssue({ code: "custom", message: "não é base64 válido" });
      return z.NEVER;
    }
    if (decoded.length !== 32) {
      ctx.addIssue({ code: "custom", message: "precisa decodificar para 32 bytes" });
      return z.NEVER;
    }
    return decoded;
  });

const payloadKeyVersions = z.string().transform((value, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "não é JSON válido" });
    return z.NEVER;
  }
  const result = z.record(z.string(), z.object({ cipher: base64Key32 })).safeParse(parsed);
  if (!result.success) {
    ctx.addIssue({ code: "custom", message: "formato inválido" });
    return z.NEVER;
  }
  return result.data;
});

const schema = z
  .object({
    SUPABASE_SECRET_KEY: z.string().min(1),
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    A11_PAYLOAD_ACTIVE_KEY_VERSION: z.string().min(1),
    A11_PAYLOAD_KEY_VERSIONS: payloadKeyVersions,
    A11_IP_HMAC_KEY: base64Key32,
    TURNSTILE_SECRET_KEY: z.string().min(1),
    UPSTASH_REDIS_REST_URL: z.string().url(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
    INNGEST_EVENT_KEY: z.string().min(1),
    INNGEST_SIGNING_KEY: z.string().min(1),
    CRON_SECRET: z.string().min(16),
  })
  .refine((env) => env.A11_PAYLOAD_ACTIVE_KEY_VERSION in env.A11_PAYLOAD_KEY_VERSIONS, {
    message: "A11_PAYLOAD_ACTIVE_KEY_VERSION precisa existir em A11_PAYLOAD_KEY_VERSIONS",
    path: ["A11_PAYLOAD_ACTIVE_KEY_VERSION"],
  });

export type IngestConfig = z.infer<typeof schema>;

/**
 * `test-adapters` substitui Turnstile, rate limit e Inngest por
 * adaptadores em memória. NUNCA vale em produção nem em preview: lá, a
 * variável é simplesmente ignorada e a configuração real continua
 * obrigatória.
 */
export function usesTestAdapters(): boolean {
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "production" || vercelEnv === "preview") return false;
  return process.env.A11_INGEST_MODE === "test-adapters";
}

let cached: IngestConfig | undefined;

export function getIngestConfig(): IngestConfig {
  if (cached) return cached;

  const parsed = schema.safeParse({
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    A11_PAYLOAD_ACTIVE_KEY_VERSION: process.env.A11_PAYLOAD_ACTIVE_KEY_VERSION,
    A11_PAYLOAD_KEY_VERSIONS: process.env.A11_PAYLOAD_KEY_VERSIONS,
    A11_IP_HMAC_KEY: process.env.A11_IP_HMAC_KEY,
    TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    INNGEST_EVENT_KEY: process.env.INNGEST_EVENT_KEY,
    INNGEST_SIGNING_KEY: process.env.INNGEST_SIGNING_KEY,
    CRON_SECRET: process.env.CRON_SECRET,
  });

  if (!parsed.success) {
    // Só o NOME do campo — nunca o valor, que pode ser fragmento de chave.
    throw new IngestConfigError(parsed.error.issues.map((issue) => issue.path.join(".")));
  }

  cached = parsed.data;
  return cached;
}

/** Só para teste: descarta o cache entre casos. */
export function resetIngestConfigCache(): void {
  cached = undefined;
}

/**
 * Cifra o payload bruto. Separada de `getIngestConfig()` porque é a
 * primeira coisa exigida: sem chave (ou com versão desconhecida), a
 * ingestão para ANTES de qualquer gravação — o payload nunca chega ao
 * banco em claro.
 */
export function getPayloadKey(version: string): Buffer {
  const config = getIngestConfig();
  const entry = config.A11_PAYLOAD_KEY_VERSIONS[version];
  if (!entry) {
    throw new IngestConfigError([`A11_PAYLOAD_KEY_VERSIONS.${version}`]);
  }
  return entry.cipher;
}
