import {
  ATTENDANCE_STATUSES,
  ATTENDANCE_STATUS_LABEL,
  type AttendanceStatus,
} from "@/modules/status-tracks/schema";
import type { MessageAuthorKind } from "./message-author";

/**
 * Conversas + IA (PR 2) — regras puras da caixa de entrada: estado da URL
 * (busca, filtro, página e caso em foco), rótulos de autoria e de tipo de
 * conteúdo. Sem acesso a banco e sem `server-only`, para valer no servidor e
 * no navegador e ser testado sem rede.
 */

/** "all" é a AUSÊNCIA de filtro; as demais são as situações do atendimento (inclusive "nao_informado"). */
export const INBOX_FILTERS = ["all", ...ATTENDANCE_STATUSES] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

export const INBOX_FILTER_LABEL: Record<InboxFilter, string> = {
  all: "Todas",
  ...ATTENDANCE_STATUS_LABEL,
};

export const INBOX_SEARCH_MAX = 80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}
const MAX_PAGE = 10_000;

export type InboxParams = {
  /** Busca por contato, telefone ou área (vazia = sem busca). */
  q: string;
  status: InboxFilter;
  page: number;
  /** Oportunidade em FOCO (estado da interface; o servidor valida). */
  caso: string | null;
  /**
   * Conversa só DESTACADA na lista, sem abri-la — é o que o "Voltar" do celular
   * leva de volta para a lista, para a seleção não se perder.
   */
  sel: string | null;
};

type RawParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Lê e sanitiza os parâmetros da URL; valor inválido vira o padrão, nunca erro. */
export function parseInboxParams(raw: RawParams): InboxParams {
  const q = (first(raw.q) ?? "").replace(/\s+/g, " ").trim().slice(0, INBOX_SEARCH_MAX);
  const statusRaw = first(raw.situacao) ?? "all";
  const status = (INBOX_FILTERS as readonly string[]).includes(statusRaw) ? (statusRaw as InboxFilter) : "all";
  const pageNum = Number.parseInt(first(raw.page) ?? "1", 10);
  const page = Number.isFinite(pageNum) ? Math.min(MAX_PAGE, Math.max(1, pageNum)) : 1;
  const casoRaw = first(raw.caso) ?? "";
  const selRaw = first(raw.sel) ?? "";
  return {
    q,
    status,
    page,
    caso: UUID_RE.test(casoRaw) ? casoRaw.toLowerCase() : null,
    sel: UUID_RE.test(selRaw) ? selRaw.toLowerCase() : null,
  };
}

/**
 * Monta o endereço preservando o estado da lista (busca, filtro, página) e,
 * se pedido, o caso em foco. Só entram os valores diferentes do padrão, para
 * que os links existentes (`/conversas`, `/conversas/<id>`) continuem sendo
 * os mesmos quando não há estado.
 */
export function inboxHref(
  conversationId: string | null,
  params: Partial<InboxParams>,
  opts: { keepCase?: boolean } = {},
): string {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.status && params.status !== "all") query.set("situacao", params.status);
  if (params.page && params.page > 1) query.set("page", String(params.page));
  if (opts.keepCase && params.caso) query.set("caso", params.caso);
  // Sem conversa aberta (lista), o destaque vai em `sel`; com conversa aberta, ela já é a seleção.
  if (!conversationId && params.sel) query.set("sel", params.sel);
  const qs = query.toString();
  const path = conversationId ? `/conversas/${conversationId}` : "/conversas";
  return qs ? `${path}?${qs}` : path;
}

/** Quantidades por situação devolvidas pelo servidor (sobre o conjunto inteiro que o papel alcança). */
export type InboxCounts = Record<InboxFilter, number>;

export function mapInboxCounts(raw: unknown): InboxCounts {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string) => Math.max(0, Number(r[k] ?? 0) || 0);
  return {
    all: n("all"),
    nao_informado: n("nao_informado"),
    novo: n("novo"),
    aguardando_escritorio: n("aguardando_escritorio"),
    aguardando_cliente: n("aguardando_cliente"),
    encerrado: n("encerrado"),
  };
}

export function isAttendanceStatus(v: unknown): v is AttendanceStatus {
  return typeof v === "string" && (ATTENDANCE_STATUSES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------
// Autoria e tipo de conteúdo
// ---------------------------------------------------------------------

/**
 * Autoria exibível, só com o que o banco comprovou. "Automação" nunca vira o
 * nome do bot de atendimento nem de uma pessoa; "Interno" nunca vira um
 * integrante específico da equipe.
 */
export const MESSAGE_AUTHOR_LABEL: Record<MessageAuthorKind, string> = {
  client: "Cliente",
  office_crm: "Equipe · pelo CRM",
  office_phone: "Escritório · pelo celular",
  internal: "Interno",
  automation: "Automação",
  unidentified: "Autoria não identificada",
};

export const MESSAGE_AUTHOR_HINT: Record<MessageAuthorKind, string> = {
  client: "Mensagem recebida do número do cliente.",
  office_crm: "Enviada por alguém da equipe pelo CRM.",
  office_phone: "Enviada pelo aplicativo do celular do escritório.",
  internal: "Origem interna do escritório, sem identificar quem enviou.",
  automation: "Enviada por uma automação com correlação comprovada. Não identifica qual.",
  unidentified: "O sistema não tem como comprovar quem enviou esta mensagem.",
};

/** Tipos de conteúdo gravados em messages.content_kind. */
export const CONTENT_KIND_LABEL: Record<string, string> = {
  text: "Texto",
  image: "Imagem",
  video: "Vídeo",
  audio: "Áudio",
  document: "Documento",
  sticker: "Figurinha",
  location: "Localização",
  contacts: "Contato compartilhado",
  interactive: "Mensagem interativa",
  button: "Resposta de botão",
  reaction: "Reação",
  order: "Pedido",
  request_welcome: "Início de conversa",
  template: "Modelo de mensagem",
  unsupported: "Conteúdo não suportado",
  other: "Outro conteúdo",
};

export function contentKindLabel(kind: string | null | undefined): string {
  if (!kind) return "Conteúdo";
  return CONTENT_KIND_LABEL[kind] ?? "Outro conteúdo";
}

/**
 * Identificação honesta de um conteúdo que esta tela não sabe exibir: nomeia
 * o tipo e diz que a visualização não existe aqui. Nunca finge um player, um
 * anexo ou uma gravação.
 */
export function unsupportedContentNotice(kind: string | null | undefined): string {
  return `${contentKindLabel(kind)} — visualização indisponível nesta tela`;
}

/** Prévia de uma linha da lista: o texto, ou o tipo quando a mensagem não tem texto. */
export function listPreview(item: {
  lastMessageText: string | null;
  lastMessageContentKind: string | null;
  lastMessageDirection: "inbound" | "outbound" | null;
}): { text: string; isKind: boolean } {
  const prefix = item.lastMessageDirection === "outbound" ? "Você: " : "";
  const text = item.lastMessageText?.trim();
  if (text) return { text: prefix + text, isKind: false };
  if (item.lastMessageContentKind && item.lastMessageDirection) {
    return { text: prefix + contentKindLabel(item.lastMessageContentKind), isKind: true };
  }
  return { text: "Sem mensagens", isKind: true };
}

// ---------------------------------------------------------------------
// Hora da lista
// ---------------------------------------------------------------------

const SP = "America/Sao_Paulo";

function dayParts(d: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: SP, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/**
 * Hora relativa de uma linha da lista, sempre no fuso do escritório: hoje
 * "14:30", ontem "Ontem", até 6 dias o dia da semana, depois "10/11".
 */
export function formatListTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const a = dayParts(at);
  const n = dayParts(now);
  const diffDays = Math.round((Date.UTC(n.y, n.m - 1, n.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
  if (diffDays <= 0) {
    return new Intl.DateTimeFormat("pt-BR", { timeZone: SP, hour: "2-digit", minute: "2-digit" }).format(at);
  }
  if (diffDays === 1) return "Ontem";
  if (diffDays < 7) return new Intl.DateTimeFormat("pt-BR", { timeZone: SP, weekday: "short" }).format(at).replace(".", "");
  return new Intl.DateTimeFormat("pt-BR", { timeZone: SP, day: "2-digit", month: "2-digit" }).format(at);
}

/** Separador de dia dentro da conversa: "Hoje", "Ontem" ou "10 de novembro de 2026". */
export function formatDaySeparator(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const a = dayParts(at);
  const n = dayParts(now);
  const diffDays = Math.round((Date.UTC(n.y, n.m - 1, n.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
  if (diffDays === 0) return "Hoje";
  if (diffDays === 1) return "Ontem";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: SP, day: "numeric", month: "long", year: "numeric" }).format(at);
}

/** Chave estável do dia (no fuso do escritório), para agrupar mensagens. */
export function dayKey(iso: string): string {
  const p = dayParts(new Date(iso));
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
