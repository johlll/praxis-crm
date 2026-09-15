/** Resultado de Server Action sem dado de retorno: sucesso ou erro já
 * sanitizado para exibição. Nunca `void` — sem canal de erro, uma recusa
 * do banco some em silêncio. */
export type ActionResult = { ok: true } | { ok: false; error: string };
