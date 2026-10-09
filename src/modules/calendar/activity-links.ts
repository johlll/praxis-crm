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
export async function attachCalendarInfo<T extends { id: string; type: string; hasTime: boolean }>(
  items: T[],
): Promise<Array<T & { calendar: ActivityCalendarInfo | null }>> {
  const none = items.map((item) => ({ ...item, calendar: null }));
  if (items.length === 0) return none;

  const provider = await getCalendarProvider();
  if (!provider) return none;

  const candidates = items.filter((item) => item.type === "meeting" && item.hasTime).map((item) => item.id);
  if (candidates.length === 0) return none;

  try {
    const supabase = await createServerSupabaseClient();
    const rows: LinkRow[] = [];
    // A função aceita até 200 por chamada.
    for (let i = 0; i < candidates.length; i += 200) {
      const { data, error } = await supabase.rpc("list_activity_calendar_links", {
        p_activity_ids: candidates.slice(i, i + 200),
      });
      if (error) throw new Error(error.message);
      rows.push(...((data as unknown as LinkRow[] | null) ?? []));
    }
    const byActivity = new Map(rows.map((row) => [row.activityId, row]));
    return items.map((item) => {
      const row = byActivity.get(item.id);
      if (!row) return { ...item, calendar: null };
      const { activityId: _activityId, ...info } = row;
      void _activityId;
      return { ...item, calendar: info };
    });
  } catch (error) {
    console.error(
      JSON.stringify({ event: "calendar_links_unavailable", message: error instanceof Error ? error.message : "erro" }),
    );
    return none;
  }
}
