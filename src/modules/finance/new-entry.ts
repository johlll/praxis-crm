import { addMonths, civilDayNumber, monthOf } from "@/lib/civil-date";
import type { EntryKind, FinanceEntry } from "./ledger";

/** Financeiro — formulário de lançamento da SIMULAÇÃO: só valida e monta o objeto; nada é enviado ou gravado. */

export type NewEntryDraft = {
  kind: EntryKind;
  description: string;
  party: string;
  amount: string;
  dueDate: string;
  settled: boolean;
  paidDate: string;
};

export type NewEntryField = "description" | "party" | "amount" | "dueDate" | "paidDate";
export type NewEntryErrors = Partial<Record<NewEntryField, string>>;

export const MAX_DESCRIPTION = 140;
export const MAX_PARTY = 120;
/** R$ 100 milhões: acima disso é quase certamente erro de digitação. */
export const MAX_AMOUNT_CENTS = 10_000_000_000;

/**
 * Texto em reais → centavos inteiros, sem ponto flutuante. Aceita "1234", "1234,5", "1.234,56" e "R$ 1.234,56".
 * Recusa ponto como decimal ("1.5"), separadores fora do lugar, sinal negativo e mais de duas casas.
 */
export function parseAmountCents(text: string): number | null {
  const clean = text.replace(/^\s*R\$/i, "").trim();
  const match = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/.exec(clean);
  if (!match) return null;
  const reais = match[1]!.replace(/\./g, "");
  if (reais.length > 11) return null;
  return Number(reais) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

const within = (date: string, from: string, to: string) => monthOf(date) >= from && monthOf(date) <= to;

export function validateNewEntry(
  draft: NewEntryDraft,
  today: string,
  id: string,
): { ok: true; entry: FinanceEntry } | { ok: false; errors: NewEntryErrors } {
  const errors: NewEntryErrors = {};
  const description = draft.description.trim();
  const party = draft.party.trim();
  const minMonth = addMonths(monthOf(today), -24);
  const maxMonth = addMonths(monthOf(today), 24);

  if (!description) errors.description = "Informe a descrição.";
  else if (description.length > MAX_DESCRIPTION) errors.description = `Use até ${MAX_DESCRIPTION} caracteres.`;
  const partyName = draft.kind === "receita" ? "o cliente" : "o fornecedor";
  if (!party) errors.party = `Informe ${partyName}.`;
  else if (party.length > MAX_PARTY) errors.party = `Use até ${MAX_PARTY} caracteres.`;

  const amountCents = parseAmountCents(draft.amount);
  if (amountCents === null) errors.amount = "Informe o valor em reais, como 1.250,00.";
  else if (amountCents <= 0) errors.amount = "O valor precisa ser maior que zero.";
  else if (amountCents > MAX_AMOUNT_CENTS) errors.amount = "O valor máximo é R$ 100.000.000,00.";

  if (civilDayNumber(draft.dueDate) === null) errors.dueDate = "Informe uma data de vencimento válida.";
  else if (!within(draft.dueDate, minMonth, maxMonth)) errors.dueDate = "Use um vencimento a até dois anos de hoje.";

  if (draft.settled) {
    const label = draft.kind === "receita" ? "recebimento" : "pagamento";
    if (civilDayNumber(draft.paidDate) === null) errors.paidDate = `Informe uma data de ${label} válida.`;
    else if (draft.paidDate > today) errors.paidDate = `A data de ${label} não pode ser depois de hoje.`;
    else if (!within(draft.paidDate, minMonth, maxMonth)) errors.paidDate = `Use uma data de ${label} dos últimos dois anos.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    entry: {
      id,
      kind: draft.kind,
      description,
      party,
      amountCents: amountCents!,
      createdDate: today,
      dueDate: draft.dueDate,
      paidDate: draft.settled ? draft.paidDate : null,
      simulated: true,
    },
  };
}
