import { addCivilDays, addMonths, dayOfMonth, daysInMonth, monthOf } from "@/lib/civil-date";

/**
 * Financeiro — das linhas aos números da tela (docs/decisoes/financeiro.md). Puro: não lê banco, relógio nem
 * rede. Cartões, gráfico, rosca e tabela saem DESTE cálculo sobre os mesmos lançamentos.
 *
 *  - Valores em centavos inteiros. Datas civis no fuso do escritório; `today` vem de quem chama.
 *  - Recebido/Despesas pagas: só o que foi efetivamente recebido/pago, pela DATA do recebimento/pagamento.
 *    Previsto não entra no realizado. Resultado = recebido − despesas pagas.
 *  - A receber é uma POSIÇÃO numa data de referência: receitas já lançadas até ela e ainda não recebidas nela.
 *    Vencimento antes da referência = em atraso; no dia ou depois = a vencer. Sem recebimento parcial: cada
 *    parcela é um lançamento.
 *  - Toda receita deste módulo é honorário (a rosca e o cartão "A receber" são o mesmo número).
 *  - Oportunidade ganha ou proposta aceita não é lançamento: nada aqui lê o CRM.
 */

export type EntryKind = "receita" | "despesa";

export type FinanceEntry = {
  id: string;
  kind: EntryKind;
  description: string;
  /** Cliente (receita) ou fornecedor (despesa). */
  party: string;
  amountCents: number;
  /** Dia em que passou a existir (entra na posição "a receber" a partir dele). */
  createdDate: string;
  dueDate: string;
  /** Data do recebimento ou do pagamento; null = em aberto. */
  paidDate: string | null;
  /** Criado na simulação desta aba. */
  simulated?: boolean;
};

export type EntryStatus = "recebido" | "pago" | "em_atraso" | "a_vencer" | "a_pagar";

export const STATUS_LABEL: Record<EntryStatus, string> = {
  recebido: "Recebido",
  pago: "Pago",
  em_atraso: "Em atraso",
  a_vencer: "A vencer",
  a_pagar: "A pagar",
};

/** Situação ATUAL (em relação a hoje). */
export function statusOf(entry: FinanceEntry, today: string): EntryStatus {
  if (entry.paidDate !== null) return entry.kind === "receita" ? "recebido" : "pago";
  if (entry.dueDate < today) return "em_atraso";
  return entry.kind === "receita" ? "a_vencer" : "a_pagar";
}

/** Data que situa o lançamento num mês: a do dinheiro, ou o vencimento enquanto está em aberto. */
export const movementDate = (entry: FinanceEntry) => entry.paidDate ?? entry.dueDate;

export type Receivable = { totalCents: number; upcomingCents: number; overdueCents: number };

export function receivableAt(entries: readonly FinanceEntry[], reference: string): Receivable {
  let upcomingCents = 0;
  let overdueCents = 0;
  for (const e of entries) {
    if (e.kind !== "receita" || e.createdDate > reference) continue;
    if (e.paidDate !== null && e.paidDate <= reference) continue;
    if (e.dueDate < reference) overdueCents += e.amountCents;
    else upcomingCents += e.amountCents;
  }
  return { totalCents: upcomingCents + overdueCents, upcomingCents, overdueCents };
}

export type Realized = { receivedCents: number; paidCents: number; resultCents: number };

export function realizedBetween(entries: readonly FinanceEntry[], from: string, to: string): Realized {
  let receivedCents = 0;
  let paidCents = 0;
  for (const e of entries) {
    if (e.paidDate === null || e.paidDate < from || e.paidDate > to) continue;
    if (e.kind === "receita") receivedCents += e.amountCents;
    else paidCents += e.amountCents;
  }
  return { receivedCents, paidCents, resultCents: receivedCents - paidCents };
}

export type MonthPhase = "past" | "current" | "future";

export type Comparison =
  | { kind: "change"; percent: number; previousCents: number }
  /** Sem percentual: base zero ou negativa (o valor anterior é mostrado), ou sem dados anteriores. */
  | { kind: "no_base"; reason: "zero" | "negative"; previousCents: number }
  | { kind: "no_base"; reason: "no_data" | "future"; previousCents: null };

export function compareCents(current: number, previous: number): Comparison {
  if (previous === 0) return { kind: "no_base", reason: "zero", previousCents: 0 };
  if (previous < 0) return { kind: "no_base", reason: "negative", previousCents: previous };
  return { kind: "change", percent: Math.round(((current - previous) / previous) * 1000) / 10, previousCents: previous };
}

export type ComparisonWindow = { month: string; from: string; to: string; partial: boolean };

export type FlowDay = { date: string; receivedCents: number; paidCents: number };

export type MonthView = {
  month: string;
  phase: MonthPhase;
  /** Último dia com realizado possível (null em mês futuro). */
  realizedEnd: string | null;
  /** Data de referência da posição "a receber". */
  reference: string;
  totals: Realized;
  receivable: Receivable;
  comparisonWindow: ComparisonWindow | null;
  comparison: { received: Comparison; paid: Comparison; result: Comparison; receivable: Comparison };
  /** Um ponto por dia, do dia 1 até `realizedEnd`; dia sem movimento é zero. */
  flow: FlowDay[];
  /** Lançamentos situados no mês, do mais recente para o mais antigo. */
  rows: FinanceEntry[];
  /** O mês é anterior ao começo dos dados. */
  beforeCoverage: boolean;
};

export function buildMonthView(
  entries: readonly FinanceEntry[],
  month: string,
  today: string,
  /** Primeiro dia com dados: antes dele não há base de comparação. */
  coverageStart: string,
): MonthView {
  const first = `${month}-01`;
  const last = dayOfMonth(month, daysInMonth(month));
  const phase: MonthPhase = month < monthOf(today) ? "past" : month > monthOf(today) ? "future" : "current";
  const realizedEnd = phase === "past" ? last : phase === "current" ? today : null;
  const reference = phase === "past" ? last : today;

  const totals = realizedEnd
    ? realizedBetween(entries, first, realizedEnd)
    : { receivedCents: 0, paidCents: 0, resultCents: 0 };
  const receivable = receivableAt(entries, reference);

  // Mesmo critério: mês fechado contra mês fechado; mês em curso contra o MESMO intervalo de dias do anterior.
  const previousMonth = addMonths(month, -1);
  const partial = phase === "current" && today < last;
  const window: ComparisonWindow | null =
    phase === "future"
      ? null
      : {
          month: previousMonth,
          from: `${previousMonth}-01`,
          to: dayOfMonth(previousMonth, partial ? Number(today.slice(8, 10)) : daysInMonth(previousMonth)),
          partial,
        };

  let comparison: MonthView["comparison"];
  if (!window || window.from < coverageStart) {
    const none: Comparison = { kind: "no_base", reason: window ? "no_data" : "future", previousCents: null };
    comparison = { received: none, paid: none, result: none, receivable: none };
  } else {
    const previous = realizedBetween(entries, window.from, window.to);
    comparison = {
      received: compareCents(totals.receivedCents, previous.receivedCents),
      paid: compareCents(totals.paidCents, previous.paidCents),
      result: compareCents(totals.resultCents, previous.resultCents),
      receivable: compareCents(receivable.totalCents, receivableAt(entries, window.to).totalCents),
    };
  }

  const flow: FlowDay[] = [];
  if (realizedEnd) {
    const byDate = new Map<string, FlowDay>();
    for (let date = first; date <= realizedEnd; date = addCivilDays(date, 1)) {
      const day = { date, receivedCents: 0, paidCents: 0 };
      flow.push(day);
      byDate.set(date, day);
    }
    for (const e of entries) {
      const day = e.paidDate === null ? undefined : byDate.get(e.paidDate);
      if (!day) continue;
      if (e.kind === "receita") day.receivedCents += e.amountCents;
      else day.paidCents += e.amountCents;
    }
  }

  const rows = sortByDate(
    entries.filter((e) => monthOf(movementDate(e)) === month),
    "desc",
  );

  return {
    month,
    phase,
    realizedEnd,
    reference,
    totals,
    receivable,
    comparisonWindow: window,
    comparison,
    flow,
    rows,
    beforeCoverage: last < coverageStart,
  };
}

/* ---------------------------------------------------------------- busca e ordenação */

export type DateOrder = "asc" | "desc";

/** Estável e previsível: empate na data segue o identificador na mesma direção. */
export function sortByDate(entries: readonly FinanceEntry[], order: DateOrder): FinanceEntry[] {
  const sign = order === "asc" ? 1 : -1;
  return [...entries].sort(
    (a, b) => sign * (movementDate(a).localeCompare(movementDate(b)) || a.id.localeCompare(b.id, "pt-BR", { numeric: true })),
  );
}

export const normalizeText = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR").trim();

/** Busca por descrição e por cliente ou fornecedor, sem diferenciar acento nem caixa. */
export function searchEntries(entries: readonly FinanceEntry[], query: string): FinanceEntry[] {
  const needle = normalizeText(query);
  if (!needle) return [...entries];
  return entries.filter((e) => normalizeText(`${e.description} ${e.party}`).includes(needle));
}

/** Meses oferecidos no seletor: 12 para cada lado de hoje, esticados para alcançar qualquer lançamento. */
export function selectableMonths(entries: readonly FinanceEntry[], today: string): string[] {
  let first = addMonths(monthOf(today), -12);
  let last = addMonths(monthOf(today), 12);
  for (const e of entries) {
    const month = monthOf(movementDate(e));
    if (month < first) first = month;
    if (month > last) last = month;
  }
  const months: string[] = [];
  for (let m = first; m <= last; m = addMonths(m, 1)) months.push(m);
  return months;
}
