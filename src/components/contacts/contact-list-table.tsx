import Link from "next/link";
import { MapPin, Phone } from "lucide-react";

import { ListTag } from "@/components/lists/list-tag";
import { PersonInitials } from "@/components/lists/person-initials";
import { formatPhoneForDisplay } from "@/lib/format-phone";
import type { ContactListItem } from "@/modules/contacts/queries";

const TYPE_LABEL: Record<ContactListItem["type"], string> = { pf: "PF", pj: "PJ" };
const TYPE_NAME: Record<ContactListItem["type"], string> = { pf: "Pessoa física", pj: "Pessoa jurídica" };

const th = "px-4 py-2.5 text-label font-semibold tracking-[1px] text-text-tertiary uppercase";
/** Célula secundária: coluna da tabela no computador; item da linha de detalhes no celular. */
const metaBase = "px-4 py-2.5 align-middle text-text-secondary";
const meta = `${metaBase} max-md:inline-flex max-md:items-center max-md:gap-1.5 max-md:p-0 max-md:text-small`;
/** Sem valor: "—" na coluna do computador; no cartão do celular o item simplesmente não aparece. */
const metaMissing = `${metaBase} max-md:hidden`;

function Missing({ what }: { what: string }) {
  return (
    <span className="text-text-muted">
      <span aria-hidden>—</span>
      <span className="sr-only">{what} não informado</span>
    </span>
  );
}

/**
 * Componente de servidor: só o HTML pronto vai ao navegador — nenhum campo
 * a mais do que a linha mostra. No celular a mesma linha vira um cartão
 * (nome e e-mail no topo, tipo, cidade e telefone embaixo), sem cortar
 * nada e sem rolagem lateral.
 */
export function ContactListTable({ items }: { items: ContactListItem[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <table className="w-full border-collapse text-left text-body max-md:block md:table-fixed">
        <caption className="sr-only">Contatos do escritório</caption>
        <thead className="max-md:hidden">
          <tr className="border-b border-border bg-surface-subtle">
            <th scope="col" className={th}>Contato</th>
            <th scope="col" className={`${th} w-[92px]`}>Tipo</th>
            <th scope="col" className={`${th} w-[180px]`}>Telefone</th>
            <th scope="col" className={`${th} w-[220px] lg:w-[260px]`}>Cidade/UF</th>
          </tr>
        </thead>
        <tbody className="max-md:block">
          {items.map((item) => {
            const phone = item.phones[0];
            const email = item.emails[0];
            const place = item.city ? `${item.city}${item.uf ? `/${item.uf}` : ""}` : null;
            return (
              <tr
                key={item.id}
                className="border-b border-border-subtle transition-colors last:border-0 focus-within:bg-surface-hover hover:bg-surface-hover max-md:relative max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-4 max-md:gap-y-1.5 max-md:py-3 max-md:pr-4 max-md:pl-[60px]"
              >
                <td className="px-4 py-2.5 align-middle max-md:block max-md:basis-full max-md:p-0">
                  <div className="flex min-w-0 items-center gap-3">
                    <PersonInitials name={item.name} className="max-md:absolute max-md:top-3 max-md:left-4" />
                    <div className="flex min-w-0 flex-col">
                      <Link
                        href={`/contatos/${item.id}`}
                        className="w-fit rounded-sm font-semibold text-text [overflow-wrap:anywhere] underline-offset-2 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      >
                        {item.name}
                      </Link>
                      {email ? (
                        <span
                          title={email}
                          className="truncate text-small text-text-muted max-md:overflow-visible max-md:whitespace-normal max-md:[overflow-wrap:anywhere]"
                        >
                          {email}
                        </span>
                      ) : (
                        <span className="text-small text-text-muted">Sem e-mail</span>
                      )}
                    </div>
                  </div>
                </td>
                <td className={meta}>
                  <ListTag title={TYPE_NAME[item.type]}>
                    {TYPE_LABEL[item.type]}
                    <span className="sr-only"> ({TYPE_NAME[item.type].toLowerCase()})</span>
                  </ListTag>
                </td>
                <td className={phone ? `${meta} tabular-nums` : metaMissing}>
                  {phone ? (
                    <>
                      <Phone size={13} aria-hidden className="shrink-0 text-text-muted md:hidden" />
                      <span className="whitespace-nowrap">{formatPhoneForDisplay(phone)}</span>
                    </>
                  ) : (
                    <Missing what="Telefone" />
                  )}
                </td>
                <td className={place ? meta : metaMissing}>
                  {place ? (
                    <>
                      <MapPin size={13} aria-hidden className="shrink-0 text-text-muted md:hidden" />
                      <span className="[overflow-wrap:anywhere]">{place}</span>
                    </>
                  ) : (
                    <Missing what="Cidade" />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
