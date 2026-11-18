import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, MessageCircle } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { cn } from "@/lib/cn";
import { initialsOf } from "@/lib/initials";
import { formatPhoneForDisplay } from "@/lib/format-phone";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { getConversation, listConversationInbox } from "@/modules/conversations/queries";
import { inboxHref, isUuid, parseInboxParams } from "@/modules/conversations/inbox";
import { InboxList } from "./inbox-list";
import { ContextSection, ConversationCaseLine, PanelSkeleton, ThreadSection, ThreadSkeleton } from "./conversation-pane";
import { ContextPanelPane, ContextPanelProvider, ContextPanelToggle } from "./context-panel-shell";

type RawParams = Record<string, string | string[] | undefined>;

const SUBTITLE = "Mensagens de WhatsApp — simulador interno (sem conexão real nesta fase)";

/**
 * Tela de Conversas em três partes (Conversas + IA, PR 2): lista à esquerda,
 * mensagens no centro e contexto do atendimento e do caso à direita. Serve as
 * duas rotas (`/conversas` e `/conversas/[id]`), então os links existentes, a
 * abertura direta da conversa, o recarregar e o Voltar/Avançar continuam
 * valendo — o estado da tela (busca, situação, página, caso em foco) está na URL.
 *
 * Ordem de carregamento: a lista e o cabeçalho da conversa aparecem primeiro; as mensagens e o contexto
 * chegam depois, cada um com o seu esqueleto. A existência da conversa é conferida antes de qualquer
 * transmissão, para uma conversa inexistente ou fora do alcance continuar sendo um 404 de verdade.
 */
export async function ConversationsWorkspace({
  conversationId,
  rawParams,
}: {
  conversationId: string | null;
  rawParams: RawParams;
}) {
  if (conversationId && !isUuid(conversationId)) notFound();

  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const params = parseInboxParams(rawParams);

  const inbox = await listConversationInbox(workspaceId, { page: params.page, status: params.status, search: params.q });

  // Página além da última (filtro mudou, itens saíram): volta para a última que existe.
  if (inbox.items.length === 0 && inbox.total > 0 && params.page > 1) {
    const lastPage = Math.max(1, Math.ceil(inbox.total / inbox.pageSize));
    redirect(inboxHref(conversationId, { ...params, page: lastPage }, { keepCase: true }) as never);
  }

  const listPane = (
    <section
      aria-label="Lista de conversas"
      className={cn(
        "min-h-0 w-full flex-col overflow-hidden rounded-card border border-border bg-surface min-[768px]:flex min-[768px]:w-[300px] min-[768px]:shrink-0 min-[1400px]:w-[320px]",
        conversationId ? "hidden" : "flex",
      )}
    >
      <InboxList inbox={inbox} params={params} openId={conversationId} />
    </section>
  );

  if (!conversationId) {
    return (
      <>
        <Topbar title="Conversas" subtitle={SUBTITLE} user={user} />
        <main className="flex min-h-0 flex-1 gap-3 px-3 pb-3 md:px-5 md:pb-5">
          {listPane}
          <section
            aria-label="Conversa"
            className="hidden min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 rounded-card border border-dashed border-border bg-surface px-6 text-center min-[768px]:flex"
          >
            <div className="flex size-11 items-center justify-center rounded-card bg-primary-tint text-primary" aria-hidden>
              <MessageCircle size={20} />
            </div>
            <p className="m-0 text-body font-semibold text-text">Selecione uma conversa</p>
            <p className="m-0 max-w-[320px] text-meta text-text-tertiary">
              Escolha uma conversa na lista para ver as mensagens, a situação do atendimento e o caso do cliente.
            </p>
          </section>
        </main>
      </>
    );
  }

  const conversation = await getConversation(conversationId);
  if (!conversation) notFound();

  const session = { userId: user.id, role: user.role, workspaceId };
  const name = conversation.contactName ?? (conversation.waId ? formatPhoneForDisplay(conversation.waId) : "Contato a definir");

  return (
    <>
      <Topbar title="Conversas" subtitle={SUBTITLE} user={user} />
      <ContextPanelProvider>
        <main className="flex min-h-0 flex-1 gap-3 px-3 pb-3 md:px-5 md:pb-5">
          {listPane}

          <section
            aria-label={`Conversa com ${name}`}
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-card border border-border bg-surface"
          >
            <header className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2.5 md:px-4">
              <Link
                href={inboxHref(null, { ...params, sel: conversationId }) as never}
                aria-label="Voltar para a lista de conversas"
                className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-text-secondary transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring min-[768px]:hidden"
              >
                <ArrowLeft size={16} aria-hidden />
              </Link>
              <span
                aria-hidden
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-body font-bold text-text-secondary"
              >
                {conversation.contactName ? initialsOf(conversation.contactName) : "?"}
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <h2 className="m-0 truncate text-lead font-bold text-text">{name}</h2>
                <p className="m-0 truncate text-meta text-text-tertiary">
                  {conversation.contactName
                    ? conversation.waId
                      ? formatPhoneForDisplay(conversation.waId)
                      : "Telefone não informado"
                    : "Contato ainda não vinculado"}
                </p>
                {/* Caso mostrado no painel + situação do atendimento (separada). Carrega com o painel, sem segurar a conversa. */}
                <Suspense key={conversationId} fallback={null}>
                  <ConversationCaseLine conversation={conversation} params={params} session={session} />
                </Suspense>
              </div>
              <ContextPanelToggle label="Contexto" />
            </header>

            <p className="m-0 shrink-0 bg-purple-bg px-4 py-1 text-center text-label font-bold text-purple">
              SIMULAÇÃO — sem conexão real com o WhatsApp
            </p>

            {/* A chave é a conversa: ao trocar de conversa o esqueleto aparece aqui; ao mudar só a lista
                (filtro, busca, página) ou o caso em foco, a conversa aberta e o rascunho continuam. */}
            <Suspense key={conversationId} fallback={<ThreadSkeleton />}>
              <ThreadSection conversation={conversation} session={session} />
            </Suspense>
          </section>

          <ContextPanelPane title="Caso e atendimento">
            <Suspense key={conversationId} fallback={<PanelSkeleton />}>
              <ContextSection conversation={conversation} params={params} session={session} />
            </Suspense>
          </ContextPanelPane>
        </main>
      </ContextPanelProvider>
    </>
  );
}
