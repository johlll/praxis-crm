import { isAuthApiError } from "@supabase/supabase-js";

export const SIGN_IN_INVALID_CREDENTIALS_MESSAGE = "E-mail ou senha incorretos.";
export const SIGN_IN_UNAVAILABLE_MESSAGE = "Não foi possível entrar agora. Tente novamente em instantes.";

/** Decide pelo código oficial do Auth (`AuthApiError.code`), nunca pelo texto
 * do erro, e nunca repassa esse texto. Conta inexistente e senha errada
 * chegam como o mesmo `invalid_credentials`; `email_not_confirmed` só vem
 * depois de a senha ser aceita, então não revela a existência da conta a
 * quem não a conhece. Queda de rede, 5xx (`AuthRetryableFetchError`),
 * resposta ilegível (`AuthUnknownError`) e qualquer código não previsto são
 * falha do serviço — pedir para redigitar a senha nesses casos esconderia a
 * causa real. */
export function signInErrorMessage(error: unknown): string {
  if (isAuthApiError(error)) {
    switch (error.code) {
      case "invalid_credentials":
        return SIGN_IN_INVALID_CREDENTIALS_MESSAGE;
      case "email_not_confirmed":
        return "Confirme seu e-mail pelo link que enviamos antes de entrar.";
      case "over_request_rate_limit":
        return "Muitas tentativas de entrada. Aguarde alguns minutos e tente novamente.";
    }
  }
  return SIGN_IN_UNAVAILABLE_MESSAGE;
}
