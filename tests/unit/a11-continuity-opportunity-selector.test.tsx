import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { LeadAttribution, OpportunityAttribution } from "@/modules/attribution/queries";

/**
 * Achado real (Cenário 2, continuidade): o botão oficial "Gerar link" do
 * AttributionPanel só envia `leadId` ao Server Action — a RPC
 * `issue_continuity_reference` aceita `opportunityId` opcional, mas a
 * interface nunca oferecia como escolhê-lo, mesmo quando o lead tem
 * oportunidade(s) elegível(is). Usar a referência resultante num endpoint
 * `continuity` reaproveita o LEAD mas nunca a oportunidade — o touchpoint
 * fica "Não atribuído" em vez de vinculado à demanda original.
 */

const { issueContinuityMock, correctMock, revokeMock } = vi.hoisted(() => ({
  issueContinuityMock: vi.fn(),
  correctMock: vi.fn(),
  revokeMock: vi.fn(),
}));

vi.mock("@/modules/forms/actions", () => ({
  issueContinuityReferenceAction: issueContinuityMock,
  revokeContinuityReferenceAction: revokeMock,
  correctTouchpointLinkAction: correctMock,
}));

const { AttributionPanel } = await import("@/components/leads/attribution-panel");

function attribution(opportunities: OpportunityAttribution[]): LeadAttribution {
  return { leadId: "lead-1", sequence: [], opportunities };
}

function opp(id: string, stageName: string, status = "open"): OpportunityAttribution {
  return {
    opportunityId: id,
    stageName,
    status,
    wonAt: null,
    firstTouchId: null,
    lastTouchId: null,
    conversionId: null,
  };
}

beforeEach(() => {
  issueContinuityMock.mockReset();
  correctMock.mockReset();
  revokeMock.mockReset();
  issueContinuityMock.mockImplementation(async () => ({ ok: true, token: "tok-fake", expiresAt: null }));
});

describe("seletor de oportunidade no link de continuidade", () => {
  it("prova o defeito: sem seletor nenhum, o Server Action só recebia leadId, nunca opportunityId", async () => {
    // Reprodução textual do defeito: mesmo com uma oportunidade elegível
    // no lead, o form antigo não tinha campo `opportunityId` nenhum — só
    // `leadId`. Este teste falha contra o código ANTES da correção
    // (nenhum <select> "Oportunidade" existe) e passa depois, provando
    // que a opção passou a existir e ser preenchível.
    render(
      <AttributionPanel
        attribution={attribution([opp("opp-1", "Fazer primeiro contato")])}
        canCorrect={false}
        canIssueContinuity={true}
        leadId="lead-1"
      />,
    );

    expect(screen.getByLabelText("Oportunidade")).toBeVisible();
  });

  it("com UMA oportunidade elegível, ela vem pré-selecionada e o Server Action recebe o opportunityId dela", async () => {
    render(
      <AttributionPanel
        attribution={attribution([opp("opp-1", "Fazer primeiro contato")])}
        canCorrect={false}
        canIssueContinuity={true}
        leadId="lead-1"
      />,
    );

    const select = screen.getByLabelText("Oportunidade") as HTMLSelectElement;
    expect(select.value).toBe("opp-1");

    fireEvent.click(screen.getByRole("button", { name: "Gerar link" }));

    await waitFor(() => expect(issueContinuityMock).toHaveBeenCalled());
    const formData = issueContinuityMock.mock.calls[0]![1] as FormData;
    expect(formData.get("leadId")).toBe("lead-1");
    expect(formData.get("opportunityId")).toBe("opp-1");
  });

  it("com VÁRIAS oportunidades, nenhuma vem pré-selecionada — o usuário precisa escolher conscientemente", () => {
    render(
      <AttributionPanel
        attribution={attribution([opp("opp-1", "Fazer primeiro contato"), opp("opp-2", "Qualificar oportunidade")])}
        canCorrect={false}
        canIssueContinuity={true}
        leadId="lead-1"
      />,
    );

    const select = screen.getByLabelText("Oportunidade") as HTMLSelectElement;
    expect(select.value).toBe("");
  });

  it("selecionando explicitamente uma das várias oportunidades, o Server Action recebe exatamente ela", async () => {
    render(
      <AttributionPanel
        attribution={attribution([opp("opp-1", "Fazer primeiro contato"), opp("opp-2", "Qualificar oportunidade")])}
        canCorrect={false}
        canIssueContinuity={true}
        leadId="lead-1"
      />,
    );

    fireEvent.change(screen.getByLabelText("Oportunidade"), { target: { value: "opp-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Gerar link" }));

    await waitFor(() => expect(issueContinuityMock).toHaveBeenCalled());
    const formData = issueContinuityMock.mock.calls[0]![1] as FormData;
    expect(formData.get("opportunityId")).toBe("opp-2");
  });

  it("escolhendo 'Sem oportunidade vinculada' explicitamente com várias disponíveis, o Server Action recebe string vazia", async () => {
    render(
      <AttributionPanel
        attribution={attribution([opp("opp-1", "Fazer primeiro contato"), opp("opp-2", "Qualificar oportunidade")])}
        canCorrect={false}
        canIssueContinuity={true}
        leadId="lead-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Gerar link" }));

    await waitFor(() => expect(issueContinuityMock).toHaveBeenCalled());
    const formData = issueContinuityMock.mock.calls[0]![1] as FormData;
    expect(formData.get("opportunityId")).toBe("");
  });

  it("sem oportunidade nenhuma no lead, a ausência de vínculo é rotulada, nunca implícita, e não há seletor", () => {
    render(
      <AttributionPanel
        attribution={attribution([])}
        canCorrect={false}
        canIssueContinuity={true}
        leadId="lead-1"
      />,
    );

    expect(screen.getByText(/Sem oportunidade vinculada/)).toBeVisible();
    expect(screen.queryByLabelText("Oportunidade")).toBeNull();
  });

  it("erro do servidor (ex.: oportunidade deixou de ser válida entre o carregamento e o envio) aparece na interface", async () => {
    issueContinuityMock.mockImplementation(async () => ({ ok: false, error: "Oportunidade não encontrada." }));

    render(
      <AttributionPanel
        attribution={attribution([opp("opp-1", "Fazer primeiro contato")])}
        canCorrect={false}
        canIssueContinuity={true}
        leadId="lead-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Gerar link" }));
    expect(await screen.findByText("Oportunidade não encontrada.")).toBeVisible();
  });

  it("sem permissão de emitir continuidade, nem o botão nem o seletor aparecem (sem regressão de controle de acesso)", () => {
    render(
      <AttributionPanel
        attribution={attribution([opp("opp-1", "Fazer primeiro contato")])}
        canCorrect={false}
        canIssueContinuity={false}
        leadId="lead-1"
      />,
    );

    expect(screen.queryByRole("button", { name: "Gerar link" })).toBeNull();
    expect(screen.queryByLabelText("Oportunidade")).toBeNull();
  });
});
