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
 *  - protocolo e porta NUNCA são arbitrários (item 7 da auditoria
 *    pós-dry-run — defeito corrigido: só o hostname era conferido, então
 *    QUALQUER protocolo e QUALQUER porta reivindicando o mesmo hostname
 *    eram aceitos). Fora do domínio de desenvolvimento local — onde
 *    preview e e2e genuinamente variam porta —, a origem só é aceita em
 *    HTTPS, na porta padrão (443, implícita, nunca declarada);
 *  - `Vary: Origin` sempre que o cabeçalho existir, para caches
 *    intermediários não misturarem respostas de origens diferentes;
 *  - os cabeçalhos acompanham resposta de SUCESSO e de ERRO, desde que a
 *    origem seja autorizada — um erro de validação também precisa ser
 *    legível pelo JS da origem legítima;
 *  - sem `Origin` (chamada servidor-a-servidor, curl, etc.) não há nada
 *    para autorizar: CORS é um mecanismo de NAVEGADOR, e a ausência do
 *    cabeçalho não é tratada como origem inválida — mas um `Origin`
 *    PRESENTE e não autorizado É recusado, antes de qualquer gravação
 *    (ver handleFormSubmission, passo 2b): o CORS do navegador só impede
 *    o JS de LER a resposta, nunca impede um cliente que não é navegador
 *    de mandar a requisição com um `Origin` forjado.
 */

const LOCAL_DEV_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function matchAllowedOrigin(originHeader: string | null, allowedHostnames: string[]): string | null {
  if (!originHeader) return null;

  let url: URL;
  try {
    url = new URL(originHeader);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  const allowed = allowedHostnames.map((value) => value.toLowerCase());
  if (!allowed.includes(hostname)) return null;

  if (!LOCAL_DEV_HOSTNAMES.has(hostname) && (url.protocol !== "https:" || url.port !== "")) {
    return null;
  }

  return originHeader;
}

export function corsResponseHeaders(
  allowedOrigin: string | null,
  options?: { exposeHeaders?: string[] },
): Record<string, string> {
  if (!allowedOrigin) return {};
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allowedOrigin,
    Vary: "Origin",
  };
  if (options?.exposeHeaders?.length) {
    headers["Access-Control-Expose-Headers"] = options.exposeHeaders.join(", ");
  }
  return headers;
}

/**
 * Cabeçalhos de uma resposta de RECUSA (sucesso nunca passa por aqui —
 * ver route.ts). Achado de contrato/UX: o 429 de rate limit não informava
 * QUANDO tentar de novo. `retryAfterSeconds` só existe para essa recusa
 * específica (nunca para as outras) e vira o header padrão `Retry-After`,
 * em segundos — nunca um horário absoluto, nunca um contador interno
 * (`X-RateLimit-*` não é exigido nem adicionado). Só é exposto ao JS de
 * origem cross-origin quando essa origem já é autorizada — sem origem
 * autorizada, esta função devolve exatamente o que `corsResponseHeaders`
 * já devolvia: nenhum cabeçalho de CORS, a recusa continua intacta.
 */
export function failureResponseHeaders(
  allowedOrigin: string | null,
  retryAfterSeconds: number | undefined,
): Record<string, string> {
  const headers = corsResponseHeaders(
    allowedOrigin,
    retryAfterSeconds !== undefined ? { exposeHeaders: ["Retry-After"] } : undefined,
  );
  if (retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(retryAfterSeconds);
  }
  return headers;
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
