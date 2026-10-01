/**
 * @vitest-environment node
 *
 * Roda em `node`, não no `jsdom` padrão — e isso É parte do que se
 * testa. Sob jsdom, `Buffer instanceof Uint8Array` é `false` (o
 * `Uint8Array` global vem de outro realm), e o `_write` do pdfkit cai no
 * desvio `fromBinaryString(data + '\n')`, que decodifica o fluxo já
 * comprimido como UTF-8 e destrói todo byte >= 0x80. Foi assim que 16
 * versões de PROP-2026-0003 foram gravadas quebradas, com checksum e
 * tamanho coerentes (docs/decisoes/b1-propostas.md §10). Produção roda
 * em Node (Vercel), onde o `instanceof` vale — então o ambiente do teste
 * precisa ser o mesmo da produção, ou o teste mente.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderProposalPdf, type ProposalPdfData } from "@/server/proposals/pdf-template";
import { assertValidProposalPdf, ProposalPdfInvalidError } from "@/server/proposals/pdf-validate";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

const DADOS: ProposalPdfData = {
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

/** Leitor INDEPENDENTE (pdfjs-dist, da Mozilla) — não reusa nada do
 *  nosso validador, senão o teste só confirmaria a si mesmo. */
async function textoPorLeitorIndependente(bytes: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const tarefa = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const doc = await tarefa.promise;
  const partes: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const pagina = await doc.getPage(n);
    const conteudo = await pagina.getTextContent();
    for (const item of conteudo.items) {
      if ("str" in item) partes.push(item.str);
    }
  }
  await tarefa.destroy();
  return partes.join(" ");
}

describe("assertValidProposalPdf — B1 correção 8", () => {
  it("aceita o PDF que a aplicação gera", async () => {
    const bytes = await renderProposalPdf(DADOS);
    expect(() => assertValidProposalPdf(bytes, { proposalNumber: "PROP-2026-0002" })).not.toThrow();
  });

  it("REJEITA o arquivo corrompido reproduzido neste caso (v1 real, anexado ao e-mail)", () => {
    const bytes = readFileSync(join(FIXTURES, "b1-v1-corrompido.pdf"));
    // Tem cabeçalho %PDF, abre num visualizador e tem checksum/tamanho
    // coerentes — tudo que a B1 conferia antes passava.
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    let erro: unknown;
    try {
      assertValidProposalPdf(bytes, { proposalNumber: "PROP-2026-0003" });
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(ProposalPdfInvalidError);
    expect((erro as ProposalPdfInvalidError).code).toBe("pdf_fluxo_truncado");
  });

  it("rejeita quando o conteúdo essencial não é o esperado", async () => {
    const bytes = await renderProposalPdf(DADOS);
    let erro: unknown;
    try {
      assertValidProposalPdf(bytes, { proposalNumber: "PROP-2026-9999" });
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(ProposalPdfInvalidError);
    expect((erro as ProposalPdfInvalidError).code).toBe("pdf_conteudo_essencial_ausente");
  });

  it("rejeita um PDF sem nenhum texto desenhado", () => {
    const vazio = Buffer.from(
      "%PDF-1.3\n1 0 obj\n<< /Type /Page >>\nendobj\ntrailer\n<<>>\n%%EOF\n",
      "latin1",
    );
    expect(() => assertValidProposalPdf(vazio, { proposalNumber: "PROP-2026-0001" })).toThrow(
      ProposalPdfInvalidError,
    );
  });
});

describe("leitor independente (pdfjs-dist) confirma o conteúdo", () => {
  it("extrai do PDF gerado agora os campos essenciais da proposta", async () => {
    const bytes = await renderProposalPdf(DADOS);
    const texto = await textoPorLeitorIndependente(bytes);
    expect(texto).toContain("PROP-2026-0002");
    expect(texto).toContain("Escritório Teste Ltda.");
    expect(texto).toContain("Cliente Completo");
    expect(texto).toContain("R$ 10.000,00");
  });

  it("extrai o mesmo conteúdo do PDF gerado pelo BUILD REAL em produção (v18)", async () => {
    const bytes = readFileSync(join(FIXTURES, "b1-v18-build-real.pdf"));
    expect(() => assertValidProposalPdf(bytes, { proposalNumber: "PROP-2026-0003" })).not.toThrow();

    const texto = await textoPorLeitorIndependente(bytes);
    expect(texto).toContain("PROP-2026-0003");
    expect(texto).toContain("Escritório Modelo QA B1 Ltda.");
    expect(texto).toContain("Cliente A9 Revalidação (fictício)");
    expect(texto).toContain("R$ 1.234,00");
  });

  it("o leitor independente não acha texto nenhum no arquivo corrompido", async () => {
    const bytes = readFileSync(join(FIXTURES, "b1-v1-corrompido.pdf"));
    const texto = await textoPorLeitorIndependente(bytes);
    expect(texto.trim()).toBe("");
  });
});
