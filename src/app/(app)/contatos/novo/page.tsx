import type { Metadata } from "next";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { CreateContactForm } from "@/components/contacts/create-contact-form";

export const metadata: Metadata = {
  title: "Novo contato — Praxis CRM Jurídico",
};

export default async function NovoContatoPage() {
  const { user } = await getShellContext();

  return (
    <>
      <Topbar title="Novo contato" user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-[520px]">
          <div className="rounded-lg border border-border bg-surface p-5">
            <CreateContactForm />
          </div>
        </div>
      </main>
    </>
  );
}
