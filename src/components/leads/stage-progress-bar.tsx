import type { PipelineStageOption } from "@/modules/opportunities/queries";

export function StageProgressBar({
  stages,
  currentStageId,
}: {
  stages: PipelineStageOption[];
  currentStageId: string;
}) {
  const currentIndex = stages.findIndex((s) => s.id === currentStageId);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1">
        {stages.map((stage, i) => (
          <div
            key={stage.id}
            title={stage.name}
            className={`h-1 flex-1 rounded-full ${i <= currentIndex ? "bg-primary" : "bg-border"}`}
          />
        ))}
      </div>
      <span className="text-meta text-text-tertiary">
        Etapa {currentIndex + 1} de {stages.length}
      </span>
    </div>
  );
}
