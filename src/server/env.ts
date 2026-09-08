import { z } from "zod";

/**
 * Validação das variáveis de ambiente na borda (falha cedo, com mensagem
 * clara, em vez de um `undefined` silencioso vazando para dentro do
 * `@supabase/ssr` e virando um erro de rede confuso). Nenhum valor é
 * logado — só o nome da variável ausente, no máximo.
 */
const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  WORKSPACE_ACTIVE_COOKIE_SECRET: z.string().min(32, {
    message: "gere com `openssl rand -base64 32` — precisa de pelo menos 32 caracteres",
  }),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    WORKSPACE_ACTIVE_COOKIE_SECRET: process.env.WORKSPACE_ACTIVE_COOKIE_SECRET,
  });

  if (!parsed.success) {
    const faltando = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(
      `Variáveis de ambiente inválidas ou ausentes: ${faltando}. Veja .env.example.`,
    );
  }

  cached = parsed.data;
  return cached;
}
