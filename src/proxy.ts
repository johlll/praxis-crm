import { randomBytes } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "@/server/types/database";
import { getEnv } from "@/server/env";

/**
 * Renova a sessão a cada request (padrão oficial atual do @supabase/ssr
 * para o App Router), protege as rotas internas e aplica a CSP com nonce
 * por request (adiada na A1, finalizada aqui — §8 do prompt da A2).
 *
 * Sem sessão válida, tudo fora de `/entrar`, `/auth` e `/convite`
 * redireciona para `/entrar`. A verificação de workspace ativo (membership
 * real, não só "está logado") acontece depois, no layout de `(app)` — o
 * proxy só garante que existe um usuário autenticado de verdade.
 *
 * `proxy.ts` é o nome atual deste arquivo no Next 16 (renomeado de
 * `middleware.ts`, que o próprio `next build` já acusa como descontinuado)
 * — mesmo mecanismo, mesma exportação `config.matcher`, só o nome mudou.
 * O Next 16 já roda `proxy.ts` sempre em runtime Node (não mais Edge por
 * padrão), por isso dá para usar `node:crypto` direto aqui.
 *
 * `supabase.auth.getUser()` valida o JWT contra o servidor do Supabase, ao
 * contrário de `getSession()` (que só lê o cookie, sem confirmar que ainda
 * é válido) — é por isso que é este o método usado aqui, não o outro.
 */
const PUBLIC_PATHS = ["/entrar", "/auth", "/convite"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * Só as origens que a aplicação realmente usa: a própria origem e o
 * projeto Supabase (REST/RPC/Auth chamados do navegador pelo
 * @supabase/ssr). Nenhuma outra origem de terceiro entra aqui — nem CDN,
 * nem analytics, nada que a A2 não use de fato.
 */
function buildCsp(nonce: string, supabaseUrl: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // Next/font injeta <style> inline para as fontes locais geradas no
    // build — não há nonce automático para style-src no App Router hoje,
    // então 'unsafe-inline' aqui é a exceção pragmática desta CSP (o custo
    // de um style injetado é bem menor que o de script injetado).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${supabaseUrl}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

export async function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const env = getEnv();
  const csp = buildCsp(nonce, env.NEXT_PUBLIC_SUPABASE_URL);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request: { headers: requestHeaders } });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublicPath(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/entrar";
    url.searchParams.set("next", request.nextUrl.pathname);
    const redirectResponse = NextResponse.redirect(url);
    redirectResponse.headers.set("Content-Security-Policy", csp);
    return redirectResponse;
  }

  if (user && request.nextUrl.pathname === "/entrar") {
    const url = request.nextUrl.clone();
    url.pathname = "/visao-geral";
    url.searchParams.delete("next");
    const redirectResponse = NextResponse.redirect(url);
    redirectResponse.headers.set("Content-Security-Policy", csp);
    return redirectResponse;
  }

  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Roda em tudo, exceto assets estáticos e imagens do Next — esses
     * nunca precisam de sessão e recarregar cookie neles seria desperdício.
     */
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|webp)$).*)",
  ],
};
