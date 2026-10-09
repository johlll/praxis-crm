/**
 * Chaves de ativação da automação da agenda (B2, etapa 3b). DESLIGADAS por
 * padrão, inclusive depois do merge: só o valor exato `"true"` liga. Ligar é
 * decisão da validação (etapa 4), depois de medir frequência e custo do
 * agendador (§9.1) — nada liga sozinho por existir no código.
 *
 *  - `CALENDAR_SCHEDULER_ENABLED`: registra a função agendada do Inngest (a
 *    cada 15 min). Desligada, a função nem é oferecida ao Inngest.
 *  - `CALENDAR_ALERTS_ENABLED`: permite o e-mail de "agendador parado"
 *    (Detector 1, §9.3). Desligada, a condição é apurada e respondida, mas
 *    nenhum e-mail sai — mesmo com o Resend configurado para as propostas.
 */
export function calendarSchedulerEnabled(): boolean {
  return process.env.CALENDAR_SCHEDULER_ENABLED === "true";
}

export function calendarAlertsEnabled(): boolean {
  return process.env.CALENDAR_ALERTS_ENABLED === "true";
}
