import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError } from "@/server/data/load-error";
import type { AttributionModel } from "@/modules/forms/schema";

/**
 * Leituras de atribuição (A11).
 *
 * A unidade é sempre a OPORTUNIDADE — nunca o lead. A A5 permite um lead
 * com várias oportunidades, e uma nunca empresta origem à outra
 * (contrato §9).
 */

export type TouchpointHistoryEntry = {
  id: string;
  action: "assign" | "unassign";
  opportunityId: string | null;
  reason: string | null;
  actorName: string | null;
  createdAt: string;
};

export type TouchpointItem = {
  id: string;
  position: number;
  occurredAt: string | null;
  receivedAt: string;
  normalizedOccurredAt: string;
  normalizationCode: string | null;
  channel: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  gclid: string | null;
  fbclid: string | null;
  landingUrl: string | null;
  referrer: string | null;
  leadId: string | null;
  originalOpportunityId: string | null;
  effectiveOpportunityId: string | null;
  currentLinkId: string | null;
  history: TouchpointHistoryEntry[];
  consent: { decision: string; purposeCode: string; textVersion: string | null; decidedAt: string } | null;
};

export type OpportunityAttribution = {
  opportunityId: string;
  stageName: string;
  status: string;
  wonAt: string | null;
  firstTouchId: string | null;
  lastTouchId: string | null;
  conversionId: string | null;
};

export type LeadAttribution = {
  leadId: string;
  sequence: TouchpointItem[];
  opportunities: OpportunityAttribution[];
};

export class AttributionLoadError extends DataLoadError {}

type Raw = Record<string, unknown>;

const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

export async function getLeadAttribution(leadId: string): Promise<LeadAttribution | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_lead_attribution", { p_lead_id: leadId });

  if (error) throw new AttributionLoadError(`a atribuição do lead ${leadId}`, error);
  if (!data) return null;

  const raw = data as unknown as Raw;
  const sequence = Array.isArray(raw.sequence) ? (raw.sequence as Raw[]) : [];
  const opportunities = Array.isArray(raw.opportunities) ? (raw.opportunities as Raw[]) : [];

  return {
    leadId: String(raw.lead_id),
    sequence: sequence.map((row) => {
      const consent = row.consent as Raw | null;
      return {
        id: String(row.id),
        position: Number(row.position ?? 0),
        occurredAt: str(row.occurred_at),
        receivedAt: String(row.received_at),
        normalizedOccurredAt: String(row.normalized_occurred_at),
        normalizationCode: str(row.normalization_code),
        channel: String(row.channel),
        source: str(row.source),
        medium: str(row.medium),
        campaign: str(row.campaign),
        content: str(row.content),
        term: str(row.term),
        gclid: str(row.gclid),
        fbclid: str(row.fbclid),
        landingUrl: str(row.landing_url),
        referrer: str(row.referrer),
        leadId: str(row.lead_id),
        originalOpportunityId: str(row.original_opportunity_id),
        effectiveOpportunityId: str(row.effective_opportunity_id),
        currentLinkId: str(row.current_link_id),
        history: (Array.isArray(row.history) ? (row.history as Raw[]) : []).map((entry) => ({
          id: String(entry.id),
          action: entry.action === "unassign" ? "unassign" : "assign",
          opportunityId: str(entry.opportunity_id),
          reason: str(entry.reason),
          actorName: str(entry.actor_name),
          createdAt: String(entry.created_at),
        })),
        consent: consent
          ? {
              decision: String(consent.decision),
              purposeCode: String(consent.purpose_code),
              textVersion: str(consent.text_version),
              decidedAt: String(consent.decided_at),
            }
          : null,
      };
    }),
    opportunities: opportunities.map((row) => ({
      opportunityId: String(row.opportunity_id),
      stageName: String(row.stage_name),
      status: String(row.status),
      wonAt: str(row.won_at),
      firstTouchId: str(row.first_touch_id),
      lastTouchId: str(row.last_touch_id),
      conversionId: str(row.conversion_id),
    })),
  };
}

export type DashboardAttribution = {
  model: AttributionModel;
  periodDays: number;
  source: string | null;
  unit: string;
  createdInPeriod: number;
  wonInPeriod: number;
  unattributedCreated: number;
  sources: { source: string | null; created: number; won: number }[];
};

export class DashboardAttributionLoadError extends DataLoadError {}

export async function getDashboardAttribution(
  workspaceId: string,
  filters: {
    periodDays: number;
    model: AttributionModel;
    source: string | null;
    assignedTo: string | null;
    onlyUnassigned: boolean;
    legalArea: string | null;
  },
): Promise<DashboardAttribution> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_dashboard_attribution", {
    p_workspace_id: workspaceId,
    p_period_days: filters.periodDays,
    p_model: filters.model,
    ...(filters.source ? { p_source: filters.source } : {}),
    ...(filters.assignedTo ? { p_assigned_to: filters.assignedTo } : {}),
    p_only_unassigned: filters.onlyUnassigned,
    ...(filters.legalArea ? { p_legal_area: filters.legalArea } : {}),
  });

  if (error || !data) {
    // Nunca zero fictício: falha de consulta vira erro tratado.
    throw new DashboardAttributionLoadError(`a atribuição do workspace ${workspaceId}`, error ?? "resposta vazia");
  }

  const raw = data as unknown as Raw;
  return {
    model: String(raw.model) as AttributionModel,
    periodDays: Number(raw.period_days ?? 0),
    source: str(raw.source),
    unit: String(raw.unit ?? "opportunity"),
    createdInPeriod: Number(raw.created_in_period ?? 0),
    wonInPeriod: Number(raw.won_in_period ?? 0),
    unattributedCreated: Number(raw.unattributed_created ?? 0),
    sources: (Array.isArray(raw.sources) ? (raw.sources as Raw[]) : []).map((row) => ({
      source: str(row.source),
      created: Number(row.created ?? 0),
      won: Number(row.won ?? 0),
    })),
  };
}
