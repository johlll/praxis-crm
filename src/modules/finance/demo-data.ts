import { addCivilDays, addMonths, dayOfMonth, monthOf } from "@/lib/civil-date";
import type { FinanceEntry } from "./ledger";

/**
 * Financeiro — lançamentos FICTÍCIOS de demonstração (docs/decisoes/financeiro.md). Vivem só no código: nada é
 * gravado nem lido do banco. A página só entrega este conjunto a escritórios com `workspaces.is_demo = true`.
 *
 * Relativo a "hoje" e determinístico: seis meses. No mês atual, os dias são contados para trás a partir de hoje
 * (nos primeiros dias do mês, o que passaria do dia 1 fica no dia 1), então os totais do mês atual não mudam.
 * No mês anterior, o dinheiro se move até o dia 25.
 */

export const DEMO_MONTHS = 6;

/** [dias atrás de hoje, reais, descrição, cliente ou fornecedor] */
type Current = readonly [number, number, string, string];

/** Recebimentos novos do mês, um por dia (dois em um deles). Com os três abaixo, somam R$ 38.400. */
const RECEIVED: readonly Current[] = [
  [25, 500, "Consulta inicial", "Caio Ferraz"],
  [24, 900, "Honorários · Contrato de locação", "Lívia Prado"],
  [23, 800, "Consulta de acompanhamento", "Denise Rocha"],
  [22, 1_100, "Parcela 1 de 3 · Usucapião", "Otávio Nunes"],
  [20, 1_500, "Honorários · Escritura", "Bianca Torres"],
  [19, 900, "Consulta e análise de matrícula", "Paula Teixeira"],
  [18, 800, "Honorários · Notificação", "Renato Silveira"],
  [17, 900, "Honorários · Procuração", "Marisa Coelho"],
  [16, 1_000, "Parcela 3 de 6 · Inventário", "Família Moreira"],
  [15, 1_200, "Honorários · Parecer imobiliário", "Construtora Aurora"],
  [11, 1_200, "Honorários · Distrato", "Renato Silveira"],
  [10, 1_100, "Parcela 2 de 3 · Usucapião", "Otávio Nunes"],
  [9, 1_000, "Consulta de acompanhamento", "Lívia Prado"],
  [8, 4_200, "Honorários · Usucapião", "Sérgio Batista"],
  [8, 600, "Consulta imobiliária", "Marisa Coelho"],
  [7, 1_100, "Honorários · Desmembramento de lote", "Sítio Boa Vista"],
  [6, 900, "Consulta inicial", "Denise Rocha"],
  [5, 1_000, "Honorários · Averbação", "Bianca Torres"],
  [4, 800, "Consulta e análise de matrícula", "Caio Ferraz"],
  [3, 900, "Parcela 4 de 6 · Inventário", "Família Moreira"],
  [1, 4_800, "Honorários · Regularização", "Helena Duarte"],
  [0, 1_800, "Honorários · Revisão contratual", "Construtora Aurora"],
];

/** Recebimentos deste mês de honorários que já estavam a receber no mês anterior (R$ 9.400): [lançado no dia, ...]. */
const RECEIVED_FROM_BEFORE: readonly (readonly [number, ...Current])[] = [
  [4, 21, 1_700, "Parcela 2 de 4 · Adjudicação", "Luciana Freitas"],
  [6, 14, 2_000, "Honorários · Retificação de área", "Sítio Boa Vista"],
  [9, 13, 2_300, "Honorários · Incorporação", "Construtora Aurora"],
  [12, 12, 1_600, "Parcela 3 de 3 · Contrato", "Marcelo Antunes"],
  [18, 2, 1_800, "Parcela 2 de 2 · Escritura", "Bianca Torres"],
];

/** Despesas pagas do mês. Somam R$ 12.600. */
const PAID: readonly Current[] = [
  [25, 100, "Cópias e autenticações", "Cartório (fictício)"],
  [24, 200, "Material de escritório", "Papelaria Modelo"],
  [23, 350, "Internet e telefonia", "Operadora Exemplo"],
  [22, 300, "Deslocamento", "Transporte Exemplo"],
  [21, 250, "Sistema de gestão", "Fornecedor de software"],
  [20, 200, "Correio e entregas", "Entregas Exemplo"],
  [19, 150, "Copa e limpeza", "Mercado Exemplo"],
  [18, 300, "Certidões", "Despachante Exemplo"],
  [17, 500, "Custas de cartório", "Cartório (fictício)"],
  [16, 350, "Energia elétrica", "Distribuidora Exemplo"],
  [15, 400, "Condomínio", "Edifício Exemplo"],
  [14, 700, "Contabilidade", "Contábil Exemplo"],
  [13, 1_500, "Aluguel do escritório", "Imóveis Horizonte"],
  [12, 700, "Estagiário · bolsa", "Equipe"],
  [11, 450, "Anúncios", "Plataforma de anúncios"],
  [10, 300, "Deslocamento", "Transporte Exemplo"],
  [9, 500, "Diligências", "Despachante Exemplo"],
  [8, 1_200, "Certidões e diligências", "Despachante Exemplo"],
  [7, 600, "Impostos", "Guia fictícia"],
  [6, 650, "Custas de cartório", "Cartório (fictício)"],
  [5, 600, "Manutenção de equipamentos", "Assistência Exemplo"],
  [4, 550, "Sistema de pesquisa jurídica", "Fornecedor de software"],
  [3, 400, "Material de escritório", "Papelaria Modelo"],
  [2, 500, "Anúncios", "Plataforma de anúncios"],
  [1, 500, "Impostos", "Guia fictícia"],
  [0, 350, "Copa e limpeza", "Mercado Exemplo"],
];

/** Em aberto: [dias até o vencimento (negativo = já venceu), reais, descrição, cliente]. */
const OPEN_NEW: readonly Current[] = [
  [4, 4_000, "Parcela 5 de 6 · Inventário", "Família Moreira"],
  [11, 3_500, "Parcela 3 de 3 · Usucapião", "Otávio Nunes"],
  [20, 3_500, "Honorários · Incorporação", "Construtora Aurora"],
];
/** Parcela antiga, vencida há 6 dias. */
const OVERDUE = { daysAgo: 6, reais: 3_200, description: "Parcela 2 de 4 · Inventário", party: "Rafael Nogueira" } as const;
const UPCOMING_EXPENSES: readonly Current[] = [[7, 1_500, "Aluguel do escritório", "Imóveis Horizonte"]];

/** Mês anterior: um recebimento e um pagamento por dia, do dia 1 ao 25, com o ritmo do mês atual. */
const PREVIOUS_RECEIVED_TOTAL = 32_400;
const PREVIOUS_PAID_TOTAL = 13_660;
const PREVIOUS_DAYS = 25;
/** Pesos diários (só a forma da curva). */
const RECEIVED_SHAPE = [5, 9, 8, 11, 17, 12, 9, 8, 10, 11, 13, 21, 24, 17, 12, 11, 10, 30, 13, 11, 12, 8, 9, 15, 20] as const;
const PAID_SHAPE = [2, 3, 4, 4, 3, 3, 2, 4, 6, 4, 5, 8, 14, 8, 6, 4, 6, 11, 7, 7, 7, 6, 5, 6, 6] as const;

/** Reparte um total em reais pelos pesos, em dezenas, com soma EXATA (arredondamento acumulado). */
function spread(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  let cumulative = 0;
  let given = 0;
  return weights.map((w, i) => {
    cumulative += w;
    const upTo = i === weights.length - 1 ? total : Math.round((total * cumulative) / sum / 10) * 10;
    const value = upTo - given;
    given = upTo;
    return value;
  });
}

const OLDER_FACTORS = [0.9, 0.84, 0.95, 0.78] as const;

const CLIENTS = ["Caio Ferraz", "Lívia Prado", "Bianca Torres", "Construtora Aurora", "Família Moreira", "Denise Rocha"];
const SUPPLIERS = ["Imóveis Horizonte", "Contábil Exemplo", "Operadora Exemplo", "Despachante Exemplo", "Papelaria Modelo"];

export function buildFinanceDemo(today: string): { entries: FinanceEntry[]; coverageStart: string } {
  const month = monthOf(today);
  const day = Number(today.slice(8, 10));
  const previous = addMonths(month, -1);
  const entries: FinanceEntry[] = [];
  let next = 0;
  const push = (entry: Omit<FinanceEntry, "id">) => entries.push({ id: `demo-${(next += 1)}`, ...entry });
  /** Dia do mês atual `ago` dias atrás de hoje, sem sair do mês. */
  const thisMonth = (ago: number) => dayOfMonth(month, Math.max(1, day - ago));

  for (const [ago, reais, description, party] of RECEIVED) {
    const date = thisMonth(ago);
    push({ kind: "receita", description, party, amountCents: reais * 100, createdDate: date, dueDate: date, paidDate: date });
  }
  for (const [createdDay, ago, reais, description, party] of RECEIVED_FROM_BEFORE) {
    const date = thisMonth(ago);
    push({ kind: "receita", description, party, amountCents: reais * 100, createdDate: dayOfMonth(previous, createdDay), dueDate: date, paidDate: date });
  }
  for (const [ago, reais, description, party] of PAID) {
    const date = thisMonth(ago);
    push({ kind: "despesa", description, party, amountCents: reais * 100, createdDate: date, dueDate: date, paidDate: date });
  }
  for (const [inDays, reais, description, party] of OPEN_NEW) {
    push({ kind: "receita", description, party, amountCents: reais * 100, createdDate: thisMonth(2), dueDate: addCivilDays(today, inDays), paidDate: null });
  }
  for (const [inDays, reais, description, party] of UPCOMING_EXPENSES) {
    push({ kind: "despesa", description, party, amountCents: reais * 100, createdDate: thisMonth(2), dueDate: addCivilDays(today, inDays), paidDate: null });
  }
  push({
    kind: "receita",
    description: OVERDUE.description,
    party: OVERDUE.party,
    amountCents: OVERDUE.reais * 100,
    createdDate: dayOfMonth(addMonths(month, -2), 5),
    dueDate: addCivilDays(today, -OVERDUE.daysAgo),
    paidDate: null,
  });

  const monthly = (target: string, factor: number) => {
    for (const [kind, total, shape] of [
      ["receita", PREVIOUS_RECEIVED_TOTAL, RECEIVED_SHAPE],
      ["despesa", PREVIOUS_PAID_TOTAL, PAID_SHAPE],
    ] as const) {
      spread(Math.round((total * factor) / 10) * 10, shape.slice(0, PREVIOUS_DAYS)).forEach((reais, i) => {
        const date = dayOfMonth(target, i + 1);
        push({
          kind,
          description: kind === "receita" ? "Honorários do mês" : "Despesa do escritório",
          party: kind === "receita" ? CLIENTS[i % CLIENTS.length]! : SUPPLIERS[i % SUPPLIERS.length]!,
          amountCents: reais * 100,
          createdDate: date,
          dueDate: date,
          paidDate: date,
        });
      });
    }
  };
  monthly(previous, 1);
  OLDER_FACTORS.forEach((factor, i) => monthly(addMonths(month, -(i + 2)), factor));

  return { entries, coverageStart: `${addMonths(month, -(DEMO_MONTHS - 1))}-01` };
}
