"use client";

import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";

/**
 * GET simples (sem JS de submissão custom) — `q` vira searchParam da
 * própria página, que já decide entre nome (ilike) e CPF/CNPJ (blind
 * index) dependendo do formato do termo.
 */
export function ContactSearchForm({ defaultValue }: { defaultValue: string }) {
  return (
    <form action="/contatos" method="get" className="relative max-w-[360px] flex-1">
      <Search
        size={14}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
        aria-hidden
      />
      <Input
        name="q"
        type="search"
        defaultValue={defaultValue}
        placeholder="Nome, telefone, e-mail ou CPF/CNPJ"
        className="pl-8"
        aria-label="Buscar contatos"
      />
    </form>
  );
}
