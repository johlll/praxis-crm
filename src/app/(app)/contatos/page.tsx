import type { Metadata } from "next";
import Link from "next/link";
import { Copy, Plus, SearchX, Users as UsersIcon } from "lucide-react";

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

function countLabel(total: number, searching: boolean) {
  const n = total.toLocaleString("pt-BR");
  if (searching) return `${n} ${total === 1 ? "contato encontrado" : "contatos encontrados"}`;
  return `${n} ${total === 1 ? "contato cadastrado" : "contatos cadastrados"}`;
}

export default async function ContatosPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const params = await searchParams;
  const page = Number(params.page) > 0 ? Number(params.page) : 1;
  const searching = Boolean(params.q);

  const [{ items, total, pageSize }, duplicateCandidates] = await Promise.all([
    listContacts(workspaceId, { search: params.q, page }),
    listPendingDuplicateCandidates(workspaceId),
  ]);

  return (
    <>
      <Topbar title="Contatos" subtitle={countLabel(total, searching)} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <ContactSearchForm defaultValue={params.q ?? ""} />
            <div className="flex shrink-0 gap-2 max-md:order-first">
              <Button asChild variant="secondary" className="max-md:flex-1">
                <Link href="/contatos/duplicidades">
                  <Copy size={14} aria-hidden />
                  Duplicidades
                  {duplicateCandidates.length > 0 ? (
                    <span className="ml-0.5 rounded-pill bg-accent-tint px-1.5 py-px text-[11px] font-bold text-accent tabular-nums">
                      {duplicateCandidates.length}
                      <span className="sr-only"> pendentes</span>
                    </span>
                  ) : null}
                </Link>
              </Button>
              <Button asChild className="max-md:flex-1">
                <Link href="/contatos/novo">
                  <Plus size={15} aria-hidden />
                  Novo contato
                </Link>
              </Button>
            </div>
          </div>

          {items.length === 0 ? (
            searching ? (
              <EmptyState
                icon={SearchX}
                title="Nenhum contato encontrado"
                description="Tente outro nome, telefone, e-mail ou CPF/CNPJ."
              />
            ) : (
              <EmptyState
                icon={UsersIcon}
                title="Nenhum contato ainda"
                description="Cadastre o primeiro contato do escritório."
                action={
                  <Button asChild size="sm">
                    <Link href="/contatos/novo">
                      <Plus size={14} aria-hidden />
                      Novo contato
                    </Link>
                  </Button>
                }
              />
            )
          ) : (
            <>
              <ContactListTable items={items} />
              <Pagination
                page={page}
                total={total}
                pageSize={pageSize}
                itemCount={items.length}
                basePath="/contatos"
                query={params.q}
              />
            </>
          )}
        </div>
      </main>
    </>
  );
}
