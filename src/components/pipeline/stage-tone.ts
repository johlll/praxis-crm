/**
 * Cor de cada coluna do kanban. Usa a cor configurada na etapa quando ela é
 * um hex válido; sem cor, uma paleta discreta pela posição (as etapas do
 * pipeline padrão nascem sem cor). A cor só tinge de leve o fundo e a
 * borda — o texto continua nos tokens de texto, legível em qualquer etapa.
 */
const FALLBACK = ["#3DB591", "#5B9BE6", "#E0A54B", "#A98BEA", "#4FB8C2", "#E07A8B", "#C9A27A", "#8FA3B8"] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

export function stageColor(color: string | null | undefined, position: number): string {
  if (color && HEX.test(color)) return color;
  return FALLBACK[((position % FALLBACK.length) + FALLBACK.length) % FALLBACK.length]!;
}

export function mix(color: string, percent: number, base: string): string {
  return `color-mix(in srgb, ${color} ${percent}%, ${base})`;
}
