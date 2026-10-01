import { Document, Font, Image, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

import { LOGO_VIZENTINI, MANROPE_400, MANROPE_600 } from "@/server/proposals/assets-embutidos";
import { CORES, FONTE, PAGINA } from "@/server/proposals/pdf-theme";
import type { FeeModel } from "@/modules/proposals/queries";

/**
 * Template FIXO nesta fase (B1, decisão revisada) — um único cliente,
 * sem tela de customização. Todo campo de office/client é opcional:
 * nenhum bloqueia a renderização, só a linha correspondente some do
 * documento quando ausente (B1, correção 6) — nunca "undefined" nem
 * espaço em branco malformado.
 *
 * O documento usa SOMENTE dados que já existem no CRM. Não há cláusula,
 * condição de pagamento, prazo de validade, contato ou campo de
 * assinatura: nada disso é capturado em lugar nenhum, e inventar num
 * documento que vai ao cliente seria afirmar o que o escritório não
 * disse.
 */
export type ProposalPdfData = {
  office: {
    legalName: string | null;
    cnpj: string | null;
    oabUf: string | null;
    oabNumber: string | null;
    addressLine: string | null;
    addressCity: string | null;
    addressUf: string | null;
    addressZip: string | null;
  };
  client: {
    name: string;
    cpfCnpj: string | null;
  };
  proposal: {
    number: string;
    valueCents: number;
    feeModel: FeeModel;
    createdAt: string;
  };
  legalArea: string | null;
};

const FEE_MODEL_LABEL: Record<FeeModel, string> = {
  fixed: "Honorários fixos",
  contingency: "Honorários por êxito",
  fixed_contingency: "Honorários fixos + êxito",
};

/**
 * Registro idempotente: `renderProposalPdf` pode ser chamado várias
 * vezes no mesmo processo (serverless reaproveita instância) e registrar
 * a família de novo a cada chamada desperdiça trabalho à toa.
 */
let fonteRegistrada = false;
function registrarFonte() {
  if (fonteRegistrada) return;
  Font.register({
    family: FONTE,
    fonts: [
      { src: MANROPE_400, fontWeight: 400 },
      { src: MANROPE_600, fontWeight: 600 },
    ],
  });
  // A Manrope não traz hifenização para português; o padrão do
  // react-pdf quebraria palavras em lugares errados num documento
  // jurídico. Melhor quebrar só entre palavras.
  Font.registerHyphenationCallback((palavra) => [palavra]);
  fonteRegistrada = true;
}

function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
}

/** CPF (11 dígitos) ou CNPJ (14 dígitos) — só dígitos na entrada, já
 * normalizados por quem chama (normalizeCpfCnpj/CNPJ da própria coluna). */
function formatCpfCnpj(digits: string): string {
  if (digits.length === 11) {
    return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  }
  if (digits.length === 14) {
    return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  }
  return digits;
}

const styles = StyleSheet.create({
  page: {
    paddingTop: PAGINA.margemTopo,
    paddingBottom: PAGINA.margemRodape,
    paddingHorizontal: PAGINA.margemLateral,
    fontSize: 10,
    fontFamily: FONTE,
    fontWeight: 400,
    color: CORES.corpo,
    backgroundColor: CORES.marfim,
    lineHeight: 1.55,
  },

  // Cabeçalho — logo à esquerda, identificação à direita.
  cabecalho: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  logo: { width: 142, height: 40 },
  escritorio: { alignItems: "flex-end", maxWidth: 230 },
  escritorioNome: { fontSize: 9.5, fontWeight: 600, color: CORES.verde, textAlign: "right", marginBottom: 3 },
  escritorioLinha: { fontSize: 8, color: CORES.meta, textAlign: "right", lineHeight: 1.5 },
  fioCabecalho: { marginTop: 18, borderBottomWidth: 0.75, borderBottomColor: CORES.bronze },

  // Título, número e data.
  blocoTitulo: { marginTop: 40 },
  titulo: { fontSize: 23, fontWeight: 600, color: CORES.verde, letterSpacing: -0.3 },
  metaLinha: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginTop: 12 },
  numero: { fontSize: 10.5, fontWeight: 600, color: CORES.bronze, letterSpacing: 0.4 },
  data: { fontSize: 9, color: CORES.meta },
  fioTitulo: { marginTop: 10, borderBottomWidth: 0.5, borderBottomColor: CORES.fio },

  // Seções.
  secao: { marginTop: 30 },
  rotulo: {
    fontSize: 7.5,
    fontWeight: 600,
    color: CORES.bronze,
    letterSpacing: 1.7,
    textTransform: "uppercase",
    marginBottom: 9,
  },
  clienteNome: { fontSize: 13, fontWeight: 600, color: CORES.grafite },
  clienteDoc: { fontSize: 9, color: CORES.meta, marginTop: 3 },
  objeto: { fontSize: 10.5, color: CORES.corpo, lineHeight: 1.7, textAlign: "justify" },

  // Honorários — único bloco de destaque do documento.
  honorarios: {
    marginTop: 30,
    backgroundColor: CORES.marfimBloco,
    borderLeftWidth: 2,
    borderLeftColor: CORES.bronze,
    paddingVertical: 20,
    paddingHorizontal: 22,
  },
  honorariosModelo: { fontSize: 10, color: CORES.corpo },
  honorariosValor: { fontSize: 25, fontWeight: 600, color: CORES.verde, marginTop: 8, letterSpacing: -0.4 },

  // Rodapé fixo. Três elementos absolutos independentes, em vez de um
  // flex com `space-between`: num container absoluto o `space-between`
  // não distribuiu, e a paginação acabava colada no texto da esquerda,
  // fora da margem direita.
  rodapeFio: {
    position: "absolute",
    left: PAGINA.margemLateral,
    right: PAGINA.margemLateral,
    bottom: 46,
    borderTopWidth: 0.5,
    borderTopColor: CORES.bronzeClaro,
  },
  rodapeTexto: {
    position: "absolute",
    left: PAGINA.margemLateral,
    bottom: 32,
    width: PAGINA.larguraUtil - 44,
    fontSize: 7.5,
    color: CORES.meta,
  },
  rodapePagina: {
    position: "absolute",
    left: PAGINA.margemLateral,
    bottom: 32,
    width: PAGINA.larguraUtil,
    fontSize: 7.5,
    color: CORES.meta,
    textAlign: "right",
  },
});

export function ProposalPdfDocument({
  office,
  client,
  proposal,
  legalArea,
  totalPaginas,
}: ProposalPdfData & { totalPaginas?: number | null }) {
  registrarFonte();

  const cidadeUf = office.addressCity && office.addressUf ? `${office.addressCity}/${office.addressUf}` : null;
  const endereco = [office.addressLine, cidadeUf].filter(Boolean).join(" — ");
  const oab = office.oabNumber ? `OAB ${[office.oabUf, office.oabNumber].filter(Boolean).join(" ")}` : null;

  return (
    <Document title={`Proposta de honorários ${proposal.number}`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.cabecalho} fixed={false}>
          {/* Não é <img>: o Image do react-pdf não tem prop alt, e um PDF
              não tem leitor de tela para consumir texto alternativo. */}
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image style={styles.logo} src={{ data: LOGO_VIZENTINI, format: "png" }} />
          <View style={styles.escritorio}>
            {office.legalName ? <Text style={styles.escritorioNome}>{office.legalName}</Text> : null}
            {office.cnpj ? <Text style={styles.escritorioLinha}>CNPJ {formatCpfCnpj(office.cnpj)}</Text> : null}
            {oab ? <Text style={styles.escritorioLinha}>{oab}</Text> : null}
            {endereco ? <Text style={styles.escritorioLinha}>{endereco}</Text> : null}
            {office.addressZip ? <Text style={styles.escritorioLinha}>CEP {office.addressZip}</Text> : null}
          </View>
        </View>
        <View style={styles.fioCabecalho} />

        <View style={styles.blocoTitulo}>
          <Text style={styles.titulo}>Proposta de honorários</Text>
          <View style={styles.metaLinha}>
            <Text style={styles.numero}>{proposal.number}</Text>
            <Text style={styles.data}>{formatDate(proposal.createdAt)}</Text>
          </View>
          <View style={styles.fioTitulo} />
        </View>

        <View style={styles.secao} wrap={false}>
          <Text style={styles.rotulo}>Cliente</Text>
          <Text style={styles.clienteNome}>{client.name}</Text>
          {client.cpfCnpj ? <Text style={styles.clienteDoc}>{formatCpfCnpj(client.cpfCnpj)}</Text> : null}
        </View>

        {legalArea ? (
          <View style={styles.secao}>
            {/* Sem wrap={false}: objeto longo precisa poder fluir para a
                página seguinte em vez de ser empurrado inteiro. */}
            <Text style={styles.rotulo}>Objeto</Text>
            <Text style={styles.objeto}>{legalArea}</Text>
          </View>
        ) : null}

        <View style={styles.honorarios} wrap={false}>
          <Text style={styles.rotulo}>Honorários</Text>
          <Text style={styles.honorariosModelo}>{FEE_MODEL_LABEL[proposal.feeModel]}</Text>
          <Text style={styles.honorariosValor}>{formatMoney(proposal.valueCents)}</Text>
        </View>

        <View style={styles.rodapeFio} fixed />
        <Text style={styles.rodapeTexto} fixed>
          {[office.legalName, `Proposta ${proposal.number}`].filter(Boolean).join(" · ")} · Documento gerado
          eletronicamente
        </Text>
        {totalPaginas && totalPaginas > 1 ? (
          <Text style={styles.rodapePagina} fixed>
            Documento com {totalPaginas} páginas
          </Text>
        ) : null}

      </Page>
    </Document>
  );
}

/** Páginas do PDF — `/Type /Page`, sem casar com `/Type /Pages`. */
function contarPaginas(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
}

/**
 * Duas passagens: a primeira descobre quantas páginas o documento tem, a
 * segunda escreve esse total no rodapé.
 *
 * Por que não a prop `render` do react-pdf (a forma documentada de
 * numerar páginas): ela não funciona na 4.9.0 instalada. Testado com
 * string e com JSX, em fluxo normal e com `fixed`, em `Text` e em
 * `View` — em nenhum caso o conteúdo é desenhado (num dos casos os
 * glifos até entram no fluxo, mas nada é pintado). Enquanto isso não for
 * resolvido, o rodapé informa a extensão do documento em vez do número
 * da página — o que o leitor precisa saber é se falta folha.
 */
export async function renderProposalPdf(data: ProposalPdfData): Promise<Buffer> {
  const primeira = await renderToBuffer(<ProposalPdfDocument {...data} />);
  const paginas = contarPaginas(primeira);
  if (paginas <= 1) return primeira;
  return renderToBuffer(<ProposalPdfDocument {...data} totalPaginas={paginas} />);
}
