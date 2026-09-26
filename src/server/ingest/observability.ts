/**
 * Diagnóstico interno sanitizado para os caminhos que a borda pública da
 * A11 devolve como o MESMO erro genérico (`invalid_submission`, contrato
 * §1 — nenhuma recusa pode ser distinguível de fora). Sem isto, uma
 * recusa real e uma anomalia transitória são indistinguíveis também POR
 * DENTRO, o que impede diagnosticar uma recorrência.
 *
 * Regra de ouro: nunca o valor, só a CLASSIFICAÇÃO. Nome, e-mail,
 * telefone, resposta livre, IP, token do Turnstile, segredo de bypass e
 * qualquer chave nunca entram aqui — só código do motivo, `path`/`code`
 * de issues do Zod (nunca a mensagem, que em tese poderia ecoar entrada),
 * e metadados operacionais (ids de endpoint/workspace, contagens).
 */

export type InvalidSubmissionReason =
  | "json_parse_error"
  | "schema_validation_failed"
  | "honeypot_filled"
  | "contract_version_mismatch"
  | "answers_schema_validation_failed"
  | "client_ip_unresolved";

type LogContext = { form_endpoint_id: string | null; workspace_id: string | null };

/**
 * Só `code` e `path` (juntado por ".") de cada issue — nunca `message` nem
 * `input`. Tipado estruturalmente (não pelo tipo interno do Zod) porque só
 * os dois campos usados importam aqui.
 */
export function sanitizeZodIssues(
  issues: readonly { code: string; path: readonly PropertyKey[] }[],
): { code: string; path: string }[] {
  return issues.map((issue) => ({ code: issue.code, path: issue.path.join(".") }));
}

/** Mesmo formato JSON estruturado já usado em src/app/api/cron/retention/route.ts. */
export function logInvalidSubmission(
  reason: InvalidSubmissionReason,
  context: LogContext,
  details?: Record<string, unknown>,
): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "a11.ingest.invalid_submission",
      reason,
      form_endpoint_id: context.form_endpoint_id,
      workspace_id: context.workspace_id,
      ...details,
    }),
  );
}
