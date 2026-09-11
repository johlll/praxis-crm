import { describe, expect, it } from "vitest";

import { mapSendMessageResult } from "@/modules/conversations/queries";

/**
 * mapSendMessageResult() traduz o jsonb cru de send_message() (RPC) para o
 * formato que a interface reconcilia com a bolha da conversa. Achado da
 * revisão pré-merge: a versão anterior fabricava a mensagem exibida a
 * partir do TEXTO LOCAL digitado (bodyText do estado do Composer) em vez do
 * que o servidor realmente persistiu — isso escondia um "falso sucesso"
 * quando a mesma client_dedupe_key era reenviada com um texto diferente do
 * já gravado. Agora send_message() sempre devolve o registro persistido de
 * verdade (texto, status, tudo), e este mapeamento nunca inventa nada.
 */
describe("mapSendMessageResult", () => {
  it("mapeia um envio novo (duplicate_submit=false, content_conflict=false)", () => {
    const result = mapSendMessageResult({
      message_id: "msg-1",
      duplicate_submit: false,
      content_conflict: false,
      direction: "outbound",
      body_text: "Olá!",
      status: "sent",
      status_updated_at: "2026-09-11T10:00:00.000Z",
      error_reason: null,
      sent_by: "user-1",
      created_at: "2026-09-11T10:00:00.000Z",
      wa_message_id: "wamid.sim.abc",
    });

    expect(result.messageId).toBe("msg-1");
    expect(result.duplicateSubmit).toBe(false);
    expect(result.contentConflict).toBe(false);
    expect(result.message.bodyText).toBe("Olá!");
    expect(result.message.status).toBe("sent");
  });

  it("reenvio com o MESMO texto (mesma client_dedupe_key): duplicate_submit=true, content_conflict=false — devolve o registro já persistido", () => {
    const result = mapSendMessageResult({
      message_id: "msg-1",
      duplicate_submit: true,
      content_conflict: false,
      direction: "outbound",
      body_text: "Olá!",
      status: "delivered",
      status_updated_at: "2026-09-11T10:05:00.000Z",
      error_reason: null,
      sent_by: "user-1",
      created_at: "2026-09-11T10:00:00.000Z",
      wa_message_id: "wamid.sim.abc",
    });

    expect(result.duplicateSubmit).toBe(true);
    expect(result.contentConflict).toBe(false);
    // status reflete o que JÁ aconteceu com a mensagem original (avançou
    // para "delivered" entre o primeiro envio e o reenvio) — nunca "sent"
    // fabricado de novo.
    expect(result.message.status).toBe("delivered");
  });

  it("mesma client_dedupe_key com texto DIFERENTE do persistido: content_conflict=true — nunca finge que o texto novo foi enviado", () => {
    const result = mapSendMessageResult({
      message_id: "msg-1",
      duplicate_submit: true,
      content_conflict: true,
      direction: "outbound",
      body_text: "Texto original já enviado",
      status: "sent",
      status_updated_at: "2026-09-11T10:00:00.000Z",
      error_reason: null,
      sent_by: "user-1",
      created_at: "2026-09-11T10:00:00.000Z",
      wa_message_id: "wamid.sim.abc",
    });

    expect(result.contentConflict).toBe(true);
    // O texto devolvido é o REALMENTE persistido — nunca o texto editado
    // que o cliente tentou enviar sob a mesma chave.
    expect(result.message.bodyText).toBe("Texto original já enviado");
  });
});
