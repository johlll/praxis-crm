/**
 * Motivo por extenso de cada sinal — nunca um número apresentado como
 * probabilidade (docs/decisoes/a3-duplicidades.md). `priority` só ordena a
 * fila e não aparece na interface como percentual nem "confiança".
 */
export function describeSignal(signal: { type: string; [key: string]: unknown }): string {
  switch (signal.type) {
    case "cpf_exact":
      return "Mesmo CPF/CNPJ";
    case "phone_exact":
      return "Mesmo telefone";
    case "email_exact":
      return "Mesmo e-mail";
    case "name_city_similarity":
      return `Nome parecido, mesma cidade${signal.city ? ` (${signal.city}${signal.uf ? `/${signal.uf}` : ""})` : ""}`;
    default:
      return "Sinal não reconhecido";
  }
}

export const TIER_LABEL: Record<string, string> = {
  strong: "Candidato forte",
  review: "Para revisão",
  low: "Confiança baixa",
};
