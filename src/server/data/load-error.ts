/**
 * Contrato único de erro das consultas (docs/decisoes/estabilizacao-pos-a9.md §1):
 *
 * - ausência legítima (registro inexistente, fora do alcance ou de outro
 *   workspace, sinalizada pela própria RPC) → a consulta devolve `null`;
 * - lista sem itens → a consulta devolve a lista vazia;
 * - qualquer outra falha (rede, timeout, erro inesperado do banco) → a
 *   consulta LANÇA `DataLoadError`. Nunca vira `null`, lista vazia ou
 *   "sem acesso".
 *
 * A mensagem nunca carrega o texto do Postgres (pode conter SQL ou dado):
 * o erro original fica só em `cause`, para log do servidor. Páginas deixam
 * o erro subir até o `error.tsx` da rota; Server Actions devolvem
 * `LOAD_ERROR_MESSAGE` ao cliente.
 */
export class DataLoadError extends Error {
  readonly resource: string;

  constructor(resource: string, cause?: unknown) {
    super(`Falha ao carregar ${resource}.`, cause === undefined ? undefined : { cause });
    this.name = "DataLoadError";
    this.resource = resource;
  }
}

export const LOAD_ERROR_MESSAGE = "Não foi possível carregar os dados. Tente novamente.";

type SupabaseErrorLike = { message?: string | null } | null | undefined;

/** Códigos que a própria RPC usa para "não existe ou não é seu" — nunca falha operacional. */
export function isExpectedAbsence(error: SupabaseErrorLike, codes: readonly string[]): boolean {
  return !!error?.message && codes.includes(error.message);
}
