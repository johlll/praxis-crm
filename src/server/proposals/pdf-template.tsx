import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

import type { FeeModel } from "@/modules/proposals/queries";

/**
 * Template FIXO nesta fase (B1, decisão revisada) — um único cliente,
 * sem tela de customização. Todo campo de office/client é opcional:
 * nenhum bloqueia a renderização, só a linha correspondente some do
 * documento quando ausente (B1, correção 6) — nunca "undefined" nem
 * espaço em branco malformado.
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
  page: { padding: 48, fontSize: 10, fontFamily: "Helvetica", color: "#17201E" },
  header: { marginBottom: 24, borderBottom: "1pt solid #C9C6BB", paddingBottom: 12 },
  officeName: { fontSize: 14, fontWeight: 700, marginBottom: 2 },
  officeLine: { fontSize: 9, color: "#4C5551" },
  title: { fontSize: 16, fontWeight: 700, marginTop: 24, marginBottom: 4 },
  subtitle: { fontSize: 10, color: "#4C5551", marginBottom: 20 },
  section: { marginBottom: 16 },
  sectionTitle: { fontSize: 10, fontWeight: 700, marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 },
  row: { flexDirection: "row", marginBottom: 3 },
  label: { width: 140, color: "#6E7671" },
  value: { flex: 1 },
  valueHighlight: { fontSize: 13, fontWeight: 700 },
  footer: { position: "absolute", bottom: 32, left: 48, right: 48, fontSize: 8, color: "#8A918D", textAlign: "center" },
});

export function ProposalPdfDocument({ office, client, proposal, legalArea }: ProposalPdfData) {
  const officeAddress = [office.addressLine, office.addressCity && office.addressUf ? `${office.addressCity}/${office.addressUf}` : null]
    .filter(Boolean)
    .join(" — ");

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          {office.legalName ? <Text style={styles.officeName}>{office.legalName}</Text> : null}
          {office.cnpj ? <Text style={styles.officeLine}>CNPJ {formatCpfCnpj(office.cnpj)}</Text> : null}
          {office.oabNumber ? (
            <Text style={styles.officeLine}>
              OAB {office.oabUf ? `${office.oabUf} ` : ""}
              {office.oabNumber}
            </Text>
          ) : null}
          {officeAddress ? <Text style={styles.officeLine}>{officeAddress}</Text> : null}
          {office.addressZip ? <Text style={styles.officeLine}>CEP {office.addressZip}</Text> : null}
        </View>

        <Text style={styles.title}>Proposta de honorários {proposal.number}</Text>
        <Text style={styles.subtitle}>{formatDate(proposal.createdAt)}</Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Cliente</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Nome</Text>
            <Text style={styles.value}>{client.name}</Text>
          </View>
          {client.cpfCnpj ? (
            <View style={styles.row}>
              <Text style={styles.label}>CPF/CNPJ</Text>
              <Text style={styles.value}>{formatCpfCnpj(client.cpfCnpj)}</Text>
            </View>
          ) : null}
        </View>

        {legalArea ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Objeto</Text>
            <Text>{legalArea}</Text>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Honorários</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Modelo</Text>
            <Text style={styles.value}>{FEE_MODEL_LABEL[proposal.feeModel]}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Valor</Text>
            <Text style={styles.valueHighlight}>{formatMoney(proposal.valueCents)}</Text>
          </View>
        </View>

        <View style={styles.footer}>
          <Text>
            Documento gerado eletronicamente — proposta {proposal.number}. Sujeito aos termos combinados entre as
            partes.
          </Text>
        </View>
      </Page>
    </Document>
  );
}

export async function renderProposalPdf(data: ProposalPdfData): Promise<Buffer> {
  return renderToBuffer(<ProposalPdfDocument {...data} />);
}
