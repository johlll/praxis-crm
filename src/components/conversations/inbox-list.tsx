import Link from "next/link";
import { MessageCircle, Search, SearchX } from "lucide-react";

import { cn } from "@/lib/cn";
import { initialsOf } from "@/lib/initials";
import { formatPhoneForDisplay } from "@/lib/format-phone";
import type { ConversationInboxPage } from "@/modules/conversations/queries";
import {
  INBOX_FILTERS,
  INBOX_FILTER_LABEL,
  INBOX_SEARCH_MAX,
  formatListTime,
  inboxHref,
  listPreview,
  type InboxParams,
} from "@/modules/conversations/inbox";
import { ConversationsPagination } from "./conversations-pagination";
import { LinkPending } from "./link-pending";
import { ScrollMemoryList } from "./scroll-memory-list";
import { caseBadge, caseChipLabel, caseCountLabel } from "@/modules/conversations/case-display";
import { AttendanceChip, CaseSubjectChips } from "./context/case-badge";

/**
 * Coluna da lista de conversas (Conversas + IA, PR 2). Server Component: busca,
 * filtro e página são parâmetros da URL e tudo vem do servidor — nada é
 * filtrado só sobre a página carregada. As contagens das abas cobrem o
 * conjunto inteiro que o papel alcança. Sem contador de não lidas nem filtro
 * "Para humano": não há fonte confiável para eles.
 *
 * Cada linha mostra o caso (assunto e selo: comercial, serviço ou perdida) pela MESMA regra do painel, e a
 * situação do atendimento à parte, com ícone de mensagem. Com vários casos e nenhum vínculo inequívoco, "N
 * casos" — nunca um andamento escolhido por palpite para o cliente inteiro.
 */
export function InboxList({
  inbox,
  params,
  openId,
}: {
  inbox: ConversationInboxPage;
  params: InboxParams;
  /** Conversa aberta no centro (null na lista pura). A destacada sem abrir vem em `params.sel`. */
  openId: string | null;
}) {
  const { items, total, page, pageSize, counts } = inbox;
  const highlightId = openId ?? params.sel;
  const filtered = params.status !== "all" || params.q !== "";
  const hrefFor = (p: number) => inboxHref(openId, { ...params, page: p }, { keepCase: true });

  return (
    <>
      <div className="shrink-0 border-b border-border p-3">
        <form
          role="search"
          method="get"
          action={openId ? `/conversas/${openId}` : "/conversas"}
          className="flex gap-2"
        >
          <label htmlFor="busca-conversas" className="sr-only">
            Buscar conversa por contato, telefone ou caso
          </label>
          <input
            id="busca-conversas"
            name="q"
            type="search"
            defaultValue={params.q}
            maxLength={INBOX_SEARCH_MAX}
            placeholder="Buscar contato, telefone ou caso…"
            autoComplete="off"
            className="h-9 min-w-0 flex-1 rounded-input border border-border-input bg-surface-subtle px-3 text-body text-text placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
          />
          {params.status !== "all" ? <input type="hidden" name="situacao" value={params.status} /> : null}
          {openId && params.caso ? <input type="hidden" name="caso" value={params.caso} /> : null}
          {openId && params.aba !== "resumo" ? <input type="hidden" name="aba" value={params.aba} /> : null}
          {openId && params.editar ? <input type="hidden" name="editar" value="1" /> : null}
          {!openId && params.sel ? <input type="hidden" name="sel" value={params.sel} /> : null}
          <button
            type="submit"
            aria-label="Buscar"
            className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-text-secondary transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
          >
            <Search size={15} aria-hidden />
          </button>
        </form>

        <nav aria-label="Filtrar pela situação do atendimento" className="mt-3">
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {INBOX_FILTERS.map((f) => {
              const active = params.status === f;
              return (
                <li key={f}>
                  <Link
                    href={inboxHref(openId, { ...params, status: f, page: 1 }, { keepCase: true }) as never}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-pill border px-2.5 text-meta font-semibold no-underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring",
                      active
                        ? "border-primary-border bg-primary-tint text-text"
                        : "border-border bg-transparent text-text-tertiary hover:bg-surface-hover hover:text-text",
                    )}
                  >
                    {INBOX_FILTER_LABEL[f]}
                    <span className="sr-only">: </span>
                    <span className={cn("tabular-nums", active ? "text-primary" : "text-text-muted")}>{counts[f]}</span>
                    <LinkPending />
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>

      {items.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-5 py-10 text-center">
          <div className="flex size-10 items-center justify-center rounded-card bg-primary-tint text-primary" aria-hidden>
            {filtered ? <SearchX size={18} /> : <MessageCircle size={18} />}
          </div>
          {filtered ? (
            <>
              <p className="m-0 text-body font-semibold text-text">Nenhuma conversa encontrada</p>
              <p className="m-0 max-w-[260px] text-meta text-text-tertiary">
                Nada corresponde à busca e à situação escolhidas.
              </p>
              <Link
                href={inboxHref(openId, {}, { keepCase: true }) as never}
                className="text-small font-semibold text-primary hover:underline"
              >
                Limpar busca e filtro
              </Link>
            </>
          ) : (
            <>
              <p className="m-0 text-body font-semibold text-text">Nenhuma conversa ainda</p>
              <p className="m-0 max-w-[260px] text-meta text-text-tertiary">
                Conversas aparecem aqui assim que uma mensagem (simulada) chegar. Peça a um administrador para configurar
                um canal em Configurações → Simulador de WhatsApp.
              </p>
            </>
          )}
        </div>
      ) : (
        <ScrollMemoryList
          storageKey={`conversas:rolagem:${params.q}|${params.status}|${params.page}`}
          className="m-0 min-h-0 flex-1 list-none divide-y divide-border overflow-y-auto p-0"
        >
          {items.map((c) => {
            const selected = c.id === highlightId;
            const name = c.contactName ?? (c.waId ? formatPhoneForDisplay(c.waId) : "Contato a definir");
            const preview = listPreview(c);
            return (
              <li key={c.id}>
                <Link
                  href={inboxHref(c.id, params) as never}
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    "flex gap-3 border-l-[3px] px-3 py-3 no-underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-ring",
                    selected ? "border-l-primary bg-surface-selected" : "border-l-transparent hover:bg-surface-hover",
                  )}
                >
                  <span
                    aria-hidden
                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-muted text-small font-bold text-text-secondary"
                  >
                    {c.contactName ? initialsOf(c.contactName) : "?"}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-body font-semibold text-text">{name}</span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <LinkPending />
                        {c.lastMessageAt ? (
                          <time dateTime={c.lastMessageAt} className="text-meta text-text-muted">
                            {formatListTime(c.lastMessageAt)}
                          </time>
                        ) : null}
                      </span>
                    </span>
                    <span className={cn("truncate text-meta text-text-tertiary", preview.isKind && "italic")}>
                      {preview.text}
                    </span>
                    <span className="mt-1 flex min-w-0 flex-wrap gap-1">
                      {c.caseItem ? (
                        <CaseSubjectChips subject={caseChipLabel(c.caseItem)} badge={caseBadge(c.caseItem)} />
                      ) : c.caseCount > 1 ? (
                        <span
                          title="Vários casos e nenhum vinculado a esta conversa"
                          className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-label font-bold text-text-secondary"
                        >
                          {caseCountLabel(c.caseCount)}
                          <span className="sr-only"> — nenhum vinculado a esta conversa</span>
                        </span>
                      ) : c.legalArea ? (
                        <span className="inline-flex min-w-0 max-w-full items-center rounded-full bg-neutral-bg px-2 py-0.5 text-label font-bold text-neutral">
                          <span className="truncate">{c.legalArea}</span>
                        </span>
                      ) : null}
                      <AttendanceChip status={c.attendanceStatus} />
                      {c.needsLinkReview ? (
                        <span className="rounded-full bg-warning-bg px-2 py-0.5 text-label font-bold text-warning">
                          Vínculo pendente
                        </span>
                      ) : null}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ScrollMemoryList>
      )}

      <ConversationsPagination page={page} total={total} pageSize={pageSize} hrefFor={hrefFor} />
    </>
  );
}
