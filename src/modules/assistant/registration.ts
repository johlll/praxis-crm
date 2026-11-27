import { createContactSchema } from "@/modules/contacts/schema";
import { createLeadSchema } from "@/modules/leads/schema";
import type { ContactMatch, RegistrationDraft, RequiredRegistrationField } from "./types";

/**
 * Regras do cadastro por conversa, sem servidor (testáveis). Os campos são validados com os MESMOS
 * esquemas da tela de novo contato e de novo lead: nome, telefone e e-mail como no contato, área e assunto
 * como no lead.
 */

const leadFields = createLeadSchema.pick({ legalArea: true, summary: true });

export type ValidRegistration = {
  name: string;
  legalArea: string;
  summary: string | null;
  phones: { value_normalized: string; is_primary: boolean }[];
  emails: { value_normalized: string; is_primary: boolean }[];
};

export function validateRegistration(
  workspaceId: string,
  draft: RegistrationDraft,
): { ok: true; value: ValidRegistration } | { ok: false; message: string } {
  const contact = createContactSchema.safeParse({
    workspaceId,
    type: "pf",
    name: draft.name ?? "",
    phones: draft.phone ? [draft.phone] : [],
    emails: draft.email ? [draft.email] : [],
  });
  if (!contact.success) return { ok: false, message: contact.error.issues[0]?.message ?? "Dados inválidos." };
  const lead = leadFields.safeParse({ legalArea: draft.legalArea ?? "", summary: draft.summary ?? "" });
  if (!lead.success) return { ok: false, message: lead.error.issues[0]?.message ?? "Dados inválidos." };
  return {
    ok: true,
    value: {
      name: contact.data.name,
      legalArea: lead.data.legalArea,
      summary: lead.data.summary ? lead.data.summary : null,
      phones: contact.data.phones.map((value) => ({ value_normalized: value, is_primary: true })),
      emails: contact.data.emails.map((value) => ({ value_normalized: value, is_primary: true })),
    },
  };
}

const REASON: Record<string, string> = {
  phone: "mesmo telefone",
  email: "mesmo e-mail",
  same_name: "nome igual",
  similar_name: "nome parecido",
};

export function mapMatches(raw: unknown): ContactMatch[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    if (typeof r.contact_id !== "string" || typeof r.name !== "string") return [];
    const signals = Array.isArray(r.signals) ? r.signals.filter((s): s is string => typeof s === "string") : [];
    return [
      {
        contactId: r.contact_id,
        name: r.name,
        reasons: signals.map((s) => REASON[s] ?? s),
        leadCount: typeof r.lead_count === "number" ? r.lead_count : 0,
        href: `/contatos/${r.contact_id}`,
      },
    ];
  });
}

export function questionFor(missing: RequiredRegistrationField[], draft: RegistrationDraft): string {
  if (missing.includes("name") && missing.includes("legalArea")) {
    return "Para cadastrar, preciso do nome da pessoa e do assunto do caso. Por exemplo: “Ana Ribeiro, regularização de imóvel”.";
  }
  if (missing.includes("name")) {
    return `Qual é o nome da pessoa${draft.summary ? ` do caso “${draft.summary}”` : ""}?`;
  }
  return `Qual é a área jurídica do caso${draft.name ? ` de ${draft.name}` : ""}${
    draft.summary ? ` (“${draft.summary}”)` : ""
  }? Por exemplo: Família, Trabalhista, Imobiliário.`;
}
