/**
 * Fuso único do escritório nesta fase (A6) — América/São_Paulo, explícito
 * em todo lugar que formata data/hora, nunca implícito no fuso da máquina
 * que roda o código (navegador do usuário OU servidor Node da Vercel,
 * que roda em UTC). Mesma disciplina que corrigiu o bug de hidratação
 * real documentado em A5-HANDOFF.md §3.1 — lá foi uma correção pontual
 * inline; aqui, como a A6 lida com data/hora como algo central (não
 * incidental), a constante fica num só lugar para não repetir o mesmo
 * bug de novo em cada componente novo.
 */
export const TIMEZONE = "America/Sao_Paulo";

/** "10/09/2026 14:30" — para um instante (timestamptz) com horário relevante. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { timeZone: TIMEZONE });
}

/** "10/09/2026" — para um instante cuja parte de hora não importa (has_time=false). */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: TIMEZONE });
}

/** "14:30" — só a hora, para exibir ao lado de uma data já mostrada em outro lugar. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Igual a formatDateTime()/formatDate(), mas escolhendo o formato conforme
 * hasTime — o par que due_at/has_time sempre andam juntos nas telas de
 * atividade.
 */
export function formatDue(iso: string, hasTime: boolean): string {
  return hasTime ? formatDateTime(iso) : formatDate(iso);
}
