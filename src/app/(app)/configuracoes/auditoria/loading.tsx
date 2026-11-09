import { LoadingState } from "@/components/feedback/loading-state";

export default function AuditoriaLoading() {
  return (
    <main className="flex-1 overflow-y-auto p-5">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
        <LoadingState rows={6} label="Carregando auditoria…" />
      </div>
    </main>
  );
}
