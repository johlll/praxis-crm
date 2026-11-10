/**
 * C3a — formato do arquivo de exportação dos dados de um titular.
 *
 * Puro (sem I/O): recebe o que o banco devolveu e o CPF/CNPJ já decifrado e
 * monta o objeto final. Nada aqui lê banco, grava arquivo ou escreve em log.
 *
 * O arquivo é entregue como download e descartado — nunca persistido.
 */

export const PRIVACY_EXPORT_FORMAT = "praxis_data_subject_export_v1" as const;

/** Códigos fechados de falha — os mesmos que a tabela de registro aceita. */
export const PRIVACY_EXPORT_FAILURES = ["data_unavailable", "decryption_failed", "internal_error"] as const;
export type PrivacyExportFailure = (typeof PRIVACY_EXPORT_FAILURES)[number];

/**
 * Categorias de LISTA que o banco precisa devolver, na ordem em que aparecem
 * no arquivo. Falta de qualquer uma é falha (nunca arquivo parcial).
 */
export const PRIVACY_EXPORT_LIST_CATEGORIES = [
  "phones",
  "emails",
  "identifiers",
  "consents",
  "consent_evidence",
  "leads",
  "opportunities",
  "opportunity_requirements",
  "stage_history",
  "activities",
  "clients",
  "client_handoffs",
  "proposals",
  "proposal_documents",
  "proposal_email_sends",
  "lead_notes",
  "conflict_checks",
  "conversations",
  "messages",
  "message_status_events",
  "whatsapp_identities",
  "attribution_touchpoints",
  "attribution_links",
  "continuity_references",
  "custom_fields",
] as const;

export type PrivacyExportSection = { has_data: boolean; items: unknown[] };

export type PrivacyExportDocument = {
  format: typeof PRIVACY_EXPORT_FORMAT;
  generated_at: string;
  subject: { contact_id: string };
  sections: Record<string, PrivacyExportSection>;
};

export class PrivacyExportDataError extends Error {
  constructor(public readonly code: PrivacyExportFailure) {
    super(code);
    this.name = "PrivacyExportDataError";
  }
}

function section(items: unknown[]): PrivacyExportSection {
  return { has_data: items.length > 0, items };
}

/**
 * Monta o documento. `data` é o conteúdo do banco (sem o ciphertext do CPF);
 * `cpfCnpj` é o valor decifrado no servidor, ou null quando não há cadastro.
 * Estrutura inesperada = falha com código fechado, nunca saída parcial.
 */
export function buildSubjectExport(input: {
  contactId: string;
  generatedAt: Date;
  data: unknown;
  cpfCnpj: string | null;
}): PrivacyExportDocument {
  const data = input.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new PrivacyExportDataError("data_unavailable");
  }
  const record = data as Record<string, unknown>;

  const contact = record.contact;
  if (typeof contact !== "object" || contact === null || Array.isArray(contact)) {
    throw new PrivacyExportDataError("data_unavailable");
  }

  const sections: Record<string, PrivacyExportSection> = { contact: section([contact]) };
  for (const key of PRIVACY_EXPORT_LIST_CATEGORIES) {
    const value = record[key];
    if (!Array.isArray(value)) throw new PrivacyExportDataError("data_unavailable");
    sections[key] = section(value);
  }

  // Posição fixa logo depois do contato e das formas de contato: o CPF/CNPJ.
  const ordered: Record<string, PrivacyExportSection> = {};
  for (const [key, value] of Object.entries(sections)) {
    ordered[key] = value;
    if (key === "identifiers") {
      ordered.sensitive_data = section(input.cpfCnpj === null ? [] : [{ field: "cpf_cnpj", value: input.cpfCnpj }]);
    }
  }

  return {
    format: PRIVACY_EXPORT_FORMAT,
    generated_at: input.generatedAt.toISOString(),
    subject: { contact_id: input.contactId },
    sections: ordered,
  };
}

/** Nome do arquivo sem PII: só o id do contato e a data (UTC). */
export function exportFileName(contactId: string, date: Date): string {
  return `titular-${contactId}-${date.toISOString().slice(0, 10)}.json`;
}
