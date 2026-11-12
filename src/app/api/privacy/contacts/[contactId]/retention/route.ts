import { NextResponse } from "next/server";
import { z } from "zod";

import { ANONYMIZE_CONFIRMATION, HOLD_REASON_CODES } from "@/modules/privacy/retention";
import { isSameOrigin } from "@/server/privacy/same-origin";
import {
  anonymizeContact,
  createLegalHold,
  getRetentionStatus,
  releaseLegalHold,
  type RetentionResult,
} from "@/server/privacy/retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
// Formato de UUID, sem exigir versão: o banco é quem decide se o registro existe.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

// Corpo: só a ação pedida e o que ela exige. Workspace, ator e prazo NUNCA vêm do navegador.
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }),
  z.object({ action: z.literal("hold_create"), reasonCode: z.enum(HOLD_REASON_CODES) }),
  z.object({ action: z.literal("hold_release"), holdId: uuid }),
  z.object({ action: z.literal("anonymize"), confirmation: z.literal(ANONYMIZE_CONFIRMATION) }),
]);

function respond(result: RetentionResult) {
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  }
  return NextResponse.json({ status: result.status, outcome: result.outcome ?? null }, { status: 200, headers: NO_STORE });
}

/**
 * C3b — retenção, preservação legal e anonimização manual de UM contato. POST porque tem efeito.
 * Autorização por sessão e papel (owner/admin); o workspace ativo vem do contexto confiável.
 * A resposta traz só estado e códigos fechados — nunca conteúdo pessoal. Nada é logado.
 */
export async function POST(request: Request, { params }: { params: Promise<{ contactId: string }> }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const { contactId } = await params;
  const id = uuid.safeParse(contactId);
  if (!id.success) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  try {
    switch (body.action) {
      case "status":
        return respond(await getRetentionStatus(id.data));
      case "hold_create":
        return respond(await createLegalHold(id.data, body.reasonCode));
      case "hold_release":
        return respond(await releaseLegalHold(id.data, body.holdId));
      case "anonymize":
        return respond(await anonymizeContact(id.data));
    }
  } catch {
    // O orquestrador não lança; isto é só o último cinto. Sem detalhe, sem log.
    return NextResponse.json({ error: "retention_failed" }, { status: 500, headers: NO_STORE });
  }
}
