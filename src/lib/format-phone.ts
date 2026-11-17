/**
 * Telefone gravado (E.164, ver normalizePhoneBR) → forma legível na tela.
 * Só apresentação: número brasileiro vira "(11) 98765-4321"; qualquer outro
 * formato volta exatamente como veio, sem adivinhar.
 */
export function formatPhoneForDisplay(value: string): string {
  const br = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(value);
  if (!br) return value;
  const [, ddd, first, last] = br;
  return `(${ddd}) ${first}-${last}`;
}
