/**
 * Nenhum erro interno, de rede ou SQL cru chega à interface (checklist
 * §8). As funções RPC do banco levantam códigos curtos e simbólicos
 * (`insufficient_permission`, `invitation_expired`...) de propósito, para
 * serem mapeados aqui — o que não estiver mapeado cai num texto genérico,
 * nunca no texto original do erro.
 */
const KNOWN_ERROR_MESSAGES: Record<string, string> = {
  authentication_required: "Sua sessão expirou. Entre novamente.",
  workspace_creation_requires_authentication: "Sua sessão expirou. Entre novamente.",
  insufficient_permission: "Você não tem permissão para fazer isso.",
  invalid_email: "Informe um e-mail válido.",
  already_a_member: "Essa pessoa já é membro deste workspace.",
  invitation_not_found: "Convite não encontrado ou link inválido.",
  invitation_not_pending: "Este convite não está mais disponível.",
  invitation_expired: "Este convite expirou. Peça um novo.",
  invitation_email_mismatch:
    "Entre com o mesmo e-mail para o qual este convite foi enviado.",
  cannot_demote_last_owner:
    "Não é possível rebaixar o único proprietário do workspace.",
  cannot_remove_last_owner:
    "Não é possível remover o único proprietário do workspace.",
  membership_not_found: "Membro não encontrado.",
  // A3 — contatos, identidade e deduplicação.
  contact_not_found: "Contato não encontrado.",
  phone_not_found: "Telefone não encontrado.",
  email_not_found: "E-mail não encontrado.",
  cannot_merge_contact_with_itself: "Não é possível mesclar um contato com ele mesmo.",
  cross_workspace_merge_denied: "Não é possível mesclar contatos de workspaces diferentes.",
  contact_already_merged: "Um dos contatos já foi mesclado anteriormente.",
  no_sensitive_data: "Este contato não tem CPF/CNPJ cadastrado.",
  reason_required: "Informe o motivo da consulta para revelar este dado.",
  candidate_not_found: "Sugestão de duplicidade não encontrada.",
  candidate_not_pending: "Esta sugestão já foi decidida.",
  merge_not_found: "Mesclagem não encontrada.",
  merge_already_undone: "Esta mesclagem já foi desfeita.",
  // A4 — leads.
  lead_not_found: "Lead não encontrado.",
  assignee_not_a_member: "Essa pessoa não é membro ativo deste workspace.",
  invalid_value: "Valor inválido.",
  expected_version_required: "Não foi possível confirmar a versão do lead. Recarregue a página e tente de novo.",
  // A5 — pipeline e oportunidades.
  opportunity_not_found: "Oportunidade não encontrada.",
  pipeline_not_found: "Pipeline não encontrado.",
  pipeline_has_no_stages: "Este pipeline não tem nenhuma etapa configurada.",
  stage_not_found: "Etapa não encontrada.",
  stage_not_in_pipeline: "Esta etapa não pertence a este pipeline.",
  stage_unchanged: "A oportunidade já está nesta etapa.",
  stage_mismatch: "A etapa mudou desde que a página carregou. Recarregue e tente de novo.",
  stage_is_terminal: "Esta etapa é marcada como ganho/perda — use os botões \"Ganhou\"/\"Perdeu\" em vez de mover para ela.",
  stage_requirements_pending: "Preencha os requisitos pendentes antes de avançar.",
  win_requirements_pending: "Preencha os requisitos obrigatórios para ganhar antes de concluir.",
  stage_has_open_opportunities: "Mova as oportunidades abertas desta etapa antes de marcá-la como ganho/perda.",
  stage_cannot_be_won_and_lost: "Uma etapa não pode ser de ganho e de perda ao mesmo tempo.",
  stage_occupied: "Esta etapa tem oportunidades vinculadas e não pode ser excluída.",
  stage_set_mismatch: "A lista de etapas mudou. Recarregue a página e tente de novo.",
  requirement_not_found: "Requisito não encontrado.",
  opportunity_closed: "Esta oportunidade já foi encerrada (ganha ou perdida).",
  invalid_lost_reason: "Selecione um motivo de perda válido.",
  fee_model_required: "Selecione o modelo de honorários.",
  lost_reason_not_found: "Motivo de perda não encontrado.",
  // A6 — atividades e agenda interna. stage_not_found já existe acima
  // (A5) — a mesma regra de negócio (etapa inexistente) vale para
  // set_stage_auto_activity_rule()/delete_stage_auto_activity_rule().
  activity_not_found: "Atividade não encontrada.",
  due_date_required: "Informe a data.",
  activity_assignee_no_access: "Essa pessoa não tem acesso a este lead — só quem já acessa o lead pode ficar responsável pela atividade.",
  // A7 — conversas + simulador de WhatsApp.
  channel_not_found: "Canal de WhatsApp não encontrado.",
  channel_disabled: "Este canal de WhatsApp está desativado.",
  channel_phone_number_id_taken: "Já existe um canal com este identificador de número.",
  conversation_not_found: "Conversa não encontrada.",
  conversation_not_linked: "Vincule esta conversa a um contato antes de enviar uma mensagem.",
  message_not_found: "Mensagem não encontrada.",
  invalid_status_event: "Evento de status inválido.",
  consent_required: "Sem consentimento vigente para enviar mensagem por este canal — registre o consentimento do contato primeiro.",
  contact_required: "Selecione um contato para vincular a esta conversa.",
  lead_contact_mismatch: "Este lead não pertence ao contato selecionado.",
  lead_required_for_opportunity: "Selecione o lead antes de escolher a oportunidade.",
  opportunity_lead_mismatch: "Esta oportunidade não pertence ao lead selecionado.",
  purpose_required: "Informe a finalidade do consentimento.",
  consent_not_found: "Registro de consentimento não encontrado.",
  consent_already_revoked: "Este consentimento já foi revogado.",
};

/** update_lead_basic_fields()/assign_lead()/set_lead_status()/set_lead_value()
 * levantam "lead_conflict" quando `updated_at` não bate com o que o
 * formulário carregou — outra pessoa editou entre a abertura da tela e o
 * envio. Nunca sobrescreve silenciosamente. */
const LEAD_CONFLICT_MESSAGE =
  "Este lead foi alterado por outra pessoa enquanto você editava. Recarregue a página e tente de novo.";

/** move_opportunity_stage()/win_opportunity()/lose_opportunity() levantam
 * "opportunity_conflict" tanto para lock_version divergente quanto para
 * status já não ser 'open' (fechada, ou já processada por outra
 * chamada) — em ambos os casos o servidor tem o estado confirmado mais
 * recente; a interface deve recarregar, nunca sobrescrever. */
const OPPORTUNITY_CONFLICT_MESSAGE =
  "Esta oportunidade foi alterada por outra pessoa (ou já foi encerrada). Recarregue a página para ver o estado atual.";

/** update_activity()/complete_activity()/reschedule_activity()/
 * reassign_activity() levantam "activity_conflict" tanto para
 * lock_version divergente quanto para status incompatível com a
 * operação (ex.: concluir/reagendar uma atividade já concluída) — mesmo
 * princípio de opportunity_conflict acima. */
const ACTIVITY_CONFLICT_MESSAGE =
  "Esta atividade foi alterada por outra pessoa (ou já foi concluída). Recarregue a página para ver o estado atual.";

const GENERIC_MESSAGE = "Não foi possível concluir a operação. Tente novamente.";

/** unmerge_contact() levanta "undo_conflict: <lista dinâmica>" — nunca
 * cabe num match exato do mapa acima. Mensagem fixa, sem repetir o detalhe
 * técnico (nomes de tabela/id) para quem usa a tela. */
const UNDO_CONFLICT_MESSAGE =
  "Não é possível desfazer automaticamente: algo foi alterado depois da mesclagem. Resolva manualmente.";

export function toUserMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const raw = String((error as { message?: unknown }).message ?? "");
    if (raw.startsWith("undo_conflict")) return UNDO_CONFLICT_MESSAGE;
    if (raw === "lead_conflict") return LEAD_CONFLICT_MESSAGE;
    if (raw === "opportunity_conflict") return OPPORTUNITY_CONFLICT_MESSAGE;
    if (raw === "activity_conflict") return ACTIVITY_CONFLICT_MESSAGE;
    const mapped = KNOWN_ERROR_MESSAGES[raw];
    if (mapped) return mapped;
  }
  return GENERIC_MESSAGE;
}
