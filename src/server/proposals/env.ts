import { z } from "zod";

/**
 * Configuração do Resend — DELIBERADAMENTE fora do schema estrito de
 * src/server/env.ts: aquele falha o processo inteiro se qualquer campo
 * declarado faltar. Envio real de proposta é opcional por instalação —
 * sem RESEND_API_KEY, o app inteiro continua funcionando normalmente,
 * só o botão "Enviar por e-mail" fica desabilitado com uma mensagem
 * clara (o registro manual de envio, da A9, nunca depende disto).
 *
 * Reaproveita a MESMA conta/domínio Resend já usado pelo SMTP do
 * Supabase Auth (docs/decisoes/estabilizacao-pos-a9.md §7.2,
 * mail.collios.cloud, já verificado) — mas com uma API key própria da
 * aplicação (não a credencial SMTP do Auth) e um remetente distinto do
 * `nao-responda@` usado ali, porque isto é correspondência de negócio
 * (pode receber resposta), não confirmação de cadastro.
 */
const resendEnvSchema = z.object({
  RESEND_API_KEY: z.string().min(1),
  RESEND_FROM_EMAIL: z.string().email(),
});

export type ResendConfig = {
  apiKey: string;
  fromEmail: string;
};

export function getResendConfig(): ResendConfig | null {
  const parsed = resendEnvSchema.safeParse({
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
  });
  if (!parsed.success) return null;
  return { apiKey: parsed.data.RESEND_API_KEY, fromEmail: parsed.data.RESEND_FROM_EMAIL };
}
