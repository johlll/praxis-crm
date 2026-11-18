import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, MessageCircle } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { cn } from "@/lib/cn";
import { initialsOf } from "@/lib/initials";
import { formatPhoneForDisplay } from "@/lib/format-phone";
import { roleHasPermission } from "@/lib/roles";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import {
  getConversation,
  hasActiveWhatsAppConsent,
  listContactConsents,
  listConversationInbox,
  listConversationMessages,
  messageAuthorKind,
  type MessageListItem,
} from "@/modules/conversations/queries";
import { loadWhatsAppSendUi } from "@/modules/conversations/whatsapp-send";
import { loadConversationContext, type ConversationContext } from "@/modules/conversations/context";
import {
  MESSAGE_AUTHOR_LABEL,
  contentKindLabel,
  inboxHref,
  isUuid,
  parseInboxParams,
} from "@/modules/conversations/inbox";
import type { EvidenceCandidate } from "@/modules/conversations/context-format";
import { listAllOpportunities, type OpportunityListItem } from "@/modules/opportunities/queries";
import { ConversationThread } from "./conversation-thread";
import { LinkReviewBanner } from "./link-review-banner";
import { ConsentPanel } from "./consent-panel";
import { InboxList } from "./inbox-list";
import { ConversationContextPanel } from "./conversation-context-panel";
import { ContextPanelPane, ContextPanelProvider, ContextPanelToggle } from "./context-panel-shell";

type RawParams = Record<string, string | string[] | undefined>;

/** Mensagens recentes oferecidas como evidência opcional (referência; o texto não é gravado em lugar nenhum). */
function evidenceCandidates(items: MessageListItem[]): EvidenceCandidate[] {
  return items
    .slice(-12)
    .reverse()
    .map((m) => ({
      id: m.id,
      createdAt: m.createdAt,
      authorLabel: MESSAGE_AUTHOR_LABEL[messageAuthorKind(m)],
      excerpt:
        m.bodyText.trim().slice(0, 80) || (m.contentKind ? contentKindLabel(m.contentKind) : "Mensagem sem texto"),
    }));
}

/**
 * Tela de Conversas em três partes (Conversas + IA, PR 2): lista à esquerda,
 * mensagens no centro e contexto do atendimento e do caso à direita. Serve as
 * duas rotas (`/conversas` e `/conversas/[id]`), então os links existentes, a
 * abertura direta da conversa, o recarregar e o Voltar/Avançar continuam
 * valendo — o estado da tela (busca, situação, página, caso em foco) está na URL.
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

  const subtitle = "Mensagens de WhatsApp — simulador interno (sem conexão real nesta fase)";

  if (!conversationId) {
    return (
      <>
        <Topbar title="Conversas" subtitle={subtitle} user={user} />
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

  // Erro real de carregamento propaga daqui até error.tsx — nunca vira
  // "conversa vazia" (ver docs/decisoes/a7-conversas.md §11).
  const { items, hasMore } = await listConversationMessages(conversationId);

  const [consents, openOpportunityItems] = await Promise.all([
    conversation.contactId ? listContactConsents(conversation.contactId) : Promise.resolve([]),
    conversation.leadId && !conversation.opportunityId
      ? listAllOpportunities(workspaceId, { leadId: conversation.leadId, status: "open" })
      : Promise.resolve<OpportunityListItem[]>([]),
  ]);

  // O contexto (situação, caso, histórico) pode falhar sem derrubar a conversa:
  // as mensagens e o envio continuam, e o painel mostra o erro com "tentar de novo".
  let context: ConversationContext | null = null;
  let contextFailed = false;
  try {
    context = await loadConversationContext(conversationId, params.caso, conversation.leadId);
  } catch (error) {
    contextFailed = true;
    console.error("Falha ao carregar o contexto da conversa", error);
  }

  const canSend = roleHasPermission(user.role, "conversation.send");
  // Canal real da B3: janela, motivo de bloqueio e templates. Canal legado da A7: `null`.
  const sendContext = canSend ? await loadWhatsAppSendUi({ workspaceId, actorUserId: user.id }, conversationId) : null;
  const canSimulate = roleHasPermission(user.role, "conversation.simulate");
  const consentBlocked = !hasActiveWhatsAppConsent(consents);
  const recipientWaId = conversation.waId.replace(/^\+/, "");
  const name = conversation.contactName ?? (conversation.waId ? formatPhoneForDisplay(conversation.waId) : "Contato a definir");

  return (
    <>
      <Topbar title="Conversas" subtitle={subtitle} user={user} />
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
                    ? `${conversation.waId ? formatPhoneForDisplay(conversation.waId) : "Telefone não informado"}${conversation.legalArea ? ` · ${conversation.legalArea}` : ""}`
                    : "Contato ainda não vinculado"}
                </p>
              </div>
              <ContextPanelToggle label="Contexto" />
            </header>

            <p className="m-0 shrink-0 bg-purple-bg px-4 py-1 text-center text-label font-bold text-purple">
              SIMULAÇÃO — sem conexão real com o WhatsApp
            </p>

            {conversation.needsLinkReview ? (
              <div id="revisao-vinculo" className="shrink-0 border-b border-border p-3">
                <LinkReviewBanner
                  conversationId={conversation.id}
                  contactId={conversation.contactId}
                  leadId={conversation.leadId}
                  contactCandidates={conversation.linkCandidateContacts.map((c) => ({ id: c.id, label: c.name }))}
                  leadCandidates={conversation.linkCandidateLeads.map((l) => ({ id: l.id, label: l.legalArea }))}
                  openOpportunities={openOpportunityItems.map((o) => ({ id: o.id, label: o.stageName }))}
                />
              </div>
            ) : null}

            <ConversationThread
              key={conversation.id}
              conversationId={conversation.id}
              initialItems={items}
              initialHasMore={hasMore}
              canSend={canSend}
              canSimulateStatus={canSimulate}
              phoneNumberId={conversation.phoneNumberId}
              recipientWaId={recipientWaId}
              consentBlocked={consentBlocked}
              sendContext={sendContext}
            />
          </section>

          <ContextPanelPane title="Contexto do atendimento">
            <ConversationContextPanel
              conversation={{
                id: conversation.id,
                contactId: conversation.contactId,
                contactName: conversation.contactName,
                waId: conversation.waId,
                leadId: conversation.leadId,
                legalArea: conversation.legalArea,
                needsLinkReview: conversation.needsLinkReview,
              }}
              context={context}
              contextFailed={contextFailed}
              params={params}
              permissions={{
                editAttendance: roleHasPermission(user.role, "conversation.attendance_edit"),
                editProgress: roleHasPermission(user.role, "case.progress_edit"),
                pauseCommercial: roleHasPermission(user.role, "opportunity.edit"),
              }}
              evidence={evidenceCandidates(items)}
              consentSlot={
                conversation.contactId ? (
                  <ConsentPanel
                    contactId={conversation.contactId}
                    consents={consents}
                    canManage={roleHasPermission(user.role, "contact.consent_manage")}
                  />
                ) : (
                  <p className="m-0 text-meta text-text-tertiary">
                    Sem contato vinculado: o consentimento aparece depois que o vínculo for resolvido.
                  </p>
                )
              }
            />
          </ContextPanelPane>
        </main>
      </ContextPanelProvider>
    </>
  );
}
