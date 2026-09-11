import type { Metadata } from "next";
import Link from "next/link";
import { MessageCircle } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { listConversations } from "@/modules/conversations/queries";
import { EmptyState } from "@/components/feedback/empty-state";
import { ConversationsPagination } from "@/components/conversations/conversations-pagination";
import { MESSAGE_STATUS_LABEL } from "@/components/conversations/labels";

export const metadata: Metadata = { title: "Conversas — Praxis CRM Jurídico" };

function relativeDate(iso: string | null): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export default async function ConversasPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);

  const { items, total, pageSize } = await listConversations(workspaceId, { page });

  return (
    <>
      <Topbar
        title="Conversas"
        subtitle="Mensagens de WhatsApp — simulador interno (sem conexão real nesta fase)"
        user={user}
      />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[900px] flex-col gap-4">
          {items.length === 0 ? (
            <EmptyState
              icon={MessageCircle}
              title="Nenhuma conversa ainda"
              description="Conversas aparecem aqui assim que uma mensagem (simulada) chegar. Peça a um administrador para configurar um canal em Configurações → Simulador de WhatsApp."
            />
          ) : (
            <div className="overflow-hidden rounded-card border border-border bg-surface">
              <ul className="divide-y divide-border">
                {items.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/conversas/${c.id}` as never}
                      className="flex items-center justify-between gap-3 px-4 py-3 no-underline transition-colors hover:bg-surface-subtle"
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-body font-semibold text-text">
                            {c.contactName ?? "Contato a definir"}
                          </span>
                          {c.needsLinkReview ? (
                            <span className="shrink-0 rounded-full bg-warning-bg px-2 py-0.5 text-label font-bold text-warning">
                              Vínculo pendente
                            </span>
                          ) : null}
                        </div>
                        <span className="truncate text-meta text-text-tertiary">
                          {c.lastMessageDirection === "outbound" ? "Você: " : ""}
                          {c.lastMessageText ?? "Sem mensagens"}
                        </span>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-0.5">
                        <span className="text-meta text-text-tertiary">{relativeDate(c.lastMessageAt)}</span>
                        {c.lastMessageDirection === "outbound" && c.lastMessageStatus ? (
                          <span className="text-label text-text-muted">
                            {MESSAGE_STATUS_LABEL[c.lastMessageStatus]}
                          </span>
                        ) : null}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ConversationsPagination page={page} total={total} pageSize={pageSize} />
        </div>
      </main>
    </>
  );
}
