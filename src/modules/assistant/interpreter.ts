import { missingFields } from "./operations";
import type { AssistantOperationName } from "./operations";
import type { RegistrationDraft } from "./types";

/**
 * Intérprete do Assistente: lê a mensagem e PROPÕE uma operação da lista explícita
 * (operations.ts), com parâmetros. Nunca consulta nem grava: o servidor valida e executa.
 *
 * Neste ciclo só existe a SIMULAÇÃO abaixo, por regras fixas de texto. Nenhum provedor de IA é chamado.
 * Um adaptador real entra depois implementando a mesma interface, sem mudar quem executa.
 */
export type InterpreterContext = {
  /** Rascunho de cadastro aberto, esperando o que falta. */
  pending: RegistrationDraft | null;
  /** Áreas jurídicas já usadas no escritório, para preferir a grafia dele. */
  legalAreas: readonly string[];
};

export type InterpreterProposal =
  | {
      operation: AssistantOperationName;
      params: Record<string, unknown>;
      /** Pedido novo de cadastro: começa do zero em vez de completar o rascunho aberto. */
      fresh?: boolean;
    }
  | { operation: null; reason: "unknown" };

export interface AssistantInterpreter {
  readonly id: string;
  readonly simulated: boolean;
  interpret(text: string, context: InterpreterContext): InterpreterProposal;
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const capitalize = (s: string) => (s ? s.charAt(0).toLocaleUpperCase("pt-BR") + s.slice(1) : s);

/** Palavras do assunto → área jurídica. A pessoa confere e corrige no cartão antes de gravar. */
const AREA_KEYWORDS: ReadonlyArray<[RegExp, string]> = [
  [/imove|imobili|usucapi|escritura|aluguel|locacao|despejo|condominio|regularizacao fundiaria/, "Imobiliário"],
  [/divorci|guarda|pensao aliment|inventari|partilha|uniao estavel/, "Família"],
  [/trabalh|demiss|rescis|horas extras|fgts/, "Trabalhista"],
  [/aposentad|inss|previd|bpc|auxilio/, "Previdenciário"],
  [/tribut|imposto|icms|irpf|fiscal/, "Tributário"],
  [/empresa|societ|contrato social|socio/, "Empresarial"],
  [/consumidor|cobranca indevida|produto com defeito/, "Consumidor"],
  [/criminal|crime|penal/, "Criminal"],
];

const PHONE = /(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}/;
const EMAIL = /[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/;
const NAME_WORD = "[A-ZÀ-Ý][\\p{L}'’-]+";
const NAME = `${NAME_WORD}(?:\\s+(?:(?:de|da|do|das|dos|e)\\s+)?${NAME_WORD})*`;
const REGISTER_NAME = new RegExp(
  `(?:[Cc]adastr|[Rr]egistr)\\p{L}*\\s+(?:(?:[Oo]|[Aa]|[Uu]ma?)\\s+)?(?:nov[oa]\\s+)?(?:(?:cliente|pessoa|contato)\\s+)?(?<name>${NAME})`,
  "u",
);
const SUMMARY = /(?:para\s+(?:um|o)?\s*caso\s+de|caso\s+de|sobre|referente\s+a|para)\s+(?<s>[^,.;]+)/i;

function areaFrom(text: string, legalAreas: readonly string[]): string | undefined {
  const folded = fold(text);
  const known = legalAreas.find((area) => folded.includes(fold(area)));
  if (known) return known;
  const hit = AREA_KEYWORDS.find(([pattern]) => pattern.test(folded))?.[1];
  if (!hit) return undefined;
  return legalAreas.find((area) => fold(area) === fold(hit)) ?? hit;
}

function contactsFrom(text: string): Pick<RegistrationDraft, "phone" | "email"> {
  const email = text.match(EMAIL)?.[0];
  const withoutEmail = email ? text.replace(email, " ") : text;
  const phone = withoutEmail.match(PHONE)?.[0]?.trim();
  return { ...(phone ? { phone } : {}), ...(email ? { email } : {}) };
}

/** Assunto do caso, sem telefone e e-mail no meio. */
function summaryFrom(text: string): string | undefined {
  const clean = text.replace(EMAIL, " ").replace(PHONE, " ");
  const s = clean.match(SUMMARY)?.groups?.s?.trim().replace(/\s+(?:telefone|tel|e-?mail|com)\s*$/i, "");
  return s ? capitalize(s) : undefined;
}

function registrationFrom(text: string, legalAreas: readonly string[]): RegistrationDraft {
  const name = text.match(REGISTER_NAME)?.groups?.name?.trim();
  const afterName = name ? text.slice(text.indexOf(name) + name.length) : text.replace(/^.*?(?:cadastr|registr)\p{L}*/iu, "");
  const summary = summaryFrom(afterName);
  const legalArea = areaFrom(afterName, legalAreas);
  return {
    ...(name ? { name } : {}),
    ...(summary ? { summary } : {}),
    ...(legalArea ? { legalArea } : {}),
    ...contactsFrom(text),
  };
}

/** Resposta a uma pergunta do rascunho: preenche só o que falta, na ordem em que foi pedido. */
function answerFor(text: string, pending: RegistrationDraft, legalAreas: readonly string[]): RegistrationDraft {
  const missing = missingFields(pending);
  const contacts = contactsFrom(text);
  const plain = text.replace(EMAIL, " ").replace(PHONE, " ").replace(/\s+/g, " ").trim().replace(/[.!]$/, "");
  if (missing.includes("name") && missing.includes("legalArea")) {
    // "Ana Ribeiro, regularização de imóvel" ou "Ana Ribeiro para regularização de imóvel".
    const [, name, rest] = plain.match(/^(.+?)(?:\s*[,;–-]\s*|\s+(?:para|sobre|caso de)\s+)(.+)$/i) ?? [null, plain, ""];
    const summary = rest ? capitalize(rest.trim()) : undefined;
    const legalArea = rest ? areaFrom(rest, legalAreas) : undefined;
    return { name: name?.trim(), ...(summary ? { summary } : {}), ...(legalArea ? { legalArea } : {}), ...contacts };
  }
  if (missing.includes("name")) return { name: plain, ...contacts };
  if (missing.includes("legalArea")) {
    const area = areaFrom(plain, legalAreas);
    // Sem palavra conhecida, a resposta é a própria área ("Agrário", por exemplo).
    return {
      legalArea: area ?? capitalize(plain),
      ...(area && !pending.summary && fold(area) !== fold(plain) ? { summary: capitalize(plain) } : {}),
      ...contacts,
    };
  }
  return contacts;
}

export const simulatedInterpreter: AssistantInterpreter = {
  id: "simulado-v1",
  simulated: true,
  interpret(text, { pending, legalAreas }) {
    const folded = fold(text);
    if (pending && /^(?:cancel|desist|deixa pra la|esquece|nao quero)/.test(folded.trim())) {
      return { operation: "cancel_registration", params: {} };
    }
    if (/(cadastr|registr|novo cliente|nova cliente)/.test(folded)) {
      return { operation: "propose_client_registration", params: registrationFrom(text, legalAreas), fresh: true };
    }
    if (/(atencao|pendenc|prioridade|atrasad|agenda de hoje|o que (?:eu )?tenho (?:para |pra )?hoje|resumo do dia)/.test(folded)) {
      return { operation: "diagnose_attention", params: {} };
    }
    if (pending) {
      return { operation: "propose_client_registration", params: answerFor(text, pending, legalAreas) };
    }
    return { operation: null, reason: "unknown" };
  },
};
