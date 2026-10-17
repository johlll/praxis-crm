import { NextResponse } from "next/server";
import { z } from "zod";

import { adminGetChannelForStop, createSupabaseInboundStore } from "@/server/calendar/admin/inbound-store";
import { loadFreshTokens } from "@/server/calendar/connection-context";
import { isAuthorizedCalendarCron } from "@/server/calendar/cron-auth";
import { getCalendarProvider } from "@/server/calendar/provider";
import { stopChannelForOperator, type ChannelStopResult } from "@/server/calendar/sync/channel-stop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Encerramento controlado de UM canal de notificações (B2, validação; §9.5).
 *
 * Só existe em Preview (`VERCEL_ENV=preview`): em Production, ou sem
 * ambiente, 404 antes de qualquer consulta. Autenticação pelo `CRON_SECRET`
 * no cabeçalho. O corpo traz só `{ "channelId": "<uuid>" }`; conexão, dono,
 * workspace e recurso vêm do registro gravado. Não desconecta, não renova
 * canal e não toca em atividade, vínculo ou evento.
 *
 * Resposta: só `remote` e `local` (códigos), nunca token, endereço, cabeçalho
 * ou corpo de erro do Google. 200 = encerrado (ou já estava); 202 = local
 * encerrado, mas o Google não confirmou; 409 = nada feito (conexão sem token
 * agora); 500 = falha ao gravar o encerramento.
 */

const bodySchema = z.object({ channelId: z.string().uuid() }).strict();

const REFUSED = new Set(["channel_not_found", "calendar_environment_mismatch", "channel_inconsistent"]);

function statusOf(result: ChannelStopResult): number {
  if (result.local === "failed") return 500;
  if (result.local === "unchanged") return 409;
  if (result.remote === "stopped" || result.remote === "provider_404" || result.remote === "not_attempted") return 200;
  return 202;
}

export async function POST(request: Request) {
  if (process.env.VERCEL_ENV !== "preview") return new Response(null, { status: 404 });
  if (!isAuthorizedCalendarCron(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let channelId: string;
  try {
    channelId = bodySchema.parse(await request.json()).channelId;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const provider = await getCalendarProvider();
  if (!provider) return new Response(null, { status: 404 });

  const store = createSupabaseInboundStore();
  try {
    const result = await stopChannelForOperator(
      {
        lookup: adminGetChannelForStop,
        accessToken: async (channel) =>
          (
            await loadFreshTokens({
              provider,
              connectionId: channel.connectionId,
              workspaceId: channel.workspaceId,
              actorUserId: channel.userId,
            })
          ).accessToken,
        stopRemote: (accessToken, channel) => provider.stopChannel(accessToken, channel),
        stopLocal: (userId, id, reason) => store.stopChannel(userId, id, reason),
      },
      channelId,
    );
    return NextResponse.json(result, { status: statusOf(result) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (REFUSED.has(message)) return NextResponse.json({ error: "channel_not_found" }, { status: 404 });
    // Só o código: a mensagem original não sai daqui.
    console.error(JSON.stringify({ event: "calendar_channel_stop_failed", code: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "lookup_failed" }, { status: 503 });
  }
}
