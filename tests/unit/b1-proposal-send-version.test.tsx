import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProposalsSection } from "@/components/leads/proposals-section";
import type { ProposalDocumentListItem, ProposalEmailSendListItem } from "@/modules/proposals/documents-queries";
import type { ProposalListItem } from "@/modules/proposals/queries";

/**
 * B1, §10 — defeito A: o formulário de envio anexava a versão pronta
 * MAIS ANTIGA enquanto a tela listava a mais recente no topo.
 *
 * `list_proposal_documents` devolve `order by d.version desc`
 * (20260929120200_b1_proposal_documents_functions.sql). O teste entrega
 * os documentos nessa MESMA ordem — a ordem real da RPC — e confere o
 * `document_id` que de fato vai no formulário submetido. Era isso que
 * nenhum teste olhava: a tela certa escondia o formulário errado.
 */

vi.mock("@/modules/proposals/documents-actions", () => ({
  generateProposalDocumentAction: vi.fn(),
  dispatchProposalEmailAction: vi.fn(),
}));

vi.mock("@/modules/proposals/actions", () => ({
  createProposalAction: vi.fn(),
  sendProposalAction: vi.fn(),
  decideProposalAction: vi.fn(),
}));

const PROPOSTA: ProposalListItem = {
  id: "11111111-1111-4111-8111-111111111111",
  opportunityId: "22222222-2222-4222-8222-222222222222",
  number: "PROP-2026-0003",
  status: "rascunho",
  sentChannels: [],
  sentAt: null,
  decidedAt: null,
  decisionNote: null,
  lockVersion: 1,
  createdAt: "2026-09-29T12:00:00.000Z",
  valueCents: 123400,
};

const doc = (version: number, id: string, status: ProposalDocumentListItem["status"] = "ready") => ({
  id,
  version,
  status,
  requestedAt: "2026-09-29T12:00:00.000Z",
  resolvedAt: status === "ready" ? "2026-09-29T12:00:01.000Z" : null,
  canDownload: status === "ready",
});

const ID_V1 = "44156d85-cd7b-43cb-9ee8-6570d87148a3";
const ID_V17 = "b881573d-8c4e-40bc-824e-1317e32b4059";
const ID_V18 = "e48c78fd-7a48-4c71-8836-2cf525e0abb6";

function renderizar(documentos: ProposalDocumentListItem[]) {
  const emailSends: Record<string, ProposalEmailSendListItem[]> = { [PROPOSTA.id]: [] };
  return render(
    <ProposalsSection
      leadId="33333333-3333-4333-8333-333333333333"
      opportunityId={PROPOSTA.opportunityId}
      proposals={[PROPOSTA]}
      canEdit
      canManageDocuments
      documentsByProposal={{ [PROPOSTA.id]: documentos }}
      emailSendsByProposal={emailSends}
      contactEmails={["cliente@exemplo.com"]}
      hasWorkspaceLegalProfile
    />,
  );
}

/** Abre o diálogo e lê o campo que de fato será submetido. */
function documentIdSubmetido(): string | null {
  fireEvent.click(screen.getByRole("button", { name: "Enviar por e-mail" }));
  const campo = document.querySelector<HTMLInputElement>('input[name="documentId"]');
  return campo?.value ?? null;
}

describe("B1 — versão anexada ao envio", () => {
  it("envia a versão pronta MAIS RECENTE quando a RPC devolve em version desc", () => {
    // Ordem exata da RPC: v18, v17, v1.
    renderizar([doc(18, ID_V18), doc(17, ID_V17), doc(1, ID_V1)]);
    expect(documentIdSubmetido()).toBe(ID_V18);
  });

  it("não depende da ordem da lista — ordem ascendente dá o mesmo resultado", () => {
    renderizar([doc(1, ID_V1), doc(17, ID_V17), doc(18, ID_V18)]);
    expect(documentIdSubmetido()).toBe(ID_V18);
  });

  it("ignora versões que não estão prontas, mesmo sendo as mais recentes", () => {
    // v19 em geração (o caso real da v14 presa em "Gerando…").
    renderizar([doc(19, "99999999-9999-4999-8999-999999999999", "pending"), doc(18, ID_V18), doc(1, ID_V1)]);
    expect(documentIdSubmetido()).toBe(ID_V18);
  });

  it("mostra na tela qual versão será enviada, antes de abrir o diálogo", () => {
    renderizar([doc(18, ID_V18), doc(17, ID_V17), doc(1, ID_V1)]);
    expect(screen.getByText("Enviará a v18")).toBeInTheDocument();
  });
});
