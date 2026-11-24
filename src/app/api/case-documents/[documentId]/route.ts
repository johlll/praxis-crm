import { NextResponse } from "next/server";

import { requirePermissionSafe } from "@/server/authz/safe";
import { createServerSupabaseClient } from "@/server/supabase/server";
import { adminCreateDownloadUrl } from "@/server/case-documents/admin/documents";
import { uuidSchema } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Abrir (`?modo=abrir`) ou baixar (`?modo=baixar`, com o nome original) um documento de caso. Autorização por
 * SESSÃO a cada clique: quem enxerga o caso (visualizador incluído), conferido pelo banco em
 * `get_case_document_for_download` — outro escritório, fora do alcance, documento em remoção ou inexistente
 * respondem 404 (nunca 403).
 *
 * Devolve um redirecionamento para um link temporário do Storage de 60 s, gerado agora e nunca reaproveitado.
 * Limitação inerente ao mecanismo: durante esses 60 s, quem tiver o link consegue abrir o arquivo. O link é
 * servido pelo domínio do Storage, não pelo do app, e o arquivo só pode ser PDF, JPEG ou PNG (conferidos no
 * envio); o app nunca executa nem interpreta o conteúdo.
 */
export async function GET(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  if (!uuidSchema.safeParse(documentId).success) return notFound();

  const guard = await requirePermissionSafe("opportunity.view");
  if ("error" in guard) return notFound();

  const mode = new URL(request.url).searchParams.get("modo") === "baixar" ? "baixar" : "abrir";
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_case_document_for_download", { p_document_id: documentId });
  if (error || !data) return notFound();
  const info = data as { storagePath?: unknown; name?: unknown };
  if (typeof info.storagePath !== "string" || typeof info.name !== "string") return notFound();

  try {
    const url = await adminCreateDownloadUrl({ storagePath: info.storagePath, name: info.name, mode });
    return NextResponse.redirect(url, { status: 302, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  } catch {
    return NextResponse.json({ error: "download_failed" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
