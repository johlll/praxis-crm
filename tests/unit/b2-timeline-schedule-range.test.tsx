import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * B2 — conflito de HORÁRIO na timeline mostra o intervalo completo (início,
 * término e duração), não só o início. Achado da validação real no Preview
 * (16/10/2026): Google 16h–18h × CRM 17h–18h30 apareciam como "16:00" e
 * "17:00", escondendo que restaurar também muda a duração. Os valores abaixo
 * têm o formato real de `get_lead_timeline` (instantes UTC). Só
 * apresentação; dados fictícios.
 */

vi.mock("@/modules/calendar/conflict-actions", () => ({ restoreCalendarConflictAction: vi.fn() }));
vi.mock("@/modules/timeline/actions", () => ({ loadMoreLeadTimelineAction: vi.fn() }));

import { LeadTimeline } from "@/components/leads/lead-timeline";
import type { LeadTimelineEvent } from "@/modules/timeline/queries";

// 27/10/2026 em São Paulo (UTC−3): 16h–18h e 17h–18h30.
const GOOGLE = { start: "2026-10-27T19:00:00.000Z", end: "2026-10-27T21:00:00.000Z" };
const CRM = { start: "2026-10-27T20:00:00.000Z", end: "2026-10-27T21:30:00.000Z" };

const conflict = (crm: unknown, google: unknown): LeadTimelineEvent => ({
  eventType: "agenda",
  occurredAt: "2026-10-16T20:04:33.000Z",
  id: "c0000000-0000-4000-8000-000000000001",
  payload: {
    kind: "conflict",
    conflict_id: "c0000000-0000-4000-8000-000000000001",
    activity_title: "QA B2 — Título CRM",
    field: "schedule",
    resolution: "google_prevails",
    crm_value: crm,
    google_value: google,
    restored_at: null,
    restorable: false,
  },
});

const restored = (crm: unknown): LeadTimelineEvent => ({
  eventType: "agenda",
  occurredAt: "2026-10-16T20:05:30.000Z",
  id: "d0000000-0000-4000-8000-000000000001",
  payload: { kind: "restored", field: "schedule", activity_title: "QA B2 — Título CRM", crm_value: crm, restored_by: "u1" },
});

const renderTimeline = (items: LeadTimelineEvent[]) =>
  render(
    <LeadTimeline
      leadId="l0000000-0000-4000-8000-000000000001"
      initialItems={items}
      initialHasMore={false}
      members={[{ userId: "u1", fullName: "Dra. Fictícia", email: "f@exemplo.test", role: "owner", status: "active" } as never]}
    />,
  );

describe("timeline: conflito de horário com o intervalo completo", () => {
  it("conflito no mesmo dia: os dois intervalos com término e duração", () => {
    renderTimeline([conflict(CRM, GOOGLE)]);
    expect(
      screen.getByText(
        "QA B2 — Título CRM — o Google prevaleceu: 27/10/2026, 16:00–18:00 (120 min). Valor do CRM guardado: 27/10/2026, 17:00–18:30 (90 min).",
      ),
    ).toBeTruthy();
  });

  it("restauração: mostra o intervalo completo restaurado", () => {
    renderTimeline([restored(CRM)]);
    expect(screen.getByText("QA B2 — Título CRM — restaurado por Dra. Fictícia: 27/10/2026, 17:00–18:30 (90 min)")).toBeTruthy();
  });

  it("atravessando a meia-noite: mostra também a data do término", () => {
    // 27/10 23:30 → 28/10 00:30 em São Paulo.
    renderTimeline([restored({ start: "2026-10-28T02:30:00.000Z", end: "2026-10-28T03:30:00.000Z" })]);
    expect(screen.getByText(/restaurado por Dra\. Fictícia: 27\/10\/2026, 23:30 – 28\/10\/2026, 00:30 \(60 min\)$/)).toBeTruthy();
  });

  it("valores malformados ou incompletos: texto seguro, a timeline continua de pé", () => {
    renderTimeline([
      conflict({ start: "nada", end: CRM.end }, "texto"),
      { ...restored({ start: CRM.start }), id: "d0000000-0000-4000-8000-000000000002" },
      { ...restored({ start: CRM.end, end: CRM.start }), id: "d0000000-0000-4000-8000-000000000003" },
    ]);
    expect(screen.getByText("QA B2 — Título CRM — o Google prevaleceu: —. Valor do CRM guardado: —.")).toBeTruthy();
    // Só o início válido: mostra o início, sem inventar término nem duração.
    expect(screen.getByText(/restaurado por Dra\. Fictícia: 27\/10\/2026, 17:00$/)).toBeTruthy();
    // Término antes do início: não mostra uma duração negativa.
    expect(screen.getByText(/restaurado por Dra\. Fictícia: 27\/10\/2026, 18:30$/)).toBeTruthy();
    expect(screen.queryByText(/NaN|Invalid Date|-\d+ min/)).toBeNull();
  });
});
