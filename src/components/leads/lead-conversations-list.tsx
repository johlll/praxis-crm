"use client";

import { useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EmptyState } from "@/components/feedback/empty-state";
import { loadMoreLeadConversationsAction } from "@/modules/conversations/actions";
import type { ConversationListItem } from "@/modules/conversations/queries";

export function LeadConversationsList({
  leadId,
  initialItems,
  initialHasMore,
}: {
  leadId: string;
  initialItems: ConversationListItem[];
  initialHasMore: boolean;
}) {
  const [items, setItems] = useState(initialItems);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncedInitialItems, setSyncedInitialItems] = useState(initialItems);

  if (initialItems !== syncedInitialItems) {
    setSyncedInitialItems(initialItems);
    setItems(initialItems);
    setHasMore(initialHasMore);
    setPage(1);
    setError(null);
  }

  async function handleLoadMore() {
    setPending(true);
    setError(null);
    const result = await loadMoreLeadConversationsAction(leadId, page + 1);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setItems((prev) => [...prev, ...result.items]);
    setHasMore(result.hasMore);
    setPage((p) => p + 1);
  }

  if (items.length === 0 && !hasMore) {
    return (
      <EmptyState
        title="Nenhuma conversa vinculada"
        description="Conversas de WhatsApp ligadas a este lead aparecem aqui."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {items.map((c) => (
          <li key={c.id} className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-body font-semibold text-text">{c.waId}</span>
              {c.lastMessageText ? (
                <span className="truncate text-meta text-text-secondary">{c.lastMessageText}</span>
              ) : null}
            </div>
            <Link href={`/conversas/${c.id}`} className="ml-auto shrink-0">
              <Button type="button" variant="secondary" size="sm">
                Abrir conversa
              </Button>
            </Link>
          </li>
        ))}
      </ul>
      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {hasMore ? (
        <Button type="button" variant="secondary" size="sm" onClick={handleLoadMore} disabled={pending}>
          {pending ? "Carregando…" : "Carregar mais conversas"}
        </Button>
      ) : null}
    </div>
  );
}
