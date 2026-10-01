/**
 * @vitest-environment node
 */
import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderProposalPdf, type ProposalPdfData } from "@/server/proposals/pdf-template";
import { assertValidProposalPdf } from "@/server/proposals/pdf-validate";
import { extrairTextoDesenhado } from "@/server/proposals/pdf-text";

const ESCRITORIO = {
  legalName: "Vizentini Advocacia (amostra fictícia)",
  cnpj: "12345678000199",
  oabUf: "SP",
  oabNumber: "513578",
  addressLine: "Rua Fictícia de Amostra, 100",
  addressCity: "Socorro",
  addressUf: "SP",
  addressZip: "13960000",
};

const CURTA: ProposalPdfData = {
  office: ESCRITORIO,
  client: { name: "Marina Alvarenga Figueiredo (fictícia)", cpfCnpj: "12345678901" },
  proposal: {
    number: "PROP-2026-0101",
    valueCents: 1850000,
    feeModel: "fixed",
    createdAt: "2026-10-01T12:00:00.000Z",
  },
  legalArea:
    "Regularização de imóvel rural com área de 4,2 hectares, incluindo levantamento documental, retificação de área junto ao registro de imóveis e acompanhamento até a averbação final.",
};

const OBJETO_LONGO = [
  "Assessoria jurídica integral para a regularização e posterior incorporação de empreendimento imobiliário de alto padrão situado em área de expansão urbana, compreendendo as seguintes frentes de trabalho:",
  "",
  "Primeiro, auditoria documental completa da cadeia dominial dos últimos vinte anos, com análise de todas as transmissões, eventuais vícios de registro, identificação de ônus reais, gravames, penhoras, hipotecas e quaisquer restrições administrativas ou ambientais incidentes sobre a gleba, incluindo verificação de sobreposição com áreas de preservação permanente e reserva legal.",
  "",
  "Segundo, condução do procedimento de retificação administrativa de área perante o Cartório de Registro de Imóveis competente, com elaboração de memorial descritivo georreferenciado, obtenção de anuência dos confrontantes, instrução do pedido e acompanhamento integral até a efetiva averbação, incluindo resposta a eventuais notas devolutivas e, se necessário, conversão para a via judicial.",
  "",
  "Terceiro, obtenção das licenças e aprovações urbanísticas e ambientais exigidas pela municipalidade e pelos órgãos estaduais competentes, abrangendo diretrizes urbanísticas, aprovação de projeto de parcelamento do solo, licenciamento ambiental nas modalidades prévia, de instalação e de operação, bem como acompanhamento de eventuais condicionantes impostas.",
  "",
  "Quarto, estruturação jurídica da incorporação imobiliária nos termos da Lei nº 4.591/1964, com elaboração e registro do memorial de incorporação, instituição de patrimônio de afetação, redação dos instrumentos de comercialização das unidades autônomas e assessoria na constituição da convenção de condomínio.",
  "",
  "Quinto, planejamento tributário da operação, com análise comparativa dos regimes aplicáveis, dimensionamento da carga incidente sobre a alienação das unidades e orientação quanto ao recolhimento de ITBI, ITR, IPTU e tributos federais incidentes sobre o resultado do empreendimento.",
  "",
  "Sexto, acompanhamento contencioso preventivo e, quando necessário, representação em demandas administrativas ou judiciais decorrentes diretamente das frentes acima, excluídas ações indenizatórias de terceiros e litígios trabalhistas, que, se houver, serão objeto de proposta própria.",
].join("\n");

const LONGA: ProposalPdfData = {
  office: ESCRITORIO,
  client: {
    name: "Construtora e Incorporadora Alvarenga Figueiredo Participações Empreendimentos Imobiliários S.A. (fictícia)",
    cpfCnpj: "12345678000199",
  },
  proposal: {
    number: "PROP-2026-0102",
    valueCents: 24750000,
    feeModel: "fixed_contingency",
    createdAt: "2026-10-01T12:00:00.000Z",
  },
  legalArea: OBJETO_LONGO,
};

/** Páginas do PDF — `/Type /Page`, sem casar com `/Type /Pages`. */
const contarPaginas = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s])/g) ?? []).length;

/** Com PASTA_AMOSTRAS definida, grava os PDFs para conferência visual. */
function talvezGravar(nome: string, bytes: Buffer) {
  const pasta = process.env.PASTA_AMOSTRAS;
  if (pasta) writeFileSync(`${pasta}/${nome}.pdf`, bytes);
}

describe("layout da proposta — B1 redesign", () => {
  it("proposta curta cabe em uma página e é válida", async () => {
    const bytes = await renderProposalPdf(CURTA);
    talvezGravar("amostra-curta", bytes);

    expect(() => assertValidProposalPdf(bytes, { proposalNumber: CURTA.proposal.number })).not.toThrow();
    expect(contarPaginas(bytes)).toBe(1);

    const texto = extrairTextoDesenhado(bytes);
    // Sem extensão no rodapé quando é uma página só — dizer "documento
    // com 1 página" é ruído.
    expect(texto).not.toContain("Documento com");
  });

  it("objeto longo pagina, mantém o conteúdo e anuncia a extensão no rodapé", async () => {
    const bytes = await renderProposalPdf(LONGA);
    talvezGravar("amostra-longa", bytes);

    expect(() => assertValidProposalPdf(bytes, { proposalNumber: LONGA.proposal.number })).not.toThrow();
    expect(contarPaginas(bytes)).toBe(2);

    // O formatador de moeda do pt-BR usa espaço não-quebrável entre "R$"
    // e o número; normalizar deixa a asserção legível.
    const texto = extrairTextoDesenhado(bytes).replace(/ /g, " ");
    expect(texto).toContain("Documento com 2 páginas");
    // Nada se perde na quebra: primeiro e último trechos do objeto, e o
    // bloco de honorários, continuam no documento.
    expect(texto).toContain("Assessoria jurídica integral");
    expect(texto).toContain("serão objeto de proposta própria");
    expect(texto).toContain("R$ 247.500,00");
    expect(texto).toContain("Honorários fixos + êxito");
    // Nome longo de cliente não é truncado.
    expect(texto).toContain("Construtora e Incorporadora Alvarenga Figueiredo Participações Empreendimentos");
  });

  it("acentuação e símbolos sobrevivem à fonte embutida", async () => {
    const texto = extrairTextoDesenhado(await renderProposalPdf(LONGA)).replace(/ /g, " ");
    for (const trecho of ["Fictícia", "honorários", "incorporação", "patrimônio", "órgãos", "R$", "—", "·"]) {
      expect(texto).toContain(trecho);
    }
  });
});
