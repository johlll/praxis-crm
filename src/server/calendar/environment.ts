/**
 * Ambiente em que o servidor está operando, para o isolamento da B2
 * (docs/decisoes/b2-google-agenda.md §7).
 *
 * Preview e Production compartilham o mesmo Supabase. O banco só sabe qual
 * ambiente está chamando porque o SERVIDOR o informa num cabeçalho de
 * requisição, derivado de `VERCEL_ENV` — nunca de dado do usuário, de
 * parâmetro de rota ou de campo de formulário. O gatilho
 * `guard_linked_activity` e as funções de calendário leem esse cabeçalho.
 *
 * FALHA FECHADA para Production: só `VERCEL_ENV=production` explícito vale
 * `production`. Tudo o mais (preview, development, build local, CI,
 * variável ausente) é `preview` — um ambiente de teste jamais é tomado por
 * Production por omissão.
 */
export type CalendarEnvironment = "production" | "preview";

export const CALENDAR_ENV_HEADER = "X-Praxis-Env";

export function getCalendarEnvironment(): CalendarEnvironment {
  return process.env.VERCEL_ENV === "production" ? "production" : "preview";
}

export function calendarEnvHeaders(): Record<string, string> {
  return { [CALENDAR_ENV_HEADER]: getCalendarEnvironment() };
}
