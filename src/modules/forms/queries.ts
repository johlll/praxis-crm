import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError } from "@/server/data/load-error";

/**
 * Leitura dos endpoints de formulário (A11).
 *
 * Passa pela RPC `list_form_endpoints` (owner/admin) — as tabelas são
 * deny-all, então não existe SELECT direto nem para a tela.
 */

export type FormEndpoint = {
  id: string;
  name: string;
  status: "active" | "disabled";
  disabledAt: string | null;
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
  legalArea: string;
  initialActivityType: string;
  initialActivityDueMinutes: number;
  captureMode: "new_intake" | "continuity";
  contractVersion: number;
  turnstileAction: string;
  allowedHostnames: string[];
  publicKey: string | null;
  revokedKeyCount: number;
  receivedEvents: number;
  createdAt: string;
};

export class FormEndpointsLoadError extends DataLoadError {}

type Raw = Record<string, unknown>;

export async function listFormEndpoints(workspaceId: string): Promise<FormEndpoint[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_form_endpoints", { p_workspace_id: workspaceId });

  if (error) {
    // Nunca confunde "falhou" com "nenhum formulário": a tela mostra erro
    // tratado, como nas fases anteriores.
    throw new FormEndpointsLoadError(`os formulários do workspace ${workspaceId}`, error);
  }

  return (Array.isArray(data) ? (data as Raw[]) : []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    status: row.status === "disabled" ? "disabled" : "active",
    disabledAt: (row.disabled_at as string | null) ?? null,
    pipelineId: String(row.pipeline_id),
    pipelineName: String(row.pipeline_name),
    stageId: String(row.stage_id),
    stageName: String(row.stage_name),
    legalArea: String(row.legal_area),
    initialActivityType: String(row.initial_activity_type),
    initialActivityDueMinutes: Number(row.initial_activity_due_minutes ?? 0),
    captureMode: row.capture_mode === "continuity" ? "continuity" : "new_intake",
    contractVersion: Number(row.contract_version ?? 1),
    turnstileAction: String(row.turnstile_action),
    allowedHostnames: Array.isArray(row.allowed_hostnames) ? (row.allowed_hostnames as string[]) : [],
    publicKey: (row.public_key as string | null) ?? null,
    revokedKeyCount: Number(row.revoked_key_count ?? 0),
    receivedEvents: Number(row.received_events ?? 0),
    createdAt: String(row.created_at),
  }));
}
