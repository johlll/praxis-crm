import { createHash } from "node:crypto";

/**
 * Representação canônica do CONTEÚDO DE NEGÓCIO de uma submissão, e o
 * SHA-256 sobre ela (contrato §2).
 *
 * O objetivo é que duas tentativas legítimas da MESMA submissão produzam
 * o mesmo hash — mesmo que o token do Turnstile tenha sido renovado, o IP
 * tenha mudado ou o navegador tenha reenviado depois de um timeout — e
 * que uma submissão materialmente diferente produza outro.
 *
 * Regras (todas testadas em tests/unit/a11-canonical.test.ts):
 *  - chaves ordenadas lexicograficamente, recursivamente;
 *  - strings: NFC + trim + espaços internos colapsados em um só;
 *  - e-mail em minúsculas; telefone reduzido a "+" e dígitos;
 *  - null, undefined, string vazia, objeto vazio e array vazio são
 *    OMITIDOS (ausência ≡ vazio — sem isso, um campo opcional que o
 *    navegador manda como "" numa tentativa e omite na outra viraria
 *    conflito de conteúdo para a mesma submissão);
 *  - números em forma canônica (JSON.stringify de number);
 *  - arrays preservam a ordem (ordem é conteúdo).
 *
 * FORA do hash, porque variam entre tentativas legítimas: token do
 * Turnstile, IP, cabeçalhos, User-Agent, timestamps do servidor,
 * source_event_id (já é a chave) e honeypot.
 */

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly CanonicalValue[]
  | { readonly [k: string]: CanonicalValue };

function normalizeString(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return normalizeString(value) === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

function canonicalize(value: CanonicalValue): CanonicalValue {
  if (isEmpty(value)) return undefined;

  if (typeof value === "string") return normalizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const items = (value as readonly CanonicalValue[])
      .map(canonicalize)
      .filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }

  const source = value as { readonly [k: string]: CanonicalValue };
  const out: Record<string, CanonicalValue> = {};
  for (const key of Object.keys(source).sort()) {
    const canonical = canonicalize(source[key]);
    if (canonical !== undefined) out[key] = canonical;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** E-mail: minúsculas, sem espaços. Não valida — só normaliza. */
export function normalizeEmail(value: string): string {
  return normalizeString(value).toLowerCase();
}

/**
 * Telefone: mantém só "+" inicial e dígitos. Um número digitado como
 * "(11) 98888-7777" e outro como "11988887777" são o MESMO conteúdo.
 */
export function normalizePhone(value: string): string {
  const digits = normalizeString(value).replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? `+${digits.slice(1).replace(/\D/g, "")}` : digits.replace(/\D/g, "");
}

/**
 * E.164 de verdade, para GRAVAR (o hash de conteúdo continua usando a
 * forma só-dígitos acima, que é estável entre tentativas).
 *
 * Achado por teste: prefixar "+" num número brasileiro digitado sem o
 * código do país ("11988887777") produzia "+11988887777" — E.164
 * sintaticamente válido, mas com código de país 1 (Estados Unidos). Um
 * número assim passaria no CHECK do banco e ficaria errado para sempre.
 *
 * Regra sem adivinhação: só assume Brasil quando o formato é
 * inequivocamente brasileiro (DDD de 11 a 99 + 8 ou 9 dígitos). Fora
 * disso devolve null — é melhor não gravar telefone do que gravar um
 * número que não existe.
 */
export function toE164BR(value: string): string | null {
  const normalized = normalizePhone(value);

  if (normalized.startsWith("+")) {
    return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
  }

  const digits = normalized;

  // Já vem com o código do país.
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    const withPlus = `+${digits}`;
    return /^\+55[1-9][1-9]\d{8,9}$/.test(withPlus) ? withPlus : null;
  }

  // Nacional: DDD + 8 (fixo) ou 9 (celular) dígitos.
  if (digits.length === 10 || digits.length === 11) {
    const withCountry = `+55${digits}`;
    return /^\+55[1-9][1-9]\d{8,9}$/.test(withCountry) ? withCountry : null;
  }

  return null;
}

/** DDD a partir do E.164 brasileiro — só para diagnóstico sem PII. */
export function dddFromE164(value: string | null): string | null {
  if (!value || !value.startsWith("+55")) return null;
  return value.slice(3, 5);
}

export function canonicalJson(value: CanonicalValue): string {
  const canonical = canonicalize(value);
  return JSON.stringify(canonical ?? {});
}

export function contentHash(value: CanonicalValue): Buffer {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest();
}
