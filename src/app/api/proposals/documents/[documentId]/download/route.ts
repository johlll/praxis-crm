import { NextResponse } from "next/server";

import { requirePermissionSafe } from "@/server/authz/safe";
import { createServerSupabaseClient } from "@/server/supabase/server";
import { adminCreateProposalDocumentDownloadUrl } from "@/server/proposals/admin/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Download de um PDF de proposta. Autorização por SESSÃO (não por
 * segredo, ao contrário de src/app/api/cron/**): só quem já enxerga o
 * valor exato (owner/admin/manager/lawyer) recebe a URL assinada, via
 * get_proposal_document_for_download — recurso de outro workspace, ou
 * fora do alcance de 'lawyer', responde 404 (nunca 403, convenção já
 * usada em toda a base).
 *
 * A URL assinada tem TTL curto (60s, ver
 * src/server/proposals/admin/documents.ts) e nunca é reaproveitada —
 * gerada de novo a cada clique.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;

  const guard = await requirePermissionSafe("proposal_document.manage");
  if ("error" in guard) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_proposal_document_for_download", {
    p_document_id: documentId,
  });

  if (error || !data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const storagePath = (data as unknown as { storagePath: string }).storagePath;

  try {
    const url = await adminCreateProposalDocumentDownloadUrl(storagePath);
    return NextResponse.redirect(url);
  } catch {
    return NextResponse.json({ error: "download_failed" }, { status: 503 });
  }
}
