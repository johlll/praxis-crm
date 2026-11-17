import { ListPagination } from "@/components/lists/list-pagination";

type PaginationProps = {
  page: number;
  total: number;
  pageSize: number;
  itemCount: number;
  basePath: string;
  query?: string | undefined;
};

export function Pagination({ page, total, pageSize, itemCount, basePath, query }: PaginationProps) {
  function href(targetPage: number) {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    params.set("page", String(targetPage));
    return `${basePath}?${params.toString()}`;
  }

  return (
    <ListPagination
      page={page}
      total={total}
      pageSize={pageSize}
      itemCount={itemCount}
      noun={{ one: "contato", many: "contatos" }}
      hrefFor={href}
    />
  );
}
