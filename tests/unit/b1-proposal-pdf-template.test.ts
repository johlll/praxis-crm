/**
 * @vitest-environment node
 *
 * Node, não jsdom: sob jsdom o pdfkit corrompe o fluxo comprimido
 * (`Buffer instanceof Uint8Array` é `false` em outro realm — ver
 * docs/decisoes/b1-propostas.md §10 e tests/unit/b1-proposal-pdf-validate.test.ts).
 * Produção roda em Node; o teste precisa rodar onde a produção roda.
 */
import { describe, expect, it } from "vitest";

import { renderProposalPdf, type ProposalPdfData } from "@/server/proposals/pdf-template";
import { assertValidProposalPdf } from "@/server/proposals/pdf-validate";

/**
 * B1, correção 6: nenhum campo de office/client é obrigatório. Um
 * escritório que ainda não preencheu OAB/endereço, ou um cliente sem
 * CPF/CNPJ capturado, continuam gerando PDF normalmente.
 *
 * A prova aqui era a assinatura `%PDF` nos primeiros bytes — e isso não
 * provava nada: os 16 arquivos quebrados do §10 passavam nessa checagem.
 * Agora a prova é o PDF abrir de verdade e conter o número da proposta.
 */

const MINIMAL_DATA: ProposalPdfData = {
  office: {
    legalName: null,
    cnpj: null,
    oabUf: null,
    oabNumber: null,
    addressLine: null,
    addressCity: null,
    addressUf: null,
    addressZip: null,
  },
  client: { name: "Cliente Sem Dados Opcionais", cpfCnpj: null },
  proposal: {
    number: "PROP-2026-0001",
    valueCents: 500000,
    feeModel: "fixed",
    createdAt: "2026-09-29T12:00:00.000Z",
  },
  legalArea: null,
};

const FULL_DATA: ProposalPdfData = {
  office: {
    legalName: "Escritório Teste Ltda.",
    cnpj: "12345678000199",
    oabUf: "SP",
    oabNumber: "123456",
    addressLine: "Rua Teste, 100",
    addressCity: "São Paulo",
    addressUf: "SP",
    addressZip: "01000000",
  },
  client: { name: "Cliente Completo", cpfCnpj: "12345678901" },
  proposal: {
    number: "PROP-2026-0002",
    valueCents: 1000000,
    feeModel: "contingency",
    createdAt: "2026-09-29T12:00:00.000Z",
  },
  legalArea: "Trabalhista",
};

describe("renderProposalPdf — B1", () => {
  it("gera um PDF que ABRE mesmo com todos os campos opcionais ausentes", async () => {
    const buffer = await renderProposalPdf(MINIMAL_DATA);
    expect(() => assertValidProposalPdf(buffer, { proposalNumber: "PROP-2026-0001" })).not.toThrow();
  });

  it("gera um PDF que ABRE com todos os campos opcionais preenchidos", async () => {
    const buffer = await renderProposalPdf(FULL_DATA);
    expect(() => assertValidProposalPdf(buffer, { proposalNumber: "PROP-2026-0002" })).not.toThrow();
  });
});
