import Link from "next/link";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * GET simples (sem JS de submissão custom) — `q` vira searchParam da
 * própria página, que já decide entre nome (ilike) e CPF/CNPJ (blind
 * index) dependendo do formato do termo. "Limpar busca" é só um link de
 * volta para a listagem sem `q`.
 */
export function ContactSearchForm({ defaultValue }: { defaultValue: string }) {
  return (
    <form action="/contatos" method="get" role="search" aria-label="Busca de contatos" className="flex min-w-0 flex-1 items-center gap-1">
      <div className="relative min-w-0 flex-1 md:max-w-[520px]">
        <Search
          size={15}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-muted"
          aria-hidden
        />
        <Input
          name="q"
          type="search"
          defaultValue={defaultValue}
          placeholder="Nome, telefone, e-mail ou CPF/CNPJ"
          className="pl-9"
          aria-label="Buscar contatos"
        />
      </div>
      {defaultValue ? (
        <Button asChild variant="ghost" className="shrink-0">
          <Link href="/contatos">
            <X size={14} aria-hidden />
            <span className="max-md:sr-only">Limpar busca</span>
          </Link>
        </Button>
      ) : null}
    </form>
  );
}
