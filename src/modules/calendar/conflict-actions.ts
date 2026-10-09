"use server";

import { revalidatePath } from "next/cache";

import { toUserMessage } from "@/lib/errors";
import { uuidSchema } from "@/lib/uuid";
import { PROVIDER_NOT_CONFIGURED, syncLinkedActivity } from "@/modules/calendar/appointment-service";
import type { CalendarNotice } from "@/modules/calendar/types";
import { requirePermissionSafe } from "@/server/authz/safe";
import { adminRestoreCalendarConflict } from "@/server/calendar/admin/conflicts";
import { getCalendarProvider } from "@/server/calendar/provider";

export type RestoreConflictState = { ok: boolean; error?: string; notice?: CalendarNotice | null };

const REFUSED: Record<string, string> = {
  already_restored: "Este valor já foi restaurado.",
  not_restorable: "Este conflito não pode ser restaurado (só título e horário em que o Google prevaleceu).",
  outdated:
    "A atividade mudou depois do conflito: restaurar sobrescreveria um valor mais novo. Nada foi alterado; edite a atividade se ainda quiser o valor antigo.",
  link_inactive: "O compromisso não está mais vinculado ao Google Agenda. Nada foi alterado.",
  not_owner: "Este compromisso está na agenda de outra pessoa: só ela pode restaurar o valor. Nada foi alterado.",
};

/**
 * "Restaurar valor do CRM" (§6.4, critério 7): o valor do CRM que perdeu
 * para o Google num conflito volta para a atividade e, em seguida, é levado
 * ao Google pela saída normal (`syncLinkedActivity`): se o Google mudou de
 * novo nesse meio-tempo, vale a regra de conflito outra vez, com registro.
 * O conflito fica marcado como restaurado (e aparece na timeline do lead).
 */
export async function restoreCalendarConflictAction(conflictId: string): Promise<RestoreConflictState> {
  const auth = await requirePermissionSafe("calendar.connect_own");
  if ("error" in auth) return { ok: false, error: auth.error };
  if (!uuidSchema.safeParse(conflictId).success) return { ok: false, error: toUserMessage({ message: "conflict_not_found" }) };

  const provider = await getCalendarProvider();
  if (!provider) return { ok: false, error: PROVIDER_NOT_CONFIGURED };

  let result;
  try {
    result = await adminRestoreCalendarConflict({ conflictId, actorUserId: auth.ctx.userId });
  } catch (error) {
    return { ok: false, error: toUserMessage({ message: error instanceof Error ? error.message : "" }) };
  }
  if (result.status !== "restored") return { ok: false, error: REFUSED[result.status] ?? toUserMessage({ message: result.status }) };

  const notice = await syncLinkedActivity(result.activityId);
  revalidatePath("/leads/[id]", "page");
  revalidatePath("/atividades");
  revalidatePath("/agenda");
  return {
    ok: true,
    notice: notice
      ? { ...notice, message: notice.message.replace(/^Salvo no CRM\. /, "Valor do CRM restaurado. ") }
      : { level: "success", message: "Valor do CRM restaurado. O Google Agenda já estava igual." },
  };
}
