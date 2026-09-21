/**
 * Origem do IP do visitante (A11).
 *
 * Regras, nesta ordem de importância:
 *  1. NUNCA aceitar IP vindo do CORPO da requisição — é dado do
 *     atacante, não do transporte.
 *  2. Derivar só de cabeçalho CONFIÁVEL da infraestrutura. Na Vercel,
 *     `x-vercel-forwarded-for` é preenchido pela própria borda e
 *     sobrescreve o que o cliente mandar. `x-forwarded-for` é aceito
 *     APENAS fora de produção/preview (desenvolvimento local, onde não
 *     existe borda) — em produção ele é forjável pelo cliente.
 *  3. O IP completo nunca é persistido nem enviado a terceiros: só o
 *     HMAC (ver payload-crypto.hmacIp).
 */

export type ClientIpResult =
  | { ok: true; ip: string }
  | { ok: false; reason: "missing_trusted_header" | "invalid_ip" };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidIp(value: string): boolean {
  const v4 = IPV4.exec(value);
  if (v4) return v4.slice(1).every((part) => Number(part) <= 255 && String(Number(part)) === part);
  // IPv6: aceitação conservadora — só hexadecimais e ":" (com "::").
  return /^[0-9a-f:]+$/i.test(value) && value.includes(":") && value.length <= 45;
}

function normalize(value: string): string {
  const trimmed = value.trim().toLowerCase();
  // IPv4 mapeado em IPv6 vira o IPv4 — para que o mesmo visitante conte
  // como um só no rate limit, venha como vier.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(trimmed);
  return mapped ? mapped[1]! : trimmed;
}

export function clientIpFromHeaders(
  headers: Headers,
  options: { trustForwardedFor: boolean },
): ClientIpResult {
  const vercel = headers.get("x-vercel-forwarded-for");
  const raw = vercel ?? (options.trustForwardedFor ? headers.get("x-forwarded-for") : null);

  if (!raw) return { ok: false, reason: "missing_trusted_header" };

  // O cabeçalho pode trazer uma cadeia; o PRIMEIRO é o cliente original.
  const candidate = normalize(raw.split(",")[0] ?? "");
  if (!candidate || !isValidIp(candidate)) return { ok: false, reason: "invalid_ip" };

  return { ok: true, ip: candidate };
}

/** Em produção e preview, só o cabeçalho da borda da Vercel vale. */
export function shouldTrustForwardedFor(): boolean {
  const vercelEnv = process.env.VERCEL_ENV;
  return vercelEnv !== "production" && vercelEnv !== "preview";
}
