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

/**
 * Destinatário de TESTE do alerta (`CALENDAR_ALERTS_TEST_RECIPIENT`), para a
 * validação controlada: vale SÓ com `VERCEL_ENV === "preview"`. Em Production
 * (ou fora da Vercel) é ignorado e o alerta segue para os destinatários reais.
 *
 *  - `off`: variável ausente (ou fora do Preview) — destinatários reais;
 *  - `test`: um único endereço válido — o alerta vai só para ele;
 *  - `invalid`: variável presente no Preview, mas inválida (inclusive vazia
 *    ou só com espaços) — o alerta falha
 *    sem enviar (nunca cai para os destinatários reais por engano).
 */
export type AlertTestRecipient = { mode: "off" } | { mode: "test"; email: string } | { mode: "invalid" };

// Um único endereço, sem nome, vírgula, espaço nem colchetes angulares.
const SINGLE_ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function calendarAlertTestRecipient(): AlertTestRecipient {
  if (process.env.VERCEL_ENV !== "preview") return { mode: "off" };
  const raw = process.env.CALENDAR_ALERTS_TEST_RECIPIENT;
  // Só a variável AUSENTE desliga o modo de teste; presente e vazia é inválida.
  if (raw === undefined) return { mode: "off" };
  const email = raw.trim();
  if (email.length > 254 || !SINGLE_ADDRESS.test(email)) return { mode: "invalid" };
  return { mode: "test", email };
}
