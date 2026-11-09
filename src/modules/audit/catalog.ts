import { ROLES, ROLE_LABEL, type Role } from "@/lib/roles";

/**
 * Rótulos da tela de auditoria (B5). Puramente dados, sem dependência de
 * servidor: serve a página, o filtro e os testes.
 *
 * O CÓDIGO da ação (`membership.role_changed`) é o que o banco grava e o que
 * o filtro envia; o rótulo é só apresentação. Uma ação que ainda não está
 * aqui aparece com o próprio código — nunca some da lista e nunca quebra a
 * tela.
 */

export type AuditActionGroup = {
  label: string;
  actions: ReadonlyArray<{ code: string; label: string }>;
};

function group(label: string, entries: ReadonlyArray<readonly [string, string]>): AuditActionGroup {
  return { label, actions: entries.map(([code, text]) => ({ code, label: text })) };
}

export const AUDIT_ACTION_GROUPS: readonly AuditActionGroup[] = [
  group("Equipe e acesso", [
    ["workspace.created", "Workspace criado"],
    ["workspace.ownership_transferred", "Posse do workspace transferida"],
    ["invitation.created", "Convite criado"],
    ["invitation.cancelled", "Convite cancelado"],
    ["invitation.accepted", "Convite aceito"],
    ["membership.role_changed", "Papel alterado"],
    ["membership.removed", "Membro removido"],
  ]),
  group("Contatos e consentimento", [
    ["contact.created", "Contato criado"],
    ["contact.updated", "Contato atualizado"],
    ["contact.cpf_set", "CPF/CNPJ cadastrado"],
    ["contact.cpf_cleared", "CPF/CNPJ removido"],
    ["contact.merged", "Contatos mesclados"],
    ["contact.merge_undone", "Mesclagem desfeita"],
    ["duplicate_candidate.dismissed", "Sugestão de duplicidade dispensada"],
    ["consent.registered", "Consentimento registrado"],
    ["consent.revoked", "Consentimento revogado"],
  ]),
  group("Leads", [
    ["lead.created", "Lead criado"],
    ["lead.updated", "Lead atualizado"],
    ["lead.assigned", "Responsável do lead alterado"],
    ["lead.status_changed", "Status do lead alterado"],
    ["lead.value_set", "Valor do lead definido"],
    ["lead_note.created", "Anotação criada"],
    ["conflict_check.updated", "Verificação de conflito atualizada"],
  ]),
  group("Oportunidades e pipeline", [
    ["opportunity.created", "Oportunidade criada"],
    ["opportunity.stage_moved", "Oportunidade movida de etapa"],
    ["opportunity.won", "Oportunidade ganha"],
    ["opportunity.lost", "Oportunidade perdida"],
    ["pipeline.stages_reordered", "Etapas reordenadas"],
    ["pipeline_stage.created", "Etapa criada"],
    ["pipeline_stage.updated", "Etapa atualizada"],
    ["pipeline_stage.deleted", "Etapa excluída"],
    ["stage_requirement.created", "Requisito de etapa criado"],
    ["stage_requirement.updated", "Requisito de etapa atualizado"],
    ["stage_requirement.deleted", "Requisito de etapa excluído"],
    ["lost_reason.created", "Motivo de perda criado"],
    ["lost_reason.deactivated", "Motivo de perda desativado"],
    ["stage_auto_activity_rule.set", "Atividade automática da etapa definida"],
    ["stage_auto_activity_rule.deleted", "Atividade automática da etapa removida"],
  ]),
  group("Atividades", [
    ["activity.created", "Atividade criada"],
    ["activity.updated", "Atividade atualizada"],
    ["activity.completed", "Atividade concluída"],
    ["activity.rescheduled", "Atividade reagendada"],
    ["activity.reassigned", "Responsável da atividade alterado"],
    ["activity.deleted", "Atividade excluída"],
    ["activity.auto_created", "Atividade criada automaticamente"],
  ]),
  group("Clientes", [
    ["client.status_changed", "Status do cliente alterado"],
    ["client.owner_transferred", "Responsável do cliente transferido"],
  ]),
  group("Propostas", [
    ["proposal.created", "Proposta criada"],
    ["proposal.sent", "Proposta enviada"],
    ["proposal.decided", "Proposta decidida"],
    ["proposal.document.generation_started", "Geração do PDF iniciada"],
    ["proposal.document.ready", "PDF da proposta gerado"],
    ["proposal.document.failed", "Falha ao gerar o PDF"],
    ["proposal.email.queued", "E-mail da proposta na fila"],
    ["proposal.email.accepted_by_provider", "E-mail da proposta aceito pelo provedor"],
    ["proposal.email.failed", "Falha no e-mail da proposta"],
  ]),
  group("Conversas e mensagens", [
    ["conversation.link_resolved", "Vínculo da conversa resolvido"],
    ["message.received", "Mensagem recebida"],
    ["message.sent", "Mensagem enviada"],
    ["message.observed", "Mensagem observada no WhatsApp"],
    ["whatsapp_channel.created", "Canal do simulador criado"],
  ]),
  group("WhatsApp (canal e envio)", [
    ["whatsapp.channel.created", "Canal de WhatsApp criado"],
    ["whatsapp.channel.updated", "Canal de WhatsApp atualizado"],
    ["whatsapp.channel.paused", "Canal de WhatsApp pausado"],
    ["whatsapp.channel.reactivated", "Canal de WhatsApp reativado"],
    ["whatsapp.channel.disconnected", "Canal de WhatsApp desconectado"],
    ["whatsapp.channel.send_enabled", "Envio do canal ligado"],
    ["whatsapp.channel.send_disabled", "Envio do canal desligado"],
    ["whatsapp.channel.credential_stored", "Credencial do canal guardada"],
    ["whatsapp.template.upserted", "Template de WhatsApp registrado"],
    ["whatsapp.message.queued", "Mensagem de WhatsApp na fila"],
    ["whatsapp.message.send_accepted", "Envio aceito pelo WhatsApp"],
    ["whatsapp.message.send_rejected", "Envio recusado pelo WhatsApp"],
    ["whatsapp.message.send_uncertain", "Envio com resultado incerto"],
    ["whatsapp.inbox.conflict", "Conflito na entrada do WhatsApp"],
    ["whatsapp.inbox.failed", "Falha na entrada do WhatsApp"],
    ["whatsapp.inbox.purged", "Entrada do WhatsApp expurgada"],
    ["whatsapp.internal_identity.created", "Identidade interna cadastrada"],
    ["whatsapp.internal_identity.activated", "Identidade interna ativada"],
    ["whatsapp.identity.changed", "Identidade do WhatsApp alterada"],
    ["whatsapp.identity.review_required", "Identidade do WhatsApp exige revisão"],
  ]),
  group("Agenda (Google)", [
    ["calendar.connection.connected", "Agenda conectada"],
    ["calendar.connection.disconnected", "Agenda desconectada"],
    ["calendar.connection.needs_reauth", "Agenda exige nova autorização"],
    ["calendar.connection.calendar_selected", "Agenda escolhida"],
    ["calendar.link.created", "Compromisso vinculado à agenda"],
    ["calendar.link.needs_attention", "Vínculo da agenda exige atenção"],
    ["calendar.link.recovered", "Vínculo da agenda recuperado"],
    ["calendar.link.recovery_completed", "Recuperação do vínculo concluída"],
    ["calendar.link.sync_pending", "Sincronização do vínculo pendente"],
    ["calendar.sync.success", "Sincronização da agenda concluída"],
    ["calendar.sync.failed", "Sincronização da agenda falhou"],
    ["calendar.sync.access_lost", "Acesso à agenda perdido"],
    ["calendar.sync.token_reset", "Sincronização da agenda reiniciada"],
    ["calendar.channel.active", "Notificações da agenda ativas"],
    ["calendar.channel.polling_only", "Agenda sincronizada por consulta periódica"],
    ["calendar.channel.stopped", "Notificações da agenda paradas"],
    ["calendar.conflict.recorded", "Conflito de agenda registrado"],
    ["calendar.conflict.restored", "Conflito de agenda restaurado"],
    ["calendar.inbound.applied", "Alteração vinda do Google aplicada"],
    ["calendar.inbound.not_authorized", "Alteração vinda do Google não autorizada"],
  ]),
  group("Formulários e captação", [
    ["form_endpoint.created", "Formulário criado"],
    ["form_endpoint.updated", "Formulário atualizado"],
    ["form_endpoint.disabled", "Formulário desativado"],
    ["form_endpoint.key_rotated", "Chave do formulário trocada"],
    ["continuity_reference.issued", "Referência de continuidade emitida"],
    ["continuity_reference.revoked", "Referência de continuidade revogada"],
    ["touchpoint.link_corrected", "Vínculo de atribuição corrigido"],
    ["webhook_event.expired_unprocessed", "Envio de formulário expirou sem processar"],
    ["webhook_event.expiring_unprocessed", "Envio de formulário prestes a expirar"],
    ["webhook_event.purged", "Envio de formulário expurgado"],
    ["webhook_event.stuck", "Envio de formulário travado"],
  ]),
];

const ACTION_LABEL: ReadonlyMap<string, string> = new Map(
  AUDIT_ACTION_GROUPS.flatMap((g) => g.actions.map((a) => [a.code, a.label] as const)),
);

/** Rótulo da ação; sem rótulo conhecido, o próprio código. */
export function auditActionLabel(action: string): string {
  return ACTION_LABEL.get(action) ?? action;
}

// ---------------------------------------------------------------------
// Detalhes sanitizados
//
// O banco (private.audit_log_safe_details) já devolve só estas chaves, com
// valor de vocabulário fechado. Esta é a SEGUNDA barreira: a interface
// repete a lista de permissão e descarta o que não conhecer, de modo que um
// defeito futuro no banco não faz um dado sensível aparecer na tela.
// ---------------------------------------------------------------------

const ROLE_DETAIL_KEYS = [
  "role",
  "from_role",
  "to_role",
  "new_owner_previous_role",
  "previous_owner_new_role",
] as const;

export const AUDIT_DETAIL_KEYS = [...ROLE_DETAIL_KEYS, "environment", "provider"] as const;
export type AuditDetailKey = (typeof AUDIT_DETAIL_KEYS)[number];
export type AuditDetails = Partial<Record<AuditDetailKey, string>>;

const DETAIL_LABEL: Record<AuditDetailKey, string> = {
  role: "Papel",
  from_role: "Papel anterior",
  to_role: "Papel novo",
  new_owner_previous_role: "Papel anterior do novo proprietário",
  previous_owner_new_role: "Novo papel de quem transferiu",
  environment: "Ambiente",
  provider: "Provedor",
};

// Map, não objeto: chaves vindas de fora ("constructor", "__proto__") não
// podem casar com propriedades herdadas.
const ENVIRONMENT_LABEL: ReadonlyMap<string, string> = new Map([
  ["preview", "Preview (testes)"],
  ["production", "Produção"],
]);
const PROVIDER_LABEL: ReadonlyMap<string, string> = new Map([
  ["simulated", "Simulador"],
  ["ycloud", "YCloud"],
  ["meta", "Meta"],
]);

/** Pessoa-alvo (já resolvida pelo banco) das duas ações que têm uma. */
const TARGET_LABEL: ReadonlyMap<string, string> = new Map([
  ["workspace.ownership_transferred", "Novo proprietário"],
  ["membership.removed", "Pessoa removida"],
]);

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Mantém só chave conhecida com valor de vocabulário conhecido. */
export function sanitizeAuditDetails(raw: unknown): AuditDetails {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: AuditDetails = {};
  for (const key of AUDIT_DETAIL_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    const valid = (ROLE_DETAIL_KEYS as readonly string[]).includes(key)
      ? isRole(value)
      : key === "environment"
        ? ENVIRONMENT_LABEL.has(value)
        : PROVIDER_LABEL.has(value);
    if (valid) out[key] = value;
  }
  return out;
}

export type AuditDetailLine = { label: string; value: string };

/** Linhas "rótulo: valor" prontas para mostrar. */
export function auditDetailLines(action: string, details: AuditDetails, targetName: string | null): AuditDetailLine[] {
  const lines: AuditDetailLine[] = [];
  const targetLabel = TARGET_LABEL.get(action);
  if (targetLabel && targetName) lines.push({ label: targetLabel, value: targetName });
  for (const key of AUDIT_DETAIL_KEYS) {
    const value = details[key];
    if (value === undefined) continue;
    const text =
      key === "environment"
        ? (ENVIRONMENT_LABEL.get(value) ?? value)
        : key === "provider"
          ? (PROVIDER_LABEL.get(value) ?? value)
          : isRole(value)
            ? ROLE_LABEL[value]
            : value;
    lines.push({ label: DETAIL_LABEL[key], value: text });
  }
  return lines;
}
