import { createServerSupabaseClient } from "@/server/supabase/server";
import { getCalendarProvider } from "@/server/calendar/provider";
import type { ActivityCalendarInfo } from "@/modules/calendar/types";

type LinkRow = ActivityCalendarInfo & { activityId: string };

/**
 * Anexa a cada atividade o estado do vínculo com o Google Agenda, quando há.
 *
 * Com a integração desligada (sem provedor configurado) NÃO chama nenhuma
 * função de B2 no banco — a tela de atividades continua igual enquanto as
 * migrations de B2 não estiverem aplicadas. Se a leitura falhar com a
 * integração ligada, a lista continua carregando, sem o selo: o selo é
 * decoração, e as ações de calendário conferem o vínculo de verdade no
 * servidor antes de qualquer efeito.
 */
export async function attachCalendarInfo<T extends { id: string }>(
  items: T[],
): Promise<Array<T & { calendar: ActivityCalendarInfo | null }>> {
  const none = items.map((item) => ({ ...item, calendar: null }));
  if (items.length === 0) return none;

  const provider = await getCalendarProvider();
  if (!provider) return none;

  try {
    // TODAS as atividades: um vínculo existente nunca é escondido porque a
    // atividade deixou de ser reunião com horário.
    const byActivity = await readLinks(items.map((item) => item.id));
    return items.map((item) => ({ ...item, calendar: byActivity.get(item.id) ?? null }));
  } catch (error) {
    console.error(
      JSON.stringify({ event: "calendar_links_unavailable", message: error instanceof Error ? error.message : "erro" }),
    );
    return none;
  }
}

/**
 * O vínculo de UMA atividade, para conferir ANTES de uma escrita. Ao
 * contrário da lista, uma falha de leitura LANÇA: quem chama recusa a
 * alteração em vez de seguir sem saber. `null` = sem vínculo (ou integração
 * desligada).
 */
export async function readActivityCalendarInfo(activityId: string): Promise<ActivityCalendarInfo | null> {
  const provider = await getCalendarProvider();
  if (!provider) return null;
  return (await readLinks([activityId])).get(activityId) ?? null;
}

async function readLinks(ids: string[]): Promise<Map<string, ActivityCalendarInfo>> {
  const supabase = await createServerSupabaseClient();
  const rows: LinkRow[] = [];
  // A função aceita até 200 por chamada.
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.rpc("list_activity_calendar_links", { p_activity_ids: ids.slice(i, i + 200) });
    if (error) throw new Error(error.message);
    rows.push(...((data as unknown as LinkRow[] | null) ?? []));
  }
  return new Map(
    rows.map(({ activityId, ...info }) => [
      activityId,
      { ...info, syncState: info.syncState ?? "in_sync", syncOperation: info.syncOperation ?? null },
    ]),
  );
}
