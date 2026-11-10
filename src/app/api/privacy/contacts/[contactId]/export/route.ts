import { NextResponse } from "next/server";
import { z } from "zod";

import { exportSubjectData } from "@/server/privacy/export-subject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
// Formato de UUID, sem exigir versão: o banco é quem decide se o contato existe.
const contactIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/**
 * O download tem efeito colateral (registro e auditoria), então só a PRÓPRIA origem pode
 * dispará-lo. Falha fechado: Origin ausente, malformado ou diferente = recusa. A origem
 * esperada vem da URL da própria requisição — nunca de cabeçalho que o chamador controla
 * (x-forwarded-host, host). Comparação exata: esquema + host + porta.
 */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/**
 * C3a — exportação dos dados de UM titular (contato). POST porque tem efeito
 * (registro + auditoria). Autorização por sessão e papel (owner/admin); o
 * workspace é derivado do contato no banco. Resposta: JSON como anexo,
 * `no-store`, nada salvo em lugar nenhum e nada escrito em log.
 */
export async function POST(request: Request, { params }: { params: Promise<{ contactId: string }> }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const { contactId } = await params;
  const parsed = contactIdSchema.safeParse(contactId);
  if (!parsed.success) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }

  let result: Awaited<ReturnType<typeof exportSubjectData>>;
  try {
    result = await exportSubjectData(parsed.data);
  } catch {
    // O orquestrador não lança; isto é só o último cinto. Sem detalhe, sem log.
    return NextResponse.json({ error: "export_failed" }, { status: 500, headers: NO_STORE });
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  }

  return new NextResponse(result.body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.fileName}"`,
      "X-Content-Type-Options": "nosniff",
      ...NO_STORE,
    },
  });
}
