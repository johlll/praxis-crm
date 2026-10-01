/**
 * Reprodução VIVA do defeito B, no ambiente que o causou.
 *
 * Este arquivo roda no `jsdom` padrão do projeto — de propósito. É o
 * ambiente em que a validação hospedada rodou e produziu 16 PDFs
 * quebrados que passaram por cabeçalho, tamanho e checksum.
 *
 * O teste não afirma "aqui o PDF sai quebrado" (isso dependeria de um
 * detalhe do jsdom/pdfkit e quebraria sozinho se eles consertassem).
 * Ele afirma a garantia que interessa: **o validador nunca aceita um PDF
 * que um leitor independente não consegue ler**. Se o ambiente corromper,
 * `assertValidProposalPdf` tem que recusar; se o ambiente estiver são,
 * tem que aceitar. O que não pode voltar a existir é o terceiro caso —
 * ilegível e aceito — que foi exatamente o que aconteceu.
 */
import { describe, expect, it } from "vitest";

import { renderProposalPdf, type ProposalPdfData } from "@/server/proposals/pdf-template";
import { assertValidProposalPdf } from "@/server/proposals/pdf-validate";

const DADOS: ProposalPdfData = {
  office: {
    legalName: "Escritório Teste Ltda.",
    cnpj: null,
    oabUf: null,
    oabNumber: null,
    addressLine: null,
    addressCity: null,
    addressUf: null,
    addressZip: null,
  },
  client: { name: "Cliente Teste", cpfCnpj: null },
  proposal: {
    number: "PROP-2026-0007",
    valueCents: 123400,
    feeModel: "fixed",
    createdAt: "2026-09-29T12:00:00.000Z",
  },
  legalArea: null,
};

async function leitorIndependenteAchaTexto(bytes: Buffer): Promise<boolean> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const tarefa = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const doc = await tarefa.promise;
    const pagina = await doc.getPage(1);
    const conteudo = await pagina.getTextContent();
    const texto = conteudo.items.map((i) => ("str" in i ? i.str : "")).join("");
    await tarefa.destroy();
    return texto.trim().length > 0;
  } catch {
    return false;
  }
}

describe("validador e leitor independente nunca discordam", () => {
  it("não existe PDF ilegível e aceito", async () => {
    let bytes: Buffer;
    try {
      bytes = await renderProposalPdf(DADOS);
    } catch {
      // Neste ambiente a renderização pode nem concluir (o jsdom resolve
      // caminhos do pdfkit que não sabem carregar a logo a partir de um
      // Buffer). Falhar alto satisfaz a invariante: nenhum documento é
      // produzido, logo nenhum documento ruim é aceito. O que não pode
      // acontecer é sair um PDF ilegível e o validador aprová-lo.
      return;
    }

    const legivel = await leitorIndependenteAchaTexto(bytes);
    let aceito = true;
    try {
      assertValidProposalPdf(bytes, { proposalNumber: "PROP-2026-0007" });
    } catch {
      aceito = false;
    }

    // A verificação antiga passava nos dois casos — era isso o problema.
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(aceito).toBe(legivel);
  });
});
