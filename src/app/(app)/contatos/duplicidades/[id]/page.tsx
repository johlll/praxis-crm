import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { getDuplicateCandidateDetail } from "@/modules/contacts/queries";
import { MergeComparisonForm } from "@/components/contacts/merge-comparison-form";
import { describeSignal, TIER_LABEL } from "@/components/contacts/duplicate-signals";

export const metadata: Metadata = {
  title: "Comparar contatos — Praxis CRM Jurídico",
};

export default async function CompararDuplicidadePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { user } = await getShellContext();
  const candidate = await getDuplicateCandidateDetail(id);

  if (!candidate || candidate.status !== "pending") notFound();

  return (
    <>
      <Topbar title="Comparar contatos" subtitle={TIER_LABEL[candidate.tier] ?? candidate.tier} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[820px] flex-col gap-4">
          <p className="text-meta text-text-tertiary">
            Motivo da sugestão: {candidate.signals.map(describeSignal).join(" · ")}
          </p>
          <MergeComparisonForm candidate={candidate} />
        </div>
      </main>
    </>
  );
}
