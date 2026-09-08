/**
 * Normalização de telefone/e-mail — sempre roda no servidor antes de
 * gravar (nunca confiada como já normalizada vinda do cliente); os CHECK
 * constraints de contact_phones/contact_emails são a última linha de
 * defesa, não a primeira.
 */

/** Telefone brasileiro para E.164. Aceita já ter DDI, já ter só DDD+número,
 * ou vir com pontuação — sempre dígitos puros por dentro. Devolve null se
 * não parecer um telefone válido (contagem de dígitos fora da faixa). */
export function normalizePhoneBR(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  // "+" explícito no que a pessoa digitou é o único sinal confiável de que
  // os dígitos já incluem um DDI — sem ele, um número americano de 11
  // dígitos (DDI 1 + 10) é indistinguível de DDD+celular brasileiro (11
  // dígitos também), e o heurístico abaixo erraria colando +55 na frente
  // de um número que já tinha país. Achado escrevendo o teste unitário
  // para "+1 415 555 0100", não por inspeção do código.
  if (trimmed.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    return `+${digits}`;
  }
  if (digits.length === 10 || digits.length === 11) {
    return `+55${digits}`;
  }
  // Não tem "+" nem parece brasileiro — ainda assim aceita se a contagem
  // de dígitos for plausível para algum DDI (cliente pode ter digitado o
  // código do país sem o "+").
  if (digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}

export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) return null;
  return trimmed;
}
