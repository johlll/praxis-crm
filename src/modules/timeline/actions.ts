"use server";

import { getLeadTimelinePage, type LeadTimelineEvent, type LeadTimelineEventType } from "./queries";

export async function loadMoreLeadTimelineAction(
  leadId: string,
  types: LeadTimelineEventType[] | null,
  before?: { occurredAt: string; id: string },
): Promise<{ ok: true; items: LeadTimelineEvent[]; hasMore: boolean } | { ok: false; error: string }> {
  try {
    const result = await getLeadTimelinePage(leadId, { types: types ?? undefined, before });
    return { ok: true, ...result };
  } catch {
    return { ok: false, error: "Não foi possível carregar eventos. Tente novamente." };
  }
}
