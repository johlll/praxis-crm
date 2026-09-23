/**
 * CORS estrito para /api/forms/[endpointKey] (A11, item 3 da auditoria
 * pós-dry-run). Antes não existia CORS nenhum: sem `Access-Control-Allow-
 * Origin`, um navegador em OUTRO domínio conseguia enviar o POST (CORS
 * não bloqueia o envio de requisições "simples"/via fetch sem
 * preflight bem-sucedido não IMPEDE o servidor de processar — só impede
 * o JS de ler a resposta) mas, pior, uma origem qualquer também não
 * tinha como saber se estava AUTORIZADA antes de tentar, e o preflight
 * (OPTIONS) não existia — o navegador nunca recebia luz verde alguma.
 *
 * Regras:
 *  - a origem permitida é sempre a EXATA que veio no cabeçalho `Origin`
 *    (nunca "*"), e só quando o hostname dela está na lista de
 *    `allowed_hostnames` do PRÓPRIO endpoint — a mesma lista já usada
 *    para conferir o `hostname` do Turnstile;
 *  - `Vary: Origin` sempre que o cabeçalho existir, para caches
 *    intermediários não misturarem respostas de origens diferentes;
 *  - os cabeçalhos acompanham resposta de SUCESSO e de ERRO, desde que a
 *    origem seja autorizada — um erro de validação também precisa ser
 *    legível pelo JS da origem legítima;
 *  - sem `Origin` (chamada servidor-a-servidor, curl, etc.) não há nada
 *    para autorizar: CORS é um mecanismo de NAVEGADOR, e a ausência do
 *    cabeçalho não é tratada como origem inválida.
 */

export function matchAllowedOrigin(originHeader: string | null, allowedHostnames: string[]): string | null {
  if (!originHeader) return null;

  let hostname: string;
  try {
    hostname = new URL(originHeader).hostname.toLowerCase();
  } catch {
    return null;
  }

  const allowed = allowedHostnames.map((value) => value.toLowerCase());
  return allowed.includes(hostname) ? originHeader : null;
}

export function corsResponseHeaders(allowedOrigin: string | null): Record<string, string> {
  if (!allowedOrigin) return {};
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    Vary: "Origin",
  };
}

export function corsPreflightHeaders(allowedOrigin: string | null): Record<string, string> {
  if (!allowedOrigin) return {};
  return {
    ...corsResponseHeaders(allowedOrigin),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
  };
}
