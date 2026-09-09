import { z } from "zod";

/**
 * Validação das variáveis de ambiente na borda (falha cedo, com mensagem
 * clara, em vez de um `undefined` silencioso vazando para dentro do
 * `@supabase/ssr` e virando um erro de rede confuso). Nenhum valor é
 * logado — só o nome da variável ausente, no máximo.
 */

// base64 de exatamente 32 bytes (256 bits) — chave de AES-256 ou HMAC-SHA256.
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
      ctx.addIssue({
        code: "custom",
        message: `precisa decodificar para 32 bytes (recebeu ${decoded.length}) — gere com scripts/generate-contact-keys.mjs`,
      });
      return z.NEVER;
    }
    return decoded;
  });

const keyVersionEntry = z.object({
  cipher: base64Key32,
  hmac: base64Key32,
});

// CONTACTS_KEY_VERSIONS chega como string JSON (variável de ambiente não
// tem tipo de objeto) — parseado e validado aqui, uma única vez.
const keyVersionsJson = z.string().transform((value, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "não é JSON válido" });
    return z.NEVER;
  }
  const result = z.record(z.string(), keyVersionEntry).safeParse(parsed);
  if (!result.success) {
    ctx.addIssue({ code: "custom", message: "formato inválido — veja docs/decisoes/a3-criptografia.md" });
    return z.NEVER;
  }
  return result.data;
});

const envSchema = z
  .object({
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    WORKSPACE_ACTIVE_COOKIE_SECRET: z.string().min(32, {
      message: "gere com `openssl rand -base64 32` — precisa de pelo menos 32 caracteres",
    }),
    CONTACTS_ACTIVE_KEY_VERSION: z.string().min(1),
    CONTACTS_KEY_VERSIONS: keyVersionsJson,
  })
  .refine((env) => env.CONTACTS_ACTIVE_KEY_VERSION in env.CONTACTS_KEY_VERSIONS, {
    message: "CONTACTS_ACTIVE_KEY_VERSION precisa existir como chave em CONTACTS_KEY_VERSIONS",
    path: ["CONTACTS_ACTIVE_KEY_VERSION"],
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    WORKSPACE_ACTIVE_COOKIE_SECRET: process.env.WORKSPACE_ACTIVE_COOKIE_SECRET,
    CONTACTS_ACTIVE_KEY_VERSION: process.env.CONTACTS_ACTIVE_KEY_VERSION,
    CONTACTS_KEY_VERSIONS: process.env.CONTACTS_KEY_VERSIONS,
  });

  if (!parsed.success) {
    // Só o caminho do campo, nunca `issue.input`/valor — evitaria vazar
    // fragmento de chave em log de build caso um dia isso mude de lugar.
    const faltando = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(
      `Variáveis de ambiente inválidas ou ausentes: ${faltando}. Veja .env.example.`,
    );
  }

  cached = parsed.data;
  return cached;
}
