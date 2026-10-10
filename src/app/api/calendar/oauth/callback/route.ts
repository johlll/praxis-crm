import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { recoverOwnCalendarLinks } from "@/modules/calendar/automation";
import { requirePermissionSafe } from "@/server/authz/safe";
import { OAUTH_BROWSER_COOKIE, OAUTH_COOKIE_PATH, googleOAuthDeps } from "@/server/calendar/google/oauth-deps";
import { completeGoogleOAuth } from "@/server/calendar/google/oauth-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Retorno da autorização do Google (B2, etapa 4). Confere state (uso único,
 * prazo, ambiente, sessão e navegador), troca o código com PKCE, confere a
 * identidade (OpenID Connect) e os escopos CONCEDIDOS e grava a conexão.
 *
 * Sempre volta à tela de Integrações com um desfecho FIXO (`?agenda=`): nada
 * da URL do Google é ecoado, e o código e os tokens nunca vão para log — só o
 * desfecho e um código interno.
 */

const INTEGRATIONS = "/configuracoes/integracoes";

export async function GET(request: Request) {
  const deps = googleOAuthDeps();
  const finish = (outcome: string) => {
    const url = new URL(INTEGRATIONS, deps?.config.origin ?? request.url);
    url.searchParams.set("agenda", outcome);
    const response = NextResponse.redirect(url, 303);
    // O cookie do navegador serve a UMA tentativa.
    response.cookies.set(OAUTH_BROWSER_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0 });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  };
  if (!deps) return finish("not_configured");

  const auth = await requirePermissionSafe("calendar.connect_own");
  if ("error" in auth) return finish("session_mismatch");
  const session = { userId: auth.ctx.userId, workspaceId: auth.ctx.workspaceId };

  const params = new URL(request.url).searchParams;
  let result;
  try {
    result = await completeGoogleOAuth(deps, session, {
      state: params.get("state"),
      code: params.get("code"),
      error: params.get("error"),
      browserNonce: (await cookies()).get(OAUTH_BROWSER_COOKIE)?.value ?? null,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "calendar_oauth_callback_failed", code: error instanceof Error ? error.name : "unknown" }));
    return finish("failed");
  }

  if (result.outcome !== "connected") {
    console.warn(JSON.stringify({ event: "calendar_oauth_refused", outcome: result.outcome, code: result.code ?? null }));
    return finish(result.outcome);
  }

  // Reconexão (§6.5): com a agenda já escolhida, reencontra os compromissos.
  // Nunca lança; o resultado detalhado sai pelo botão "Reencontrar compromissos".
  await recoverOwnCalendarLinks(auth.ctx);
  return finish("connected");
}
