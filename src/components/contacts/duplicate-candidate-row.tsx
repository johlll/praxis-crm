import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { DuplicateCandidateItem } from "@/modules/contacts/queries";
import { dismissDuplicateCandidateAction } from "@/modules/contacts/actions";
import { describeSignal, TIER_LABEL } from "./duplicate-signals";

const TIER_BADGE_CLASS: Record<string, string> = {
  strong: "bg-danger-bg text-danger",
  review: "bg-info-bg text-info",
  low: "bg-border text-text-tertiary",
};

export function DuplicateCandidateRow({ candidate }: { candidate: DuplicateCandidateItem }) {
  return (
    <div
      data-testid="duplicate-candidate-row"
      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-meta font-semibold ${TIER_BADGE_CLASS[candidate.tier] ?? ""}`}
          >
            {TIER_LABEL[candidate.tier] ?? candidate.tier}
          </span>
          <span className="truncate text-body font-medium text-text">
            {candidate.contactAName} × {candidate.contactBName}
          </span>
        </div>
        <p className="text-meta text-text-tertiary">{candidate.signals.map(describeSignal).join(" · ")}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <form action={dismissDuplicateCandidateAction}>
          <input type="hidden" name="candidateId" value={candidate.id} />
          <Button type="submit" variant="ghost" size="sm">
            Descartar
          </Button>
        </form>
        <Button asChild variant="secondary" size="sm">
          <Link href={`/contatos/duplicidades/${candidate.id}`}>Comparar</Link>
        </Button>
      </div>
    </div>
  );
}
