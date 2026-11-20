import { cache } from "react";

import { Skeleton } from "@/components/feedback/loading-state";
import { roleHasPermission, type Role } from "@/lib/roles";
import {
  hasActiveWhatsAppConsent,
  listContactConsents,
  listConversationMessages,
  messageAuthorKind,
  type ConversationDetail,
  type MessageListItem,
} from "@/modules/conversations/queries";
import { loadWhatsAppSendUi } from "@/modules/conversations/whatsapp-send";
import { loadConversationContext, type ConversationContext } from "@/modules/conversations/context";
import { MESSAGE_AUTHOR_LABEL, contentKindLabel, type InboxParams } from "@/modules/conversations/inbox";
import type { EvidenceCandidate } from "@/modules/conversations/context-format";
import { listAllOpportunities, type OpportunityListItem } from "@/modules/opportunities/queries";
import { isContactAnonymized } from "@/modules/contacts/queries";
import { caseBadge, caseChipLabel, caseCountLabel } from "@/modules/conversations/case-display";
import type { AttendanceStatus } from "@/modules/status-tracks/schema";
import { ConversationThread } from "./conversation-thread";
import { LinkReviewBanner } from "./link-review-banner";
import { ConsentPanel } from "./consent-panel";
import { ConversationContextPanel } from "./conversation-context-panel";
import { AttendanceChip, CaseSubjectChips } from "./context/case-badge";

/**
 * Partes da conversa que carregam depois da lista e do cabeçalho (Conversas + IA, PR 2): as mensagens e o
 * painel de contexto são componentes assíncronos independentes, cada um dentro do seu <Suspense>. Assim a
 * lista não é trocada por um esqueleto (nem perde a rolagem) quando a pessoa muda de conversa, e as
 * mensagens aparecem sem esperar o contexto.
 */

// Lidos pelos dois componentes: o cache da requisição evita buscar duas vezes.
const messagesFor = cache((conversationId: string) => listConversationMessages(conversationId));
const consentsFor = cache((contactId: string) => listContactConsents(contactId));

/** Mensagens recentes oferecidas como evidência opcional (referência; o texto não é gravado em lugar nenhum). */
function evidenceCandidates(items: MessageListItem[]): EvidenceCandidate[] {
  return items
    .slice(-12)
    .reverse()
    .map((m) => ({
      id: m.id,
      createdAt: m.createdAt,
      authorLabel: MESSAGE_AUTHOR_LABEL[messageAuthorKind(m)],
      excerpt: m.bodyText.trim().slice(0, 80) || (m.contentKind ? contentKindLabel(m.contentKind) : "Mensagem sem texto"),
    }));
}

type Session = { userId: string; role: Role; workspaceId: string };

/** Revisão de vínculo (se pendente) + histórico de mensagens + compositor. */
export async function ThreadSection({ conversation, session }: { conversation: ConversationDetail; session: Session }) {
  // Erro real de carregamento propaga daqui até error.tsx — nunca vira
  // "conversa vazia" (ver docs/decisoes/a7-conversas.md §11).
  const { items, hasMore } = await messagesFor(conversation.id);

  const [consents, openOpportunityItems] = await Promise.all([
    conversation.contactId ? consentsFor(conversation.contactId) : Promise.resolve([]),
    conversation.needsLinkReview && conversation.leadId && !conversation.opportunityId
      ? listAllOpportunities(session.workspaceId, { leadId: conversation.leadId, status: "open" })
      : Promise.resolve<OpportunityListItem[]>([]),
  ]);

  const canSend = roleHasPermission(session.role, "conversation.send");
  // Canal real da B3: janela, motivo de bloqueio e templates. Canal legado da A7: `null`.
  const sendContext = canSend
    ? await loadWhatsAppSendUi({ workspaceId: session.workspaceId, actorUserId: session.userId }, conversation.id)
    : null;

  return (
    <>
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
        canSimulateStatus={roleHasPermission(session.role, "conversation.simulate")}
        phoneNumberId={conversation.phoneNumberId}
        recipientWaId={conversation.waId.replace(/^\+/, "")}
        consentBlocked={!hasActiveWhatsAppConsent(consents)}
        sendContext={sendContext}
      />
    </>
  );
}

/**
 * Caso e situação do atendimento no cabeçalho da conversa. Lê o MESMO contexto do painel (cache da
 * requisição): o caso mostrado aqui é sempre o do painel, inclusive quando foi escolhido na URL. Com vários
 * casos e nenhum vínculo inequívoco mostra "N casos" — nunca um andamento atribuído ao cliente inteiro.
 * Falha ou ausência de acesso: não mostra nada (o painel explica).
 */
export async function ConversationCaseLine({
  conversation,
  params,
  session,
}: {
  conversation: ConversationDetail;
  params: InboxParams;
  session: Session;
}) {
  let context: ConversationContext | null = null;
  try {
    context = await loadConversationContext(conversation.id, params.caso, session.workspaceId, session.userId, params.aba, params.editar);
  } catch {
    return null;
  }
  if (!context) return null;
  const att = (context.attendance.state.status ?? "nao_informado") as AttendanceStatus;
  const focus = context.focus;
  const n = context.cases.items.length;
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
      {focus ? (
        <CaseSubjectChips subject={caseChipLabel(focus.option)} badge={caseBadge(focus.option)} />
      ) : n > 1 ? (
        <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-label font-bold text-text-secondary">
          {caseCountLabel(n)}
          <span className="sr-only"> — nenhum vinculado a esta conversa</span>
        </span>
      ) : conversation.legalArea ? (
        <span className="inline-flex min-w-0 max-w-full items-center rounded-full bg-neutral-bg px-2 py-0.5 text-label font-bold text-neutral">
          <span className="truncate">{conversation.legalArea}</span>
        </span>
      ) : null}
      <AttendanceChip status={att} showPrefix />
    </div>
  );
}

/** Conteúdo do painel de contexto: caso em foco (cabeçalho, abas, edição) e consentimento. */
export async function ContextSection({
  conversation,
  params,
  session,
}: {
  conversation: ConversationDetail;
  params: InboxParams;
  session: Session;
}) {
  // O contexto (situação, caso, histórico) pode falhar sem derrubar a conversa:
  // as mensagens e o envio continuam, e o painel mostra o erro com "tentar de novo".
  let context: ConversationContext | null = null;
  let contextFailed = false;
  const [{ items }, consents, anonymized] = await Promise.all([
    messagesFor(conversation.id),
    conversation.contactId ? consentsFor(conversation.contactId) : Promise.resolve([]),
    // C3b: contato anonimizado é só consulta (o banco recusa as escritas); as tarefas também ficam só leitura.
    conversation.contactId ? isContactAnonymized(conversation.contactId).catch(() => true) : Promise.resolve(false),
  ]);
  try {
    context = await loadConversationContext(conversation.id, params.caso, session.workspaceId, session.userId, params.aba, params.editar);
  } catch (error) {
    contextFailed = true;
    console.error("Falha ao carregar o contexto da conversa", error);
  }

  return (
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
        editAttendance: roleHasPermission(session.role, "conversation.attendance_edit"),
        editProgress: roleHasPermission(session.role, "case.progress_edit"),
        pauseCommercial: roleHasPermission(session.role, "opportunity.edit"),
        editActivities: !anonymized && roleHasPermission(session.role, "activity.edit"),
        assignCaseNumber: !anonymized && roleHasPermission(session.role, "case.number_assign"),
        manageServiceCatalog: roleHasPermission(session.role, "service_catalog.manage"),
        addCaseNote: !anonymized && roleHasPermission(session.role, "case_note.add"),
      }}
      draftScope={`${session.workspaceId}:${session.userId}`}
      evidence={evidenceCandidates(items)}
      consentNeedsAttention={Boolean(conversation.contactId) && !hasActiveWhatsAppConsent(consents)}
      consentSlot={
        conversation.contactId ? (
          <ConsentPanel
            contactId={conversation.contactId}
            consents={consents}
            canManage={roleHasPermission(session.role, "contact.consent_manage")}
          />
        ) : (
          <p className="m-0 text-meta text-text-tertiary">
            Sem contato vinculado: o consentimento aparece depois que o vínculo for resolvido.
          </p>
        )
      }
    />
  );
}

/** Esqueleto das mensagens enquanto carregam (mesma forma da tela final, sem texto inventado). */
export function ThreadSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex min-h-0 flex-1 flex-col">
      <span className="sr-only">Carregando as mensagens…</span>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-4">
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="ml-auto h-12 w-1/2" />
        <Skeleton className="h-20 w-3/5" />
        <Skeleton className="ml-auto h-12 w-2/5" />
        <Skeleton className="h-14 w-1/2" />
      </div>
      <div className="shrink-0 border-t border-border px-4 py-3">
        <Skeleton className="h-[62px] w-full" />
      </div>
    </div>
  );
}

/** Esqueleto do painel de contexto enquanto carrega. */
export function PanelSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col gap-5 px-4 py-4">
      <span className="sr-only">Carregando o contexto…</span>
      <Skeleton className="h-10 w-full" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-9 w-full" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  );
}
