"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ActivitiesSection } from "@/components/activities/activities-section";
import { loadMoreLeadActivitiesAction } from "@/modules/activities/actions";
import type { ActivityListItem } from "@/modules/activities/queries";
import type { TeamMember } from "@/modules/team/queries";

/**
 * Envolve `ActivitiesSection` (reaproveitada sem mudança) com paginação
 * real — a carga inicial da página já busca com status "all", mas sem
 * "carregar mais" um lead com muitas atividades acabaria com o restante
 * descartado em silêncio (achado do review pós-CI, mesma classe do
 * achado da timeline).
 */
export function LeadActivitiesSection({
  leadId,
  members,
  canEdit,
  initialItems,
  initialHasMore,
}: {
  leadId: string;
  members: TeamMember[];
  canEdit: boolean;
  initialItems: ActivityListItem[];
  initialHasMore: boolean;
}) {
  const [items, setItems] = useState(initialItems);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncedInitialItems, setSyncedInitialItems] = useState(initialItems);

  // Mesmo padrão adotado em LeadTimeline: reajusta durante a renderização
  // quando o servidor manda uma página inicial nova (após revalidatePath
  // de uma Server Action irmã), em vez de um useEffect com setState.
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
    const result = await loadMoreLeadActivitiesAction(leadId, page + 1);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setItems((prev) => [...prev, ...result.items]);
    setHasMore(result.hasMore);
    setPage((p) => p + 1);
  }

  return (
    <div className="flex flex-col gap-2">
      <ActivitiesSection leadId={leadId} activities={items} members={members} canEdit={canEdit} />
      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {hasMore ? (
        <Button type="button" variant="secondary" size="sm" onClick={handleLoadMore} disabled={pending}>
          {pending ? "Carregando…" : "Carregar mais atividades"}
        </Button>
      ) : null}
    </div>
  );
}
