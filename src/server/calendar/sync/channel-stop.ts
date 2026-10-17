import { ProviderHttpError } from "@/server/calendar/events-api";

/**
 * Encerramento controlado de UM canal de notificações pelo operador (B2,
 * validação no Preview; §9.5). O chamador informa só o id do canal; conexão,
 * dono, workspace e recurso vêm do registro gravado. Para o canal no Google
 * pelo ADAPTADOR (não pelo helper da manutenção, que absorve a falha) e só
 * depois o encerra no banco — sem tocar em atividade, vínculo, evento ou
 * conexão.
 *
 * Os desfechos remoto e local são separados e nunca promovidos: resposta
 * perdida é "indeterminado" (não prova que o canal continua no Google), e
 * falha ao gravar o encerramento não vira sucesso.
 */

/** Motivo gravado no encerramento local. */
export const OPERATOR_STOP_REASON = "operator_stop";

export type ChannelForStop = {
  channelId: string;
  status: "creating" | "active" | "retiring" | "stopped" | "polling_only";
  resourceId: string | null;
  calendarId: string;
  connectionId: string;
  connectionStatus: string;
  userId: string;
  workspaceId: string;
};

export type RemoteStop =
  /** O Google confirmou a parada (2xx). */
  | "stopped"
  /** O Google respondeu 404: o canal já não existia lá. */
  | "provider_404"
  /** Outra resposta HTTP do Google: não parou. */
  | `http_${number}`
  /** Sem resposta (timeout, rede): não se sabe. */
  | "indeterminate"
  /** Não houve chamada ao Google (motivo em `reason`). */
  | "not_attempted";

export type LocalStop = "stopped" | "already_stopped" | "failed" | "unchanged";

export type ChannelStopResult = {
  remote: RemoteStop;
  local: LocalStop;
  /** Por que não houve chamada ao Google. */
  reason?: "already_stopped" | "no_resource" | "polling_only" | "connection_unavailable";
};

export type ChannelStopDeps = {
  lookup: (channelId: string) => Promise<ChannelForStop>;
  /** Token de acesso da PRÓPRIA conexão do canal, pela renovação normal. */
  accessToken: (channel: ChannelForStop) => Promise<string>;
  stopRemote: (accessToken: string, channel: { id: string; resourceId: string }) => Promise<void>;
  stopLocal: (userId: string, channelId: string, reason: string) => Promise<void>;
};

async function stopLocal(deps: ChannelStopDeps, channel: ChannelForStop): Promise<LocalStop> {
  try {
    await deps.stopLocal(channel.userId, channel.channelId, OPERATOR_STOP_REASON);
    return "stopped";
  } catch {
    return "failed";
  }
}

export async function stopChannelForOperator(deps: ChannelStopDeps, channelId: string): Promise<ChannelStopResult> {
  const channel = await deps.lookup(channelId);

  // Repetição: já encerrado aqui. Nenhuma chamada nova ao Google e nenhuma
  // confirmação inventada.
  if (channel.status === "stopped") return { remote: "not_attempted", local: "already_stopped", reason: "already_stopped" };
  // `polling_only` já foi parado no Google ao ser marcado; sem recurso, não
  // há o que parar lá. Em ambos, só o registro local.
  if (channel.status === "polling_only" || !channel.resourceId) {
    return { remote: "not_attempted", local: await stopLocal(deps, channel), reason: channel.resourceId ? "polling_only" : "no_resource" };
  }

  let accessToken: string;
  try {
    accessToken = await deps.accessToken(channel);
  } catch {
    // Sem token (a reautorizar, desconectada, falha temporária): nada é
    // encerrado aqui, para que a parada no Google possa ser tentada de novo.
    return { remote: "not_attempted", local: "unchanged", reason: "connection_unavailable" };
  }

  let remote: RemoteStop;
  try {
    await deps.stopRemote(accessToken, { id: channel.channelId, resourceId: channel.resourceId });
    remote = "stopped";
  } catch (error) {
    if (error instanceof ProviderHttpError) remote = error.status === 404 ? "provider_404" : `http_${error.status}`;
    else remote = "indeterminate";
  }

  return { remote, local: await stopLocal(deps, channel) };
}
