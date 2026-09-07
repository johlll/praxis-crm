import { z } from "zod";

/** Slug: mesma regra do CHECK em public.workspaces.slug — validar aqui
 * também dá erro amigável em vez de estourar a constraint no banco. */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome do escritório.").max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Informe um identificador.")
    .max(63)
    .regex(SLUG_RE, "Use só letras minúsculas, números e hífen, sem começar ou terminar com hífen."),
});

/** Marcas diacríticas combinantes (U+0300–U+036F) — removidas depois do
 * normalize("NFD") para transformar "Escritório" em "escritorio". */
const COMBINING_DIACRITICS_RE = /[̀-ͯ]/g;

export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS_RE, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}
