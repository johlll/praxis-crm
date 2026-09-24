import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError } from "@/server/data/load-error";
import { answersConfigSchema, type AnswersConfig } from "@/modules/forms/schema";

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
  // Config REAL dos campos extras (item 6/8 da auditoria pós-dry-run):
  // valida de novo com o MESMO schema da borda — nunca confia às cegas
  // no que veio do banco só porque list_form_endpoints é owner/admin.
  answersConfig: AnswersConfig;
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

  return (Array.isArray(data) ? (data as Raw[]) : []).map((row) => {
    // `answers_config` corrompido NUNCA vira `{fields: []}` em silêncio
    // (defeito corrigido — item 2 da terceira rodada de auditoria pós-
    // dry-run): um fallback silencioso aqui já causou perda de dados de
    // verdade — a tela de edição nascia achando que o endpoint não tinha
    // campo nenhum configurado, e salvar QUALQUER outra alteração
    // reenviava esse fallback vazio como se fosse a configuração atual,
    // apagando os campos realmente gravados no banco. A leitura inteira
    // FALHA, como qualquer outra falha operacional (mesmo contrato de
    // `DataLoadError`) — nunca finge que o endpoint está vazio.
    const answersConfigResult = answersConfigSchema.safeParse(row.answers_config);
    if (!answersConfigResult.success) {
      throw new FormEndpointsLoadError(
        `os formulários do workspace ${workspaceId} (answers_config inválido no endpoint ${String(row.id)})`,
      );
    }

    return {
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
      answersConfig: answersConfigResult.data,
      publicKey: (row.public_key as string | null) ?? null,
      revokedKeyCount: Number(row.revoked_key_count ?? 0),
      receivedEvents: Number(row.received_events ?? 0),
      createdAt: String(row.created_at),
    } satisfies FormEndpoint;
  });
}
