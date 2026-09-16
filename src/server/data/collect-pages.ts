import { DataLoadError } from "./load-error";

/**
 * Busca TODAS as páginas de uma consulta paginada, para telas que precisam
 * da lista inteira (seletores, resolução de vínculo). Nunca devolve uma
 * lista parcial como se fosse completa: página com falha (a própria
 * `fetchPage` lança), página vazia antes de atingir o total ou limite de
 * páginas atingido → DataLoadError.
 */
export async function collectAllPages<T>(
  resource: string,
  fetchPage: (page: number) => Promise<{ items: T[]; total: number }>,
  maxPages = 50,
): Promise<T[]> {
  let items: T[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const result = await fetchPage(page);
    items = items.concat(result.items);

    if (items.length >= result.total) return items;
    if (result.items.length === 0) {
      throw new DataLoadError(`${resource} (página ${page} vazia com ${items.length}/${result.total})`);
    }
  }

  throw new DataLoadError(`${resource} (limite de ${maxPages} páginas atingido)`);
}
