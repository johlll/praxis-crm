import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Autenticação da rota de manutenção da agenda (`/api/cron/calendar`). Só o
 * `CRON_SECRET` — o mesmo segredo dos crons da A11, pelo mesmo contrato —, sem
 * depender do resto da configuração da A11 (Turnstile, Upstash, Inngest,
 * chaves A11): um ambiente só com a agenda precisa poder rodar a manutenção.
 *
 * Falha fechada: segredo ausente ou com menos de 16 caracteres recusa tudo.
 * O segredo só vale no cabeçalho `Authorization: Bearer`, nunca na URL, e
 * nada daqui é registrado.
 */

const MIN_SECRET_LENGTH = 16;

function cronSecret(): string | null {
  const value = process.env.CRON_SECRET;
  if (!value || value.trim().length < MIN_SECRET_LENGTH) return null;
  return value;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function isAuthorizedCalendarCron(request: Request): boolean {
  const secret = cronSecret();
  if (!secret) return false;
  const header = request.headers.get("authorization");
  if (!header) return false;
  // Comparação em tempo constante (resumos de mesmo tamanho).
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
