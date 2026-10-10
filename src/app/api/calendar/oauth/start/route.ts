import { NextResponse } from "next/server";

import { requirePermissionSafe } from "@/server/authz/safe";
import { OAUTH_BROWSER_COOKIE, OAUTH_COOKIE_MAX_AGE_S, OAUTH_COOKIE_PATH, googleOAuthDeps } from "@/server/calendar/google/oauth-deps";
import { startGoogleOAuth } from "@/server/calendar/google/oauth-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Conectar com Google" (B2, etapa 4): inicia a autorização da PRÓPRIA conta
 * (`calendar.connect_own`) e redireciona ao Google. GET por um link comum
 * (um formulário seria barrado pelo `form-action 'self'` do CSP ao seguir o
 * redirecionamento para o Google); chamada vinda de outro site é recusada.
 *
 * O fluxo inteiro acontece na ORIGEM do endereço de retorno configurado (o
 * cookie do navegador e a sessão precisam chegar ao retorno): de outra
 * origem, volta à tela de Integrações daquela origem com o aviso.
 *
 * Nada da requisição define para onde se volta: o retorno é o configurado e,
 * depois dele, sempre a tela de Integrações.
 */

const INTEGRATIONS = "/configuracoes/integracoes";

function back(request: Request, outcome: string, origin?: string): NextResponse {
  const url = new URL(INTEGRATIONS, origin ?? request.url);
  url.searchParams.set("agenda", outcome);
  return NextResponse.redirect(url, 303);
}

export async function GET(request: Request) {
  const deps = googleOAuthDeps();
  if (!deps) return back(request, "not_configured");

  if (request.headers.get("sec-fetch-site") === "cross-site") return back(request, "invalid_state");
  if (new URL(request.url).origin !== deps.config.origin) return back(request, "wrong_origin", deps.config.origin);

  const auth = await requirePermissionSafe("calendar.connect_own");
  if ("error" in auth) return back(request, "forbidden");

  let started;
  try {
    started = await startGoogleOAuth(deps, { userId: auth.ctx.userId, workspaceId: auth.ctx.workspaceId });
  } catch (error) {
    // Só o código: nada de state, verificador ou token.
    console.error(JSON.stringify({ event: "calendar_oauth_start_failed", code: error instanceof Error ? error.name : "unknown" }));
    return back(request, "failed");
  }

  const response = NextResponse.redirect(started.authorizationUrl, 303);
  response.cookies.set(OAUTH_BROWSER_COOKIE, started.browserNonce, {
    httpOnly: true,
    secure: deps.config.origin.startsWith("https://"),
    sameSite: "lax",
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_COOKIE_MAX_AGE_S,
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
