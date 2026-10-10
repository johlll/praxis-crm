/**
 * Mensagens do retorno da autorização do Google (`?agenda=<desfecho>`). Só
 * desfechos conhecidos viram texto; qualquer outro valor é ignorado — nada
 * da URL é exibido.
 */

type Level = "success" | "warning" | "danger";

const MESSAGES: Record<string, { level: Level; text: string }> = {
  connected: { level: "success", text: "Conta Google conectada." },
  cancelled: { level: "warning", text: "A autorização foi cancelada no Google. Nada foi conectado." },
  invalid_state: {
    level: "danger",
    text: "Esta autorização não é válida ou já foi usada. Nada foi conectado; comece de novo por “Conectar com Google”.",
  },
  expired: { level: "danger", text: "A autorização demorou mais de 10 minutos e expirou. Comece de novo." },
  session_mismatch: {
    level: "danger",
    text: "A autorização foi iniciada por outra sessão ou outro escritório. Nada foi conectado; comece de novo com a sua conta.",
  },
  wrong_environment: { level: "danger", text: "A autorização foi iniciada em outro ambiente do CRM. Nada foi conectado." },
  browser_mismatch: {
    level: "danger",
    text: "A autorização precisa terminar no mesmo navegador em que começou. Nada foi conectado; comece de novo.",
  },
  wrong_origin: {
    level: "warning",
    text: "Para conectar o Google Agenda, use este endereço do CRM e clique em “Conectar com Google” novamente.",
  },
  partial_scopes: {
    level: "danger",
    text: "Nem todas as permissões pedidas foram concedidas (agenda, disponibilidade e lista de agendas). Nada foi guardado; conecte de novo e marque todas.",
  },
  refresh_missing: {
    level: "danger",
    text: "O Google não devolveu a autorização permanente para esta conexão. Conecte de novo; se persistir, remova o acesso do Praxis em myaccount.google.com/permissions e conecte outra vez.",
  },
  account_mismatch: {
    level: "danger",
    text: "Esta conexão é de outra conta Google. Para trocar de conta, desconecte a atual primeiro. Nada foi alterado.",
  },
  account_in_use: {
    level: "danger",
    text: "Esta conta Google já está conectada por outra pessoa do escritório neste ambiente. Nada foi conectado.",
  },
  identity_invalid: { level: "danger", text: "Não foi possível confirmar a conta Google (e-mail verificado). Nada foi conectado." },
  forbidden: { level: "danger", text: "Você não tem permissão para conectar uma agenda." },
  not_configured: { level: "warning", text: "A integração com o Google Agenda não está configurada neste ambiente." },
  failed: { level: "danger", text: "Não foi possível concluir a conexão com o Google agora. Nada foi guardado; tente de novo." },
};

export function oauthOutcomeMessage(outcome: string | undefined | null): { level: Level; text: string } | null {
  if (!outcome || !Object.hasOwn(MESSAGES, outcome)) return null;
  return MESSAGES[outcome]!;
}
