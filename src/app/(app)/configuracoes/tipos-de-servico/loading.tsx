import { LoadingState } from "@/components/feedback/loading-state";

export default function TiposDeServicoLoading() {
  return (
    <main className="flex-1 overflow-y-auto p-5">
      <div className="mx-auto flex max-w-[900px] flex-col gap-4">
        <LoadingState rows={5} label="Carregando tipos de serviço…" />
      </div>
    </main>
  );
}
