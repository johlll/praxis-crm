import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError } from "@/server/data/load-error";
import { getCalendarProvider, type ProviderCalendar } from "@/server/calendar/provider";
import { loadFreshTokens } from "@/server/calendar/connection-context";

export type CalendarConnectionListItem = {
  id: string;
  userId: string;
  isMine: boolean;
  googleAccountEmail: string;
  calendarId: string | null;
  calendarSummary: string | null;
  status: "active" | "needs_reauth" | "disconnected";
  createdAt: string;
};

/** Conexões do ambiente atual: as próprias e, para owner/admin, as do
 * workspace. Nunca traz token (a RPC não os projeta). */
export async function listCalendarConnections(workspaceId: string): Promise<CalendarConnectionListItem[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_calendar_connections", { p_workspace_id: workspaceId });
  if (error) throw new DataLoadError("as conexões de agenda", error);
  return (data as unknown as CalendarConnectionListItem[] | null) ?? [];
}

/** Agendas que o usuário pode escolher, lidas no provedor com o token da
 * PRÓPRIA conexão. Vazio quando o provedor não está configurado. */
export async function listChoosableCalendars(params: {
  connectionId: string;
  workspaceId: string;
  actorUserId: string;
}): Promise<ProviderCalendar[]> {
  const provider = await getCalendarProvider();
  if (!provider) return [];
  const tokens = await loadFreshTokens({ provider, ...params });
  return provider.listCalendars(tokens.accessToken);
}
