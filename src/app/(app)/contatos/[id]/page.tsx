import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { getContactDetail } from "@/modules/contacts/queries";
import { ContactBasicFieldsForm } from "@/components/contacts/contact-basic-fields-form";
import { ContactPhonesList } from "@/components/contacts/contact-phones-list";
import { ContactEmailsList } from "@/components/contacts/contact-emails-list";
import { ContactSensitiveSection } from "@/components/contacts/contact-sensitive-section";

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

  return (
    <>
      <Topbar title={contact.name} subtitle={contact.type === "pf" ? "Pessoa física" : "Pessoa jurídica"} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[640px] flex-col gap-5">
          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-3 text-body font-semibold text-text">Dados básicos</h2>
            <ContactBasicFieldsForm contact={contact} />
          </section>

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
        </div>
      </main>
    </>
  );
}
