import type { Metadata } from "next";

import { ConversationsWorkspace } from "@/components/conversations/conversations-workspace";
import { getConversation } from "@/modules/conversations/queries";
import { isUuid } from "@/modules/conversations/inbox";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const conversation = isUuid(id) ? await getConversation(id) : null;
  return {
    title: conversation ? `${conversation.contactName ?? "Contato a definir"} — Conversa — Praxis CRM Jurídico` : "Conversa — Praxis CRM Jurídico",
  };
}

export default async function ConversaDetalhePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  return <ConversationsWorkspace conversationId={id} rawParams={await searchParams} />;
}
