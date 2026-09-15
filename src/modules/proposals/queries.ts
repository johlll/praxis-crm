import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError } from "@/server/data/load-error";
import type { Database } from "@/server/types/database";

export type ProposalStatus = Database["public"]["Enums"]["proposal_status"];
export type ProposalChannel = Database["public"]["Enums"]["proposal_channel"];
export type FeeModel = Database["public"]["Enums"]["fee_model"];

export type ProposalListItem = {
  id: string;
  opportunityId: string;
  number: string;
  status: ProposalStatus;
  sentChannels: ProposalChannel[];
  sentAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  lockVersion: number;
  createdAt: string;
  /** Ausente para viewer; faixa para sales; exato para os demais — mesma
   * projeção de opportunity.valueCents/valueBand (A5). */
  valueCents?: number;
  valueBand?: string;
  feeModel?: FeeModel;
};

export class ProposalsLoadError extends DataLoadError {
  constructor(resource: string, cause?: unknown) {
    super(resource, cause);
    this.name = "ProposalsLoadError";
  }
}

function mapProposalRow(row: Record<string, unknown>): ProposalListItem {
  return {
    id: row.id as string,
    opportunityId: row.opportunity_id as string,
    number: row.number as string,
    status: row.status as ProposalStatus,
    sentChannels: (row.sent_channels as ProposalChannel[] | null) ?? [],
    sentAt: (row.sent_at as string | null) ?? null,
    decidedAt: (row.decided_at as string | null) ?? null,
    decisionNote: (row.decision_note as string | null) ?? null,
    lockVersion: row.lock_version as number,
    createdAt: row.created_at as string,
    ...(row.value_cents !== undefined ? { valueCents: row.value_cents as number } : {}),
    ...(row.value_band !== undefined ? { valueBand: row.value_band as string } : {}),
    ...(row.fee_model !== undefined ? { feeModel: row.fee_model as FeeModel } : {}),
  };
}

export async function listProposalsForLead(leadId: string): Promise<ProposalListItem[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_proposals_for_lead", { p_lead_id: leadId });

  if (error) {
    throw new ProposalsLoadError(`as propostas do lead ${leadId}`, error);
  }

  return ((data as unknown as Array<Record<string, unknown>> | null) ?? []).map(mapProposalRow);
}
