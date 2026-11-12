import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { getContactDetail, listContactMergeHistory } from "@/modules/contacts/queries";
import { roleHasPermission } from "@/lib/roles";
import { ContactBasicFieldsForm } from "@/components/contacts/contact-basic-fields-form";
import { ContactPhonesList } from "@/components/contacts/contact-phones-list";
import { ContactEmailsList } from "@/components/contacts/contact-emails-list";
import { ContactSensitiveSection } from "@/components/contacts/contact-sensitive-section";
import { ContactMergeHistory } from "@/components/contacts/contact-merge-history";
import { ContactPrivacySection } from "@/components/contacts/contact-privacy-section";
import { getRetentionStatus } from "@/server/privacy/retention";
import { CustomFieldsSection } from "@/components/custom-fields/custom-fields-section";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const contact = await getContactDetail(id);
  return { title: contact ? `${contact.name} — Praxis CRM Jurídico` : "Contato — Praxis CRM Jurídico" };
}

export default async function ContatoDetalhePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { user } = await getShellContext();
  const contact = await getContactDetail(id);

  if (!contact) notFound();

  const mergeHistory = await listContactMergeHistory(id);
  const canUndoMerge = roleHasPermission(user.role, "contact.merge");
  const canEditContact = roleHasPermission(user.role, "contact.edit");
  const canExportPrivacy = roleHasPermission(user.role, "privacy.manage");
  // C3b — contato anonimizado é imutável para dados pessoais: a tela esconde as ações de edição
  // (o banco recusa de qualquer forma).
  const anonymized = Boolean(contact.anonymizedAt);
  // C3b — estado da retenção (só owner/admin). Sem conteúdo pessoal; falha vira aviso na seção.
  const retention = canExportPrivacy ? await getRetentionStatus(contact.id) : null;

  return (
    <>
      <Topbar title={contact.name} subtitle={contact.type === "pf" ? "Pessoa física" : "Pessoa jurídica"} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[640px] flex-col gap-5">
          {anonymized ? (
            <section className="rounded-lg border border-border bg-surface p-4">
              <h2 className="mb-2 text-body font-semibold text-text">Contato anonimizado</h2>
              <p className="text-small text-text-secondary">
                Os dados pessoais deste contato foram removidos e ele não aceita novos dados, para que o histórico preservado não volte
                a identificar ninguém. Para um novo atendimento da mesma pessoa, cadastre um contato novo.
              </p>
            </section>
          ) : (
            <>
          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-3 text-body font-semibold text-text">Dados básicos</h2>
            <ContactBasicFieldsForm contact={contact} />
          </section>

          <CustomFieldsSection entity="contact" recordId={contact.id} canEdit={canEditContact} />

          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-3 text-body font-semibold text-text">Telefones</h2>
            <ContactPhonesList contactId={contact.id} phones={contact.phones} />
          </section>

          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-3 text-body font-semibold text-text">E-mails</h2>
            <ContactEmailsList contactId={contact.id} emails={contact.emails} />
          </section>

          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-3 text-body font-semibold text-text">CPF/CNPJ</h2>
            <ContactSensitiveSection contactId={contact.id} hasSensitive={contact.hasSensitive} />
          </section>

          {mergeHistory.length > 0 ? (
            <section className="rounded-lg border border-border bg-surface p-4">
              <h2 className="mb-3 text-body font-semibold text-text">Mesclagens</h2>
              <ContactMergeHistory contactId={contact.id} canUndo={canUndoMerge} history={mergeHistory} />
            </section>
          ) : null}
            </>
          )}

          {canExportPrivacy ? (
            <ContactPrivacySection contactId={contact.id} initialRetention={retention?.ok ? retention.status : null} />
          ) : null}
        </div>
      </main>
    </>
  );
}
