import { headers } from "next/headers";

/**
 * Origem da própria requisição, para montar `emailRedirectTo` sem
 * hardcodar um domínio. Server Actions disparadas de formulário carregam o
 * cabeçalho Origin; Route Handlers têm host/x-forwarded-proto. Nenhuma URL
 * de terceiro é inventada aqui — se nenhum dos dois existir, falha alto e
 * visível em vez de mandar e-mail com link quebrado silenciosamente.
 */
export async function getRequestOrigin(): Promise<string> {
  const headerList = await headers();

  const origin = headerList.get("origin");
  if (origin) return origin;

  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const proto = headerList.get("x-forwarded-proto") ?? "https";
  if (host) return `${proto}://${host}`;

  throw new Error("request_origin_unavailable");
}
