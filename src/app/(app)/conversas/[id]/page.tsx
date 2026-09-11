import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { roleHasPermission } from "@/lib/roles";
import { getConversation, listConversationMessages, listContactConsents, hasActiveWhatsAppConsent } from "@/modules/conversations/queries";
import { listOpportunities, type OpportunityListItem } from "@/modules/opportunities/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { ConversationThread } from "@/components/conversations/conversation-thread";
import { LinkReviewBanner } from "@/components/conversations/link-review-banner";
import { ConsentPanel } from "@/components/conversations/consent-panel";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const conversation = await getConversation(id);
  return {
    title: conversation ? `${conversation.contactName ?? "Contato a definir"} — Conversa — Praxis CRM Jurídico` : "Conversa — Praxis CRM Jurídico",
  };
}

export default async function ConversaDetalhePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();

  const conversation = await getConversation(id);
  if (!conversation) notFound();

  // Erro real de carregamento propaga daqui até error.tsx — nunca vira
  // "conversa vazia" (ver docs/decisoes/a7-conversas.md §11).
  const { items, hasMore } = await listConversationMessages(id);

  const [consents, openOpportunityItems] = await Promise.all([
    conversation.contactId ? listContactConsents(conversation.contactId) : Promise.resolve([]),
    conversation.leadId && !conversation.opportunityId
      ? listOpportunities(workspaceId, { leadId: conversation.leadId, status: "open" }).then((r) => r.items)
      : Promise.resolve<OpportunityListItem[]>([]),
  ]);

  const canSend = roleHasPermission(user.role, "conversation.send");
  const canSimulate = roleHasPermission(user.role, "conversation.simulate");
  const consentBlocked = !hasActiveWhatsAppConsent(consents);
  const recipientWaId = conversation.waId.replace(/^\+/, "");

  return (
    <>
      <Topbar
        title={conversation.contactName ?? "Contato a definir"}
        subtitle={conversation.legalArea ? `${conversation.legalArea} — ${conversation.waId}` : conversation.waId}
        user={user}
      />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[760px] flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {conversation.contactId ? (
                <Link href={`/contatos/${conversation.contactId}` as never} className="text-meta text-primary hover:underline">
                  Ver contato
                </Link>
              ) : null}
              {conversation.leadId ? (
                <Link href={`/leads/${conversation.leadId}` as never} className="text-meta text-primary hover:underline">
                  Ver lead
                </Link>
              ) : null}
            </div>
            <span className="rounded-full bg-purple-bg px-2 py-0.5 text-label font-bold text-purple">
              SIMULAÇÃO — sem conexão real com o WhatsApp
            </span>
          </div>

          {conversation.needsLinkReview ? (
            <LinkReviewBanner
              conversationId={conversation.id}
              contactId={conversation.contactId}
              leadId={conversation.leadId}
              contactCandidates={conversation.linkCandidateContacts.map((c) => ({ id: c.id, label: c.name }))}
              leadCandidates={conversation.linkCandidateLeads.map((l) => ({ id: l.id, label: l.legalArea }))}
              openOpportunities={openOpportunityItems.map((o) => ({ id: o.id, label: o.stageName }))}
            />
          ) : null}

          <div className="rounded-card border border-border bg-surface p-4">
            <ConversationThread
              conversationId={conversation.id}
              initialItems={items}
              initialHasMore={hasMore}
              canSend={canSend}
              canSimulateStatus={canSimulate}
              phoneNumberId={conversation.phoneNumberId}
              recipientWaId={recipientWaId}
              consentBlocked={consentBlocked}
            />
          </div>

          {conversation.contactId ? (
            <ConsentPanel
              contactId={conversation.contactId}
              consents={consents}
              canManage={roleHasPermission(user.role, "contact.consent_manage")}
            />
          ) : null}
        </div>
      </main>
    </>
  );
}
