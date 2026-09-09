/**
 * Reais digitados como texto (ex.: "5.500,00", "5500", "5500,5") → inteiro
 * em centavos, sem NENHUMA operação de ponto flutuante — só aritmética
 * inteira sobre as partes já separadas da string. `.` é separador de
 * milhar (removido), `,` é o separador decimal (convenção brasileira).
 * `null` para entrada vazia; `undefined` para formato inválido.
 */
export function parseMoneyBRToCents(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const cleaned = trimmed.replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;

  const [intPart, centsPart = ""] = cleaned.split(".");
  return Number(intPart) * 100 + Number(centsPart.padEnd(2, "0").slice(0, 2));
}
