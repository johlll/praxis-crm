import { uuidSchema } from "@/lib/uuid";

/**
 * Filtros e cursor da tela de auditoria (B5), lidos da query string.
 *
 * A query string é editável à mão: nada daqui é confiado sem validação, e
 * valor fora do formato vira "sem filtro" (queda segura), nunca erro cru nem
 * parâmetro repassado ao banco. O banco valida de novo (list_audit_log).
 */

export const AUDIT_PATH = "/configuracoes/auditoria";
export const AUDIT_PAGE_SIZE = 25;

const ACTION_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// created_at como o PostgREST devolve (ISO 8601, até microssegundos, com fuso) | id.
const CURSOR_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export type AuditFilters = {
  action: string | null;
  actorUserId: string | null;
  /** YYYY-MM-DD, dia inteiro no fuso do escritório, inclusivo. */
  from: string | null;
  to: string | null;
};

/** Posição na trilha: (created_at, id) do último registro da página anterior. */
export type AuditCursor = { createdAt: string; id: string };

export type AuditSearchParams = Record<string, string | string[] | undefined>;

export const EMPTY_AUDIT_FILTERS: AuditFilters = { action: null, actorUserId: null, from: null, to: null };

function first(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && v !== "" ? v : null;
}

function validDate(value: string | null): string | null {
  if (!value || !DATE_RE.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (y < 2000 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  const real = date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  return real ? value : null;
}

export function formatAuditCursor(cursor: AuditCursor): string {
  return `${cursor.createdAt}|${cursor.id}`;
}

export function parseAuditCursor(value: string | null): AuditCursor | null {
  if (!value) return null;
  const match = CURSOR_RE.exec(value);
  if (!match) return null;
  const createdAt = match[1]!;
  if (!Number.isFinite(Date.parse(createdAt))) return null;
  return { createdAt, id: match[2]!.toLowerCase() };
}

export type ParsedAuditSearch = {
  filters: AuditFilters;
  cursor: AuditCursor | null;
  /** Data inicial depois da final: o período inteiro é ignorado e a tela avisa. */
  periodError: boolean;
};

export function parseAuditSearchParams(raw: AuditSearchParams): ParsedAuditSearch {
  const actionRaw = first(raw.acao);
  const action = actionRaw && actionRaw.length <= 80 && ACTION_RE.test(actionRaw) ? actionRaw : null;

  const actorRaw = first(raw.pessoa);
  const actor = actorRaw && uuidSchema.safeParse(actorRaw).success ? actorRaw.toLowerCase() : null;

  let from = validDate(first(raw.de));
  let to = validDate(first(raw.ate));
  let periodError = false;
  if (from && to && from > to) {
    from = null;
    to = null;
    periodError = true;
  }

  return {
    filters: { action, actorUserId: actor, from, to },
    cursor: parseAuditCursor(first(raw.antes)),
    periodError,
  };
}

/** Endereço da tela com os filtros (e, se houver, o cursor) — para links. */
export function auditHref(filters: AuditFilters, cursor: AuditCursor | null = null): string {
  const params = new URLSearchParams();
  if (filters.action) params.set("acao", filters.action);
  if (filters.actorUserId) params.set("pessoa", filters.actorUserId);
  if (filters.from) params.set("de", filters.from);
  if (filters.to) params.set("ate", filters.to);
  if (cursor) params.set("antes", formatAuditCursor(cursor));
  const query = params.toString();
  return query ? `${AUDIT_PATH}?${query}` : AUDIT_PATH;
}
