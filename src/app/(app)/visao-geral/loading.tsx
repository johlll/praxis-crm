import { LoadingState } from "@/components/feedback/loading-state";

export default function VisaoGeralLoading() {
  return (
    <main className="flex-1 overflow-y-auto p-5">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
        <LoadingState rows={8} label="Calculando a visão geral…" />
      </div>
    </main>
  );
}
