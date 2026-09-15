import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Três achados do segundo review da A9 (docs/decisoes/a9-perfil-360.md
 * §11): falha na segunda página de atividades não pode sumir com o
 * "carregar mais"; a consulta do cartão "Consulta" não pode depender da
 * página já carregada; e o filtro da timeline precisa continuar coerente
 * com os eventos exibidos depois de uma revalidação ou de uma troca que
 * falhou.
 */

const { rpcMock, loadMoreActivitiesMock, loadMoreTimelineMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  loadMoreActivitiesMock: vi.fn(),
  loadMoreTimelineMock: vi.fn(),
}));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));

vi.mock("@/modules/activities/actions", () => ({
  loadMoreLeadActivitiesAction: loadMoreActivitiesMock,
}));

vi.mock("@/modules/timeline/actions", () => ({
  loadMoreLeadTimelineAction: loadMoreTimelineMock,
}));

// ActivitiesSection traz diálogos/ações de linha que dependem de Server
// Actions reais — fora do escopo destes testes, que só olham a paginação.
vi.mock("@/components/activities/activities-section", () => ({
  ActivitiesSection: ({ activities }: { activities: Array<{ id: string; title: string }> }) => (
    <ul>
      {activities.map((a) => (
        <li key={a.id}>{a.title}</li>
      ))}
    </ul>
  ),
}));

const { listActivitiesPageOrThrow, getLastCompletedMeeting, ActivitiesLoadError, ConsultationLoadError } =
  await import("@/modules/activities/queries");
const { LeadActivitiesSection } = await import("@/components/leads/lead-activities-section");
const { LeadTimeline } = await import("@/components/leads/lead-timeline");

function activityRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    lead_id: "lead-1",
    opportunity_id: null,
    contact_name: "Contato",
    legal_area: "Cível",
    type: "task",
    title: `Atividade ${id}`,
    notes: null,
    assigned_to: null,
    assigned_to_name: null,
    priority: "media",
    due_at: "2026-09-20T12:00:00Z",
    has_time: false,
    status: "pending",
    completed_at: null,
    source: "manual",
    lock_version: 0,
    created_at: "2026-09-10T12:00:00Z",
    updated_at: "2026-09-10T12:00:00Z",
    ...overrides,
  };
}

function activityItem(id: string) {
  return {
    id,
    leadId: "lead-1",
    opportunityId: null,
    contactName: "Contato",
    legalArea: "Cível",
    type: "task" as const,
    title: `Atividade ${id}`,
    notes: null,
    assignedTo: null,
    assignedToName: null,
    priority: "media" as const,
    dueAt: "2026-09-20T12:00:00Z",
    hasTime: false,
    status: "pending" as const,
    completedAt: null,
    source: "manual" as const,
    lockVersion: 0,
    createdAt: "2026-09-10T12:00:00Z",
    updatedAt: "2026-09-10T12:00:00Z",
    isOverdue: false,
  };
}

beforeEach(() => {
  rpcMock.mockReset();
  loadMoreActivitiesMock.mockReset();
  loadMoreTimelineMock.mockReset();
});

describe("falha na segunda página de atividades", () => {
  it("listActivitiesPageOrThrow joga ActivitiesLoadError em vez de devolver lista vazia", async () => {
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: "conexão perdida (simulado)" } }));

    await expect(
      listActivitiesPageOrThrow("ws-1", { leadId: "lead-1", status: "all", page: 2, pageSize: 50 }),
    ).rejects.toThrow(ActivitiesLoadError);
  });

  it("calcula hasMore a partir do total do RPC", async () => {
    rpcMock.mockImplementation(async () => ({
      data: [{ items: [activityRow("a51")], total_count: 120, counts: {} }],
      error: null,
    }));

    const result = await listActivitiesPageOrThrow("ws-1", { leadId: "lead-1", status: "all", page: 2, pageSize: 50 });
    expect(result.hasMore).toBe(true);
    expect(result.items.map((i) => i.id)).toEqual(["a51"]);
  });

  it("mantém os itens já carregados, mostra o erro e deixa tentar de novo", async () => {
    loadMoreActivitiesMock
      .mockResolvedValueOnce({ ok: false, error: "Não foi possível carregar mais atividades. Tente novamente." })
      .mockResolvedValueOnce({ ok: true, items: [activityItem("a51")], hasMore: false });

    render(
      <LeadActivitiesSection
        leadId="lead-1"
        members={[]}
        canEdit={false}
        initialItems={[activityItem("a1")]}
        initialHasMore={true}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Carregar mais atividades" }));
    expect(await screen.findByText("Não foi possível carregar mais atividades. Tente novamente.")).toBeVisible();
    expect(screen.getByText("Atividade a1")).toBeVisible();
    expect(screen.getByRole("button", { name: "Carregar mais atividades" })).toBeEnabled();
    expect(loadMoreActivitiesMock).toHaveBeenLastCalledWith("lead-1", 2);

    // A nova tentativa pede a MESMA página 2 (a falha não avançou o cursor).
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais atividades" }));
    expect(await screen.findByText("Atividade a51")).toBeVisible();
    expect(loadMoreActivitiesMock).toHaveBeenLastCalledWith("lead-1", 2);
    expect(screen.queryByText("Não foi possível carregar mais atividades. Tente novamente.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Carregar mais atividades" })).toBeNull();
  });
});

describe("consulta fora das primeiras 50 atividades", () => {
  it("busca a última reunião concluída direto no RPC dedicado, sem depender da página carregada", async () => {
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn !== "get_last_completed_meeting") throw new Error(`RPC inesperado: ${fn}`);
      return {
        data: activityRow("m-antiga-na-lista", {
          type: "meeting",
          status: "done",
          title: "Consulta inicial",
          completed_at: "2026-09-14T15:00:00Z",
        }),
        error: null,
      };
    });

    const meeting = await getLastCompletedMeeting("lead-1");
    expect(rpcMock).toHaveBeenCalledWith("get_last_completed_meeting", { p_lead_id: "lead-1" });
    expect(meeting?.id).toBe("m-antiga-na-lista");
    expect(meeting?.completedAt).toBe("2026-09-14T15:00:00Z");
  });

  it("sem reunião concluída devolve null (não é erro)", async () => {
    rpcMock.mockImplementation(async () => ({ data: null, error: null }));
    await expect(getLastCompletedMeeting("lead-1")).resolves.toBeNull();
  });

  it("falha operacional joga ConsultationLoadError — nunca some com o cartão em silêncio", async () => {
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: "conexão perdida (simulado)" } }));
    await expect(getLastCompletedMeeting("lead-1")).rejects.toThrow(ConsultationLoadError);
  });
});

describe("filtro da timeline coerente com os eventos exibidos", () => {
  const nota = { eventType: "nota" as const, occurredAt: "2026-09-14T10:00:00Z", id: "n1", payload: { body: "Nota inicial" } };
  const proposta = {
    eventType: "proposta" as const,
    occurredAt: "2026-09-01T10:00:00Z",
    id: "p1",
    payload: { number: "PROP-2026-0001", status: "aceita" },
  };
  const notaNova = { eventType: "nota" as const, occurredAt: "2026-09-15T10:00:00Z", id: "n2", payload: { body: "Nota nova" } };

  it("revalidação com filtro ativo volta para 'Todos' junto com a primeira página de todos os tipos", async () => {
    loadMoreTimelineMock.mockResolvedValueOnce({ ok: true, items: [proposta], hasMore: false });

    const { rerender } = render(
      <LeadTimeline leadId="lead-1" initialItems={[nota]} initialHasMore={false} members={[]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Propostas" }));
    expect(await screen.findByText("Proposta PROP-2026-0001")).toBeVisible();
    expect(screen.getByRole("button", { name: "Propostas" })).toHaveAttribute("aria-pressed", "true");
    expect(loadMoreTimelineMock).toHaveBeenCalledWith("lead-1", ["proposta"]);

    // Uma anotação criada por outra Server Action revalida a página: o
    // servidor manda uma primeira página nova, de todos os tipos.
    await act(async () => {
      rerender(<LeadTimeline leadId="lead-1" initialItems={[notaNova, nota]} initialHasMore={false} members={[]} />);
    });

    expect(screen.getByRole("button", { name: "Todos" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Propostas" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Nota nova")).toBeVisible();
    expect(screen.queryByText("Proposta PROP-2026-0001")).toBeNull();
  });

  it("troca de filtro que falha mantém o filtro anterior indicado e os eventos dele", async () => {
    loadMoreTimelineMock.mockResolvedValueOnce({ ok: false, error: "Não foi possível carregar eventos. Tente novamente." });

    render(<LeadTimeline leadId="lead-1" initialItems={[nota]} initialHasMore={false} members={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Propostas" }));
    expect(await screen.findByText("Não foi possível carregar eventos. Tente novamente.")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Todos" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: "Propostas" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Nota inicial")).toBeVisible();
  });

  it("'carregar mais' mantém o filtro ativo no cursor seguinte", async () => {
    loadMoreTimelineMock
      .mockResolvedValueOnce({ ok: true, items: [proposta], hasMore: true })
      .mockResolvedValueOnce({ ok: true, items: [], hasMore: false });

    render(<LeadTimeline leadId="lead-1" initialItems={[nota]} initialHasMore={false} members={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Propostas" }));
    await screen.findByText("Proposta PROP-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais" }));

    await waitFor(() =>
      expect(loadMoreTimelineMock).toHaveBeenLastCalledWith("lead-1", ["proposta"], { occurredAt: proposta.occurredAt, id: "p1" }),
    );
  });
});
