import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B2 — confirmação visual de "Restaurar valor do CRM" (achado da validação
 * no Preview, §6.13). A ação revalida a página: o servidor manda a timeline
 * com o conflito já restaurado (sem botão). A confirmação precisa continuar
 * visível depois disso, e "salvo só no CRM" nunca pode parecer sucesso
 * completo. Ação substituída; dados fictícios.
 */

const m = vi.hoisted(() => ({ restoreAction: vi.fn(), loadMore: vi.fn() }));

vi.mock("@/modules/calendar/conflict-actions", () => ({ restoreCalendarConflictAction: m.restoreAction }));
vi.mock("@/modules/timeline/actions", () => ({ loadMoreLeadTimelineAction: m.loadMore }));

import { LeadTimeline } from "@/components/leads/lead-timeline";
import type { LeadTimelineEvent } from "@/modules/timeline/queries";

const LEAD_ID = "l0000000-0000-4000-8000-000000000001";
const CONFLICT_ID = "c0000000-0000-4000-8000-000000000001";
const MEMBERS = [{ userId: "u1", fullName: "Dra. Fictícia", email: "f@exemplo.test", role: "owner", status: "active" } as never];

function conflict(restored: boolean): LeadTimelineEvent {
  return {
    eventType: "agenda",
    occurredAt: "2026-11-01T12:00:00.000Z",
    id: CONFLICT_ID,
    payload: {
      kind: "conflict",
      conflict_id: CONFLICT_ID,
      activity_title: "Reunião fictícia",
      field: "title",
      resolution: "google_prevails",
      crm_value: "Título do CRM",
      google_value: "Título do Google",
      restored_at: restored ? "2026-11-02T10:00:00.000Z" : null,
      restorable: !restored,
    },
  };
}

const restoredEntry: LeadTimelineEvent = {
  eventType: "agenda",
  occurredAt: "2026-11-02T10:00:00.000Z",
  id: "d0000000-0000-4000-8000-000000000001",
  payload: { kind: "restored", field: "title", activity_title: "Reunião fictícia", crm_value: "Título do CRM", restored_by: "u1" },
};

const timeline = (items: LeadTimelineEvent[]) => (
  <LeadTimeline leadId={LEAD_ID} initialItems={items} initialHasMore={false} members={MEMBERS} canRestoreCalendar />
);

/** O que a revalidação da página faz: nova lista do servidor, conflito já restaurado. */
async function serverRefresh(rerender: (ui: React.ReactElement) => void) {
  await act(async () => rerender(timeline([restoredEntry, conflict(true)])));
}

beforeEach(() => {
  m.restoreAction.mockReset();
  m.loadMore.mockReset();
});

describe("confirmação da restauração sobrevive à atualização da tela", () => {
  it("concluída e sincronizada: confirmação de sucesso continua visível após a revalidação", async () => {
    m.restoreAction.mockResolvedValueOnce({ ok: true, notice: { level: "success", message: "Valor do CRM restaurado. Google Agenda atualizado." } });
    const { rerender } = render(timeline([conflict(false)]));
    fireEvent.click(screen.getByRole("button", { name: "Restaurar valor do CRM" }));
    await waitFor(() => expect(m.restoreAction).toHaveBeenCalledWith(CONFLICT_ID));

    await serverRefresh(rerender);

    const notice = await screen.findByText("Valor do CRM restaurado. Google Agenda atualizado.");
    expect(notice.closest("[data-restore-outcome]")?.getAttribute("data-restore-outcome")).toBe("synced");
    expect(screen.queryByRole("button", { name: "Restaurar valor do CRM" })).toBeNull();
  });

  it("salvo no CRM com envio pendente/incerto: aviso (não sucesso) que também sobrevive", async () => {
    const message = "Valor do CRM restaurado no CRM, mas a restauração não foi concluída no Google Agenda. O Google Agenda não respondeu (provider_503). A alteração ficou pendente: tente sincronizar de novo.";
    m.restoreAction.mockResolvedValueOnce({ ok: true, notice: { level: "warning", message } });
    const { rerender } = render(timeline([conflict(false)]));
    fireEvent.click(screen.getByRole("button", { name: "Restaurar valor do CRM" }));
    await waitFor(() => expect(m.restoreAction).toHaveBeenCalled());

    await serverRefresh(rerender);

    const notice = await screen.findByText(message);
    expect(notice.closest("[data-restore-outcome]")?.getAttribute("data-restore-outcome")).toBe("crm_only");
    expect(notice.closest("[data-slot=alert]")?.className).toMatch(/warning/);
    expect(notice.closest("[data-slot=alert]")?.className).not.toMatch(/success/);
  });

  it("enquanto a restauração está em andamento, o botão fica desabilitado e um segundo clique não repete", async () => {
    let resolve!: (v: unknown) => void;
    m.restoreAction.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    render(timeline([conflict(false)]));
    const button = screen.getByRole("button", { name: "Restaurar valor do CRM" });
    fireEvent.click(button);
    await waitFor(() => expect((screen.getByRole("button", { name: /Restaurando/ }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /Restaurando/ }));
    expect(m.restoreAction).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ ok: true, notice: { level: "success", message: "Valor do CRM restaurado. Google Agenda atualizado." } }));
  });

  it("recusa do servidor: erro visível, botão volta, nada de sucesso", async () => {
    m.restoreAction.mockResolvedValueOnce({ ok: false, error: "A atividade mudou depois do conflito." });
    render(timeline([conflict(false)]));
    fireEvent.click(screen.getByRole("button", { name: "Restaurar valor do CRM" }));
    const error = await screen.findByText("A atividade mudou depois do conflito.");
    expect(error.closest("[data-slot=alert]")?.className).toMatch(/danger/);
    expect(screen.getByRole("button", { name: "Restaurar valor do CRM" })).toBeTruthy();
  });
});
