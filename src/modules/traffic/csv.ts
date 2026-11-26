import { formatDay } from "./format";
import { STATUS_LABEL, type CampaignRow } from "./report";
import { PLATFORM_LABEL, type DateRange, type Platform } from "./schema";

/**
 * Exportação CSV do conjunto filtrado, na ordem que está na tela. Separador ";" e vírgula decimal (planilha em
 * português), BOM para acentos. Sem linha de total, para somar a planilha não contar em dobro.
 */

/**
 * Texto vindo de fora (nome da campanha, área) nunca vira fórmula: se começar — mesmo depois de espaços ou
 * caracteres de controle — com = + - @ (inclusive as versões de largura total), ou começar com tabulação ou
 * quebra de linha, ganha um apóstrofo na frente.
 */
export function neutralizeFormula(text: string): string {
  return /^[\t\r\n]|^[\s\u0000-\u001f\u007f﻿]*[=+\-@＝＋－＠]/.test(text) ? `'${text}` : text;
}

const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
const textCell = (value: string) => quote(neutralizeFormula(value));
/** Números gerados aqui (nunca negativos): "2480,00", sem "R$" e sem separador de milhar. */
const moneyCell = (cents: number) => quote((cents / 100).toFixed(2).replace(".", ","));
const countCell = (n: number) => quote(String(n));

export const CSV_HEADER = [
  "Origem dos dados",
  "Início do período",
  "Fim do período",
  "Campanha",
  "Plataforma",
  "Área de atuação",
  "Investimento (R$)",
  "Conversas informadas pela plataforma",
  "Leads qualificados",
  "Contratos",
  "CPL (R$ por lead qualificado)",
  "Situação atual",
] as const;

export const DEMO_ORIGIN = "DEMONSTRAÇÃO (dados fictícios)";

export function campaignsToCsv(rows: readonly CampaignRow[], period: DateRange, origin: string): string {
  const lines = [CSV_HEADER.map(quote).join(";")];
  for (const row of rows) {
    lines.push(
      [
        textCell(origin),
        quote(formatDay(period.from)),
        quote(formatDay(period.to)),
        textCell(row.name),
        quote(PLATFORM_LABEL[row.platform]),
        textCell(row.legalArea ?? "Não informada"),
        moneyCell(row.investmentCents),
        countCell(row.conversations),
        countCell(row.qualifiedLeads),
        countCell(row.contracts),
        row.cplCents === null ? quote("sem leads qualificados") : moneyCell(row.cplCents),
        quote(STATUS_LABEL[row.status]),
      ].join(";"),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function csvFileName(period: DateRange, platforms: readonly Platform[]): string {
  return `trafego-pago-demonstracao_${platforms.join("-")}_${period.from}_a_${period.to}.csv`;
}
