import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B2, etapa 3b — restauração do valor do CRM num conflito e o conflito na
 * timeline do lead (§6.4, critério 7). A tela, com a ação substituída; a
 * ação, com o banco e a saída substituídos. A regra do banco é coberta pelo
 * pgTAP (`25_b2_scheduler_alerts_restore`). Dados fictícios.
 */

const m = vi.hoisted(() => ({
  restoreAction: vi.fn(),
  loadMore: vi.fn(),
}));

vi.mock("@/modules/calendar/conflict-actions", () => ({ restoreCalendarConflictAction: m.restoreAction }));
vi.mock("@/modules/timeline/actions", () => ({ loadMoreLeadTimelineAction: m.loadMore }));

import { LeadTimeline } from "@/components/leads/lead-timeline";
import type { LeadTimelineEvent } from "@/modules/timeline/queries";

const CONFLICT_ID = "c0000000-0000-4000-8000-000000000001";

function conflict(payload: Record<string, unknown> = {}): LeadTimelineEvent {
  return {
    eventType: "agenda",
    occurredAt: "2026-11-01T12:00:00.000Z",
    id: CONFLICT_ID,
    payload: {
      kind: "conflict",
      conflict_id: CONFLICT_ID,
      activity_title: "Reunião com cliente fictício",
      field: "title",
      resolution: "google_prevails",
      crm_value: "Título do CRM",
      google_value: "Título do Google",
      restored_at: null,
      restorable: true,
      ...payload,
    },
  };
}

const renderTimeline = (items: LeadTimelineEvent[], canRestoreCalendar = true) =>
  render(
    <LeadTimeline
      leadId="l0000000-0000-4000-8000-000000000001"
      initialItems={items}
      initialHasMore={false}
      members={[{ userId: "u1", fullName: "Dra. Fictícia", email: "f@exemplo.test", role: "owner", status: "active" } as never]}
      canRestoreCalendar={canRestoreCalendar}
    />,
  );

beforeEach(() => {
  m.restoreAction.mockReset();
  m.loadMore.mockReset();
});

describe("timeline: conflito de agenda", () => {
  it("mostra o que prevaleceu e o valor do CRM guardado, com o botão de restaurar", () => {
    renderTimeline([conflict()]);
    expect(screen.getByText("Conflito com o Google Agenda (título)")).toBeTruthy();
    expect(screen.getByText(/o Google prevaleceu: “Título do Google”\. Valor do CRM guardado: “Título do CRM”\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restaurar valor do CRM" })).toBeTruthy();
  });

  it("horário: mostra o início dos dois lados", () => {
    renderTimeline([
      conflict({
        field: "schedule",
        crm_value: { start: "2026-11-12T13:00:00.000Z", end: "2026-11-12T14:00:00.000Z" },
        google_value: { start: "2026-11-13T09:00:00.000Z", end: "2026-11-13T10:00:00.000Z" },
      }),
    ]);
    expect(screen.getByText("Conflito com o Google Agenda (horário)")).toBeTruthy();
    expect(screen.getByText(/13\/11\/2026.*Valor do CRM guardado: 12\/11\/2026/)).toBeTruthy();
  });

  it("sem permissão, já restaurado, cancelamento ou não restaurável: sem botão", () => {
    const { unmount } = renderTimeline([conflict()], false);
    expect(screen.queryByRole("button", { name: "Restaurar valor do CRM" })).toBeNull();
    unmount();

    renderTimeline([
      conflict({ restored_at: "2026-11-02T10:00:00.000Z", restorable: false }),
      { ...conflict({ field: "cancellation", restorable: false }), id: "c0000000-0000-4000-8000-000000000002" },
    ]);
    expect(screen.queryByRole("button", { name: "Restaurar valor do CRM" })).toBeNull();
    expect(screen.getByText(/Já restaurado\./)).toBeTruthy();
    expect(screen.getByText(/o evento foi cancelado no Google enquanto o CRM o alterava/)).toBeTruthy();
  });

  it("restauração registrada aparece como fato próprio, com quem restaurou", () => {
    renderTimeline([
      {
        eventType: "agenda",
        occurredAt: "2026-11-02T10:00:00.000Z",
        id: "d0000000-0000-4000-8000-000000000001",
        payload: { kind: "restored", field: "title", activity_title: "Reunião", crm_value: "Título do CRM", restored_by: "u1" },
      },
    ]);
    expect(screen.getByText("Valor do CRM restaurado (título)")).toBeTruthy();
    expect(screen.getByText(/restaurado por Dra\. Fictícia: “Título do CRM”/)).toBeTruthy();
  });

  it("restaurar: chama a ação com o id do conflito e mostra o resultado; recusa vira mensagem", async () => {
    m.restoreAction.mockResolvedValueOnce({ ok: true, notice: { level: "success", message: "Valor do CRM restaurado. Google Agenda atualizado." } });
    renderTimeline([conflict()]);
    fireEvent.click(screen.getByRole("button", { name: "Restaurar valor do CRM" }));
    await waitFor(() => expect(screen.getByText("Valor do CRM restaurado. Google Agenda atualizado.")).toBeTruthy());
    expect(m.restoreAction).toHaveBeenCalledWith(CONFLICT_ID);
    expect(screen.queryByRole("button", { name: "Restaurar valor do CRM" })).toBeNull();
  });

  it("recusa do servidor (ex.: a atividade mudou depois): mensagem e o botão continua", async () => {
    m.restoreAction.mockResolvedValueOnce({ ok: false, error: "A atividade mudou depois do conflito." });
    renderTimeline([conflict()]);
    fireEvent.click(screen.getByRole("button", { name: "Restaurar valor do CRM" }));
    await waitFor(() => expect(screen.getByText("A atividade mudou depois do conflito.")).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: "Restaurar valor do CRM" })).toBeTruthy());
  });

  it("filtro Agenda pede ao servidor só os eventos de agenda", async () => {
    m.loadMore.mockResolvedValueOnce({ ok: true, items: [conflict()], hasMore: false });
    renderTimeline([]);
    fireEvent.click(screen.getByRole("button", { name: "Agenda" }));
    await waitFor(() => expect(m.loadMore).toHaveBeenCalledWith("l0000000-0000-4000-8000-000000000001", ["agenda"]));
  });
});
