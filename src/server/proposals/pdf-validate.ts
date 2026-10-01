import { inflateSync } from "node:zlib";

import { extrairTextoDesenhado } from "@/server/proposals/pdf-text";

/**
 * Validação do PDF gerado, ANTES de qualquer upload/finalize (B1,
 * correção 8).
 *
 * Por que existe: `finalize_proposal_document` (correção 5) reconfere
 * existência e tamanho no Storage contra o checksum que a própria
 * aplicação calculou. Isso prova "o que gravamos é o que está lá" — e
 * continuou provando isso corretamente até para arquivos quebrados.
 * O que não provava é que os bytes são um PDF que abre.
 *
 * Caso real que motivou esta função (ver docs/decisoes/b1-propostas.md
 * §10): a validação hospedada rodava sob `environment: "jsdom"`, onde
 * `Buffer instanceof Uint8Array` é `false` (o `Uint8Array` global é o do
 * realm do jsdom, não o do Node). O `_write` do pdfkit tem exatamente
 * este desvio:
 *
 *     if (!(data instanceof Uint8Array)) data = fromBinaryString(data + '\n');
 *
 * `data + '\n'` chama `Buffer.prototype.toString()`, que decodifica os
 * bytes binários do fluxo já comprimido como UTF-8: todo byte >= 0x80
 * vira U+FFFD e, mascarado com `& 0xff`, chega ao arquivo como 0xFD. O
 * `/Length` já tinha sido escrito com o tamanho de antes, então o fluxo
 * não bate com o próprio tamanho declarado e não descomprime — o PDF
 * abre e a página renderiza em branco. 16 versões foram gravadas assim,
 * todas com checksum e tamanho coerentes.
 *
 * Cabeçalho, tamanho e checksum não detectam nada disso. Esta validação
 * descomprime cada fluxo e confere o conteúdo essencial, usando só
 * `node:zlib` — sem serviço novo e sem dependência nova em produção.
 */

export type ProposalPdfInvalidCode =
  | "pdf_sem_cabecalho"
  | "pdf_sem_eof"
  | "pdf_sem_pagina"
  | "pdf_sem_fluxo_de_conteudo"
  | "pdf_fluxo_truncado"
  | "pdf_fluxo_nao_descomprime"
  | "pdf_sem_texto"
  | "pdf_conteudo_essencial_ausente";

export class ProposalPdfInvalidError extends Error {
  readonly code: ProposalPdfInvalidCode;

  constructor(code: ProposalPdfInvalidCode, detalhe?: string) {
    super(detalhe ? `${code}: ${detalhe}` : code);
    this.name = "ProposalPdfInvalidError";
    this.code = code;
  }
}

type FluxoBruto = { dicionario: string; dados: Buffer };

function* fluxos(pdf: Buffer): Generator<FluxoBruto> {
  const texto = pdf.toString("latin1");
  let pos = 0;
  for (;;) {
    const i = texto.indexOf("stream", pos);
    if (i < 0) return;
    // "endstream" também contém "stream" — pular.
    if (texto.slice(i - 3, i) === "end") {
      pos = i + 6;
      continue;
    }
    const fimDic = texto.lastIndexOf(">>", i);
    const inicioDic = fimDic < 0 ? -1 : texto.lastIndexOf("<<", fimDic);
    const dicionario = inicioDic < 0 ? "" : texto.slice(inicioDic, fimDic + 2);

    let inicio = i + "stream".length;
    if (texto[inicio] === "\r") inicio++;
    if (texto[inicio] === "\n") inicio++;
    const fim = texto.indexOf("endstream", inicio);
    if (fim < 0) return;

    yield { dicionario, dados: pdf.subarray(inicio, fim) };
    pos = fim + "endstream".length;
  }
}

const semEspacos = (s: string) => s.replace(/\s+/g, "");

/**
 * Lança `ProposalPdfInvalidError` se os bytes não forem um PDF que abre
 * e que contenha o conteúdo essencial da proposta. Nunca devolve valor:
 * ou passa, ou lança.
 */
export function assertValidProposalPdf(pdf: Buffer, esperado: { proposalNumber: string }): void {
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new ProposalPdfInvalidError("pdf_sem_cabecalho");
  }
  const comoTexto = pdf.toString("latin1");
  if (!comoTexto.includes("%%EOF")) {
    throw new ProposalPdfInvalidError("pdf_sem_eof");
  }
  if (!comoTexto.includes("/Type /Page")) {
    throw new ProposalPdfInvalidError("pdf_sem_pagina");
  }

  let fluxosFlate = 0;
  for (const { dicionario, dados } of fluxos(pdf)) {
    if (!dicionario.includes("/FlateDecode")) continue;
    fluxosFlate++;

    const declarado = Number(/\/Length (\d+)/.exec(dicionario)?.[1] ?? NaN);
    if (Number.isFinite(declarado) && dados.length < declarado) {
      // Assinatura exata do defeito: o tamanho foi escrito antes da
      // conversão que encolheu os bytes.
      throw new ProposalPdfInvalidError(
        "pdf_fluxo_truncado",
        `declarado=${declarado} presente=${dados.length}`,
      );
    }

    const bruto = Number.isFinite(declarado) ? dados.subarray(0, declarado) : dados;
    try {
      // Vale para TODO fluxo comprimido — conteúdo de página, fonte
      // embutida, CMap. Qualquer um corrompido reprova o documento.
      inflateSync(bruto);
    } catch (erro) {
      throw new ProposalPdfInvalidError(
        "pdf_fluxo_nao_descomprime",
        erro instanceof Error ? erro.message : undefined,
      );
    }
  }

  if (fluxosFlate === 0) {
    throw new ProposalPdfInvalidError("pdf_sem_fluxo_de_conteudo");
  }

  // Lê como um leitor de PDF leria: pelo `/ToUnicode`, não pelos códigos
  // crus — senão o resultado dependeria de a fonte ser padrão ou embutida.
  const texto = extrairTextoDesenhado(pdf);
  if (texto.trim().length === 0) {
    throw new ProposalPdfInvalidError("pdf_sem_texto");
  }
  if (!semEspacos(texto).includes(semEspacos(esperado.proposalNumber))) {
    throw new ProposalPdfInvalidError(
      "pdf_conteudo_essencial_ausente",
      `numero da proposta ausente (${esperado.proposalNumber})`,
    );
  }
}
