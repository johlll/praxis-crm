import type { ActivityType } from "@/modules/activities/queries";
import type { LeadPriority } from "@/modules/leads/queries";

export const ACTIVITY_TYPE_LABEL: Record<ActivityType, string> = {
  call: "Ligação",
  meeting: "Reunião",
  task: "Tarefa",
  email: "E-mail",
  deadline: "Prazo",
};

export const PRIORITY_LABEL: Record<LeadPriority, string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
};
