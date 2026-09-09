import type { Metadata } from "next";
import Link from "next/link";
import { Copy, Plus, Users as UsersIcon } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/feedback/empty-state";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { listContacts, listPendingDuplicateCandidates } from "@/modules/contacts/queries";
import { ContactSearchForm } from "@/components/contacts/contact-search-form";
import { ContactListTable } from "@/components/contacts/contact-list-table";
import { Pagination } from "@/components/contacts/pagination";

export const metadata: Metadata = {
  title: "Contatos — Praxis CRM Jurídico",
};

export default async function ContatosPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const params = await searchParams;
  const page = Number(params.page) > 0 ? Number(params.page) : 1;

  const [{ items, total, pageSize }, duplicateCandidates] = await Promise.all([
    listContacts(workspaceId, { search: params.q, page }),
    listPendingDuplicateCandidates(workspaceId),
  ]);

  return (
    <>
      <Topbar
        title="Contatos"
        subtitle={`${total} ${total === 1 ? "contato" : "contatos"}`}
        user={user}
      />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[960px] flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <ContactSearchForm defaultValue={params.q ?? ""} />
            <div className="flex shrink-0 gap-2">
              <Button asChild variant="secondary" size="sm">
                <Link href="/contatos/duplicidades">
                  <Copy size={14} aria-hidden />
                  Duplicidades
                  {duplicateCandidates.length > 0 ? ` (${duplicateCandidates.length})` : ""}
                </Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/contatos/novo">
                  <Plus size={14} aria-hidden />
                  Novo contato
                </Link>
              </Button>
            </div>
          </div>

          {items.length === 0 ? (
            <EmptyState
              icon={UsersIcon}
              title={params.q ? "Nenhum contato encontrado" : "Nenhum contato ainda"}
              description={
                params.q
                  ? "Tente outro nome, telefone, e-mail ou CPF/CNPJ."
                  : "Cadastre o primeiro contato do escritório."
              }
            />
          ) : (
            <>
              <ContactListTable items={items} />
              <Pagination page={page} total={total} pageSize={pageSize} basePath="/contatos" query={params.q} />
            </>
          )}
        </div>
      </main>
    </>
  );
}
