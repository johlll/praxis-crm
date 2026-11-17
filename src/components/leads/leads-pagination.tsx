import { ListPagination } from "@/components/lists/list-pagination";

type LeadsPaginationProps = {
  page: number;
  total: number;
  pageSize: number;
  itemCount: number;
  /** searchParams crus da página — preservados na troca de página, exceto `page`. */
  currentParams: Record<string, string | undefined>;
};

export function LeadsPagination({ page, total, pageSize, itemCount, currentParams }: LeadsPaginationProps) {
  function href(targetPage: number) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(currentParams)) {
      if (key !== "page" && value) params.set(key, value);
    }
    params.set("page", String(targetPage));
    return `/leads?${params.toString()}`;
  }

  return (
    <ListPagination
      page={page}
      total={total}
      pageSize={pageSize}
      itemCount={itemCount}
      noun={{ one: "lead", many: "leads" }}
      hrefFor={href}
    />
  );
}
