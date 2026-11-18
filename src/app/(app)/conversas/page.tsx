import type { Metadata } from "next";

import { ConversationsWorkspace } from "@/components/conversations/conversations-workspace";

export const metadata: Metadata = { title: "Conversas — Praxis CRM Jurídico" };

export default async function ConversasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ConversationsWorkspace conversationId={null} rawParams={await searchParams} />;
}
