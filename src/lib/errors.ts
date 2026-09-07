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
};

const GENERIC_MESSAGE = "Não foi possível concluir a operação. Tente novamente.";

export function toUserMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const raw = String((error as { message?: unknown }).message ?? "");
    const mapped = KNOWN_ERROR_MESSAGES[raw];
    if (mapped) return mapped;
  }
  return GENERIC_MESSAGE;
}
