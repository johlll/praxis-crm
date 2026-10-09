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

/**
 * Instante (ISO, UTC) de uma data "YYYY-MM-DD" e hora "HH:MM" digitadas no
 * fuso do escritório. Usado onde o servidor precisa do instante ANTES de a
 * atividade existir no banco (ex.: checar disponibilidade na agenda); depois
 * de criada, vale sempre o `due_at` que o banco montou.
 */
export function zonedInstant(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // O deslocamento do fuso nesse instante, lido do próprio Intl (sem fixar -03:00).
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(wall));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asLocal = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  const offset = asLocal - wall;
  return new Date(wall - offset).toISOString();
}

/**
 * "YYYY-MM-DD" e "HH:MM" de um instante, no fuso do escritório — o formato dos
 * <input type="date"> e <input type="time">. Sem hora relevante, `time` vem vazio.
 */
export function dateTimeInputParts(iso: string, hasTime: boolean): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: hasTime ? `${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}` : "",
  };
}
