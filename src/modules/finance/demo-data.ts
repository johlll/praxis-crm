import { addMonths, dayOfMonth, monthOf } from "@/lib/civil-date";
import type { FinanceEntry } from "./ledger";

/**
 * Financeiro — lançamentos FICTÍCIOS de demonstração (docs/decisoes/financeiro.md). Vivem só no código: nada é
 * gravado nem lido do banco. A página só entrega este conjunto a escritórios com `workspaces.is_demo = true`.
 *
 * ESTÁVEL POR MÊS: os lançamentos de um mês saem só do próprio mês (`demoEntriesOfMonth` não recebe "hoje").
 * Datas, valores e identificadores não mudam de um dia para o outro nem depois que o mês vira.
 *  - Junho a outubro de 2026: histórico, um recebimento e um pagamento por dia, do dia 1 ao 25.
 *  - Novembro de 2026: o conjunto detalhado, com datas fixas.
 *  - De dezembro de 2026 em diante: o mesmo formato do histórico, com tudo (lançamento, vencimento e dinheiro)
 *    dentro do próprio mês, para nunca alterar um mês anterior.
 *
 * "Hoje" só CORTA o conjunto (`buildFinanceDemo`): o que ainda não foi lançado não aparece e o que ainda não foi
 * recebido ou pago fica em aberto.
 */

export const DEMO_START_MONTH = "2026-06";
const DETAILED_MONTH = "2026-11";
const FIRST_LATER_MONTH = "2026-12";

/** [dia de novembro, reais, descrição, cliente ou fornecedor] */
type Fixed = readonly [number, number, string, string];

/** Recebimentos novos de novembro, um por dia (dois no dia 18). Com os cinco abaixo, somam R$ 38.400. */
const RECEIVED: readonly Fixed[] = [
  [1, 500, "Consulta inicial", "Caio Ferraz"],
  [2, 900, "Honorários · Contrato de locação", "Lívia Prado"],
  [3, 800, "Consulta de acompanhamento", "Denise Rocha"],
  [4, 1_100, "Parcela 1 de 3 · Usucapião", "Otávio Nunes"],
  [6, 1_500, "Honorários · Escritura", "Bianca Torres"],
  [7, 900, "Consulta e análise de matrícula", "Paula Teixeira"],
  [8, 800, "Honorários · Notificação", "Renato Silveira"],
  [9, 900, "Honorários · Procuração", "Marisa Coelho"],
  [10, 1_000, "Parcela 3 de 6 · Inventário", "Família Moreira"],
  [11, 1_200, "Honorários · Parecer imobiliário", "Construtora Aurora"],
  [15, 1_200, "Honorários · Distrato", "Renato Silveira"],
  [16, 1_100, "Parcela 2 de 3 · Usucapião", "Otávio Nunes"],
  [17, 1_000, "Consulta de acompanhamento", "Lívia Prado"],
  [18, 4_200, "Honorários · Usucapião", "Sérgio Batista"],
  [18, 600, "Consulta imobiliária", "Marisa Coelho"],
  [19, 1_100, "Honorários · Desmembramento de lote", "Sítio Boa Vista"],
  [20, 900, "Consulta inicial", "Denise Rocha"],
  [21, 1_000, "Honorários · Averbação", "Bianca Torres"],
  [22, 800, "Consulta e análise de matrícula", "Caio Ferraz"],
  [23, 900, "Parcela 4 de 6 · Inventário", "Família Moreira"],
  [25, 4_800, "Honorários · Regularização", "Helena Duarte"],
  [26, 1_800, "Honorários · Revisão contratual", "Construtora Aurora"],
];

/** Recebidos em novembro, mas lançados em outubro (R$ 9.400): [dia de outubro do lançamento, ...]. */
const RECEIVED_FROM_OCTOBER: readonly (readonly [number, ...Fixed])[] = [
  [4, 5, 1_700, "Parcela 2 de 4 · Adjudicação", "Luciana Freitas"],
  [6, 12, 2_000, "Honorários · Retificação de área", "Sítio Boa Vista"],
  [9, 13, 2_300, "Honorários · Incorporação", "Construtora Aurora"],
  [12, 14, 1_600, "Parcela 3 de 3 · Contrato", "Marcelo Antunes"],
  [18, 24, 1_800, "Parcela 2 de 2 · Escritura", "Bianca Torres"],
];

/** Despesas pagas de novembro. Somam R$ 12.600. */
const PAID: readonly Fixed[] = [
  [1, 100, "Cópias e autenticações", "Cartório (fictício)"],
  [2, 200, "Material de escritório", "Papelaria Modelo"],
  [3, 350, "Internet e telefonia", "Operadora Exemplo"],
  [4, 300, "Deslocamento", "Transporte Exemplo"],
  [5, 250, "Sistema de gestão", "Fornecedor de software"],
  [6, 200, "Correio e entregas", "Entregas Exemplo"],
  [7, 150, "Copa e limpeza", "Mercado Exemplo"],
  [8, 300, "Certidões", "Despachante Exemplo"],
  [9, 500, "Custas de cartório", "Cartório (fictício)"],
  [10, 350, "Energia elétrica", "Distribuidora Exemplo"],
  [11, 400, "Condomínio", "Edifício Exemplo"],
  [12, 700, "Contabilidade", "Contábil Exemplo"],
  [13, 1_500, "Aluguel do escritório", "Imóveis Horizonte"],
  [14, 700, "Estagiário · bolsa", "Equipe"],
  [15, 450, "Anúncios", "Plataforma de anúncios"],
  [16, 300, "Deslocamento", "Transporte Exemplo"],
  [17, 500, "Diligências", "Despachante Exemplo"],
  [18, 1_200, "Certidões e diligências", "Despachante Exemplo"],
  [19, 600, "Impostos", "Guia fictícia"],
  [20, 650, "Custas de cartório", "Cartório (fictício)"],
  [21, 600, "Manutenção de equipamentos", "Assistência Exemplo"],
  [22, 550, "Sistema de pesquisa jurídica", "Fornecedor de software"],
  [23, 400, "Material de escritório", "Papelaria Modelo"],
  [24, 500, "Anúncios", "Plataforma de anúncios"],
  [25, 500, "Impostos", "Guia fictícia"],
  [26, 350, "Copa e limpeza", "Mercado Exemplo"],
];

/** Em aberto, lançados em 24/11: [vencimento, reais, descrição, cliente ou fornecedor]. */
type Open = readonly [string, number, string, string];
const OPEN_NEW: readonly Open[] = [
  ["2026-11-30", 4_000, "Parcela 5 de 6 · Inventário", "Família Moreira"],
  ["2026-12-07", 3_500, "Parcela 3 de 3 · Usucapião", "Otávio Nunes"],
  ["2026-12-16", 3_500, "Honorários · Incorporação", "Construtora Aurora"],
];
const UPCOMING_EXPENSES: readonly Open[] = [["2026-12-03", 1_500, "Aluguel do escritório", "Imóveis Horizonte"]];
/** Parcela antiga, lançada em setembro e vencida em 20/11. */
const OVERDUE = {
  createdDate: "2026-09-05",
  dueDate: "2026-11-20",
  reais: 3_200,
  description: "Parcela 2 de 4 · Inventário",
  party: "Rafael Nogueira",
} as const;

/** Histórico: um recebimento e um pagamento por dia, do dia 1 ao 25. Totais de um mês de fator 1 (outubro). */
const HISTORY_RECEIVED_TOTAL = 32_400;
const HISTORY_PAID_TOTAL = 13_660;
const HISTORY_DAYS = 25;
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

/** Fator de cada mês anterior a novembro de 2026. */
const HISTORY_FACTORS: Readonly<Record<string, number>> = {
  "2026-06": 0.78,
  "2026-07": 0.95,
  "2026-08": 0.84,
  "2026-09": 0.9,
  "2026-10": 1,
};
/** De dezembro de 2026 em diante os fatores se repetem nesta ordem, contados a partir de dezembro. */
const LATER_FACTORS = [1, 0.9, 0.84, 0.95, 0.78] as const;

const CLIENTS = ["Caio Ferraz", "Lívia Prado", "Bianca Torres", "Construtora Aurora", "Família Moreira", "Denise Rocha"];
const SUPPLIERS = ["Imóveis Horizonte", "Contábil Exemplo", "Operadora Exemplo", "Despachante Exemplo", "Papelaria Modelo"];

function factorOf(month: string): number {
  const history = HISTORY_FACTORS[month];
  if (history !== undefined) return history;
  let index = 0;
  for (let m = FIRST_LATER_MONTH; m < month; m = addMonths(m, 1)) index += 1;
  return LATER_FACTORS[index % LATER_FACTORS.length]!;
}

/** Os lançamentos de UM mês, sempre os mesmos. O resultado não depende da data atual. */
export function demoEntriesOfMonth(month: string): FinanceEntry[] {
  if (month < DEMO_START_MONTH) return [];
  const entries: FinanceEntry[] = [];
  const push = (entry: Omit<FinanceEntry, "id">) =>
    entries.push({ id: `demo-${month}-${String(entries.length + 1).padStart(3, "0")}`, ...entry });
  /** Lançado, vencido e movimentado no mesmo dia. */
  const settled = (kind: FinanceEntry["kind"], date: string, reais: number, description: string, party: string) =>
    push({ kind, description, party, amountCents: reais * 100, createdDate: date, dueDate: date, paidDate: date });

  if (month !== DETAILED_MONTH) {
    for (const [kind, total, shape] of [
      ["receita", HISTORY_RECEIVED_TOTAL, RECEIVED_SHAPE],
      ["despesa", HISTORY_PAID_TOTAL, PAID_SHAPE],
    ] as const) {
      spread(Math.round((total * factorOf(month)) / 10) * 10, shape.slice(0, HISTORY_DAYS)).forEach((reais, i) => {
        const names = kind === "receita" ? CLIENTS : SUPPLIERS;
        const description = kind === "receita" ? "Honorários do mês" : "Despesa do escritório";
        settled(kind, dayOfMonth(month, i + 1), reais, description, names[i % names.length]!);
      });
    }
    return entries;
  }

  const november = (day: number) => dayOfMonth(DETAILED_MONTH, day);
  for (const [day, reais, description, party] of RECEIVED) settled("receita", november(day), reais, description, party);
  for (const [createdDay, day, reais, description, party] of RECEIVED_FROM_OCTOBER) {
    const date = november(day);
    push({ kind: "receita", description, party, amountCents: reais * 100, createdDate: dayOfMonth("2026-10", createdDay), dueDate: date, paidDate: date });
  }
  for (const [day, reais, description, party] of PAID) settled("despesa", november(day), reais, description, party);
  for (const [kind, list] of [
    ["receita", OPEN_NEW],
    ["despesa", UPCOMING_EXPENSES],
  ] as const) {
    for (const [dueDate, reais, description, party] of list) {
      push({ kind, description, party, amountCents: reais * 100, createdDate: november(24), dueDate, paidDate: null });
    }
  }
  push({
    kind: "receita",
    description: OVERDUE.description,
    party: OVERDUE.party,
    amountCents: OVERDUE.reais * 100,
    createdDate: OVERDUE.createdDate,
    dueDate: OVERDUE.dueDate,
    paidDate: null,
  });
  return entries;
}

/**
 * A demonstração vista em `today`: os conjuntos fixos de junho de 2026 até o mês atual, cortados na data.
 * Novembro entra sempre porque tem honorários lançados em outubro e a parcela lançada em setembro.
 */
export function buildFinanceDemo(today: string): { entries: FinanceEntry[]; coverageStart: string } {
  const last = monthOf(today) > DETAILED_MONTH ? monthOf(today) : DETAILED_MONTH;
  const entries: FinanceEntry[] = [];
  for (let month = DEMO_START_MONTH; month <= last; month = addMonths(month, 1)) {
    for (const entry of demoEntriesOfMonth(month)) {
      if (entry.createdDate > today) continue;
      entries.push(entry.paidDate !== null && entry.paidDate > today ? { ...entry, paidDate: null } : entry);
    }
  }
  return { entries, coverageStart: `${DEMO_START_MONTH}-01` };
}
