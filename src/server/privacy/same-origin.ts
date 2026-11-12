/**
 * As rotas de privacidade têm efeito colateral (registro, auditoria, anonimização), então só a
 * PRÓPRIA origem pode dispará-las. Falha fechado: Origin ausente, malformado ou diferente = recusa.
 * A origem esperada vem da URL da própria requisição — nunca de cabeçalho que o chamador controla
 * (x-forwarded-host, host). Comparação exata: esquema + host + porta.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
