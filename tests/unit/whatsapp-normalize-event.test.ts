import { describe, expect, it } from "vitest";

import { normalizeWebhookPayload } from "@/server/whatsapp/normalize-event";
import { buildSimulatedInboundMessage, buildSimulatedStatusEvent } from "@/server/whatsapp/simulator";
import type { WhatsAppWebhookPayload } from "@/server/whatsapp/types";

/**
 * normalizeWebhookPayload() é o adaptador compartilhado entre o simulador
 * (A7) e a conexão real futura (marco B3) — testado aqui contra o formato
 * exato da Cloud API confirmado na documentação oficial (ver
 * docs/decisoes/a7-conversas.md §1), não só contra o que o próprio
 * simulador produz.
 */
describe("normalizeWebhookPayload", () => {
  it("normaliza uma mensagem de texto recebida (payload no formato real da Cloud API)", () => {
    const payload: WhatsAppWebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "102290129340398",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
                contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "16505551234" }],
                messages: [
                  {
                    from: "16505551234",
                    id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                    timestamp: "1749416383",
                    type: "text",
                    text: { body: "Does it come in another color?" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWebhookPayload(payload);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "inbound_message",
      phoneNumberId: "106540352242922",
      fromWaIdRaw: "16505551234",
      waMessageId: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
      bodyText: "Does it come in another color?",
      profileName: "Sheena Nelson",
    });
  });

  it("normaliza um evento de status (payload no formato real da Cloud API)", () => {
    const payload: WhatsAppWebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "102290129340398",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
                statuses: [
                  {
                    id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI3MTE5MjVBOTE3MDk5QUVFM0YA",
                    status: "delivered",
                    timestamp: "1750263773",
                    recipient_id: "16505551234",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWebhookPayload(payload);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "status_event", status: "delivered", errorCode: null });
  });

  it("extrai o código/mensagem de erro de um status 'failed'", () => {
    const payload = buildSimulatedStatusEvent({
      phoneNumberId: "phone-1",
      waMessageId: "wamid.1",
      status: "failed",
      recipientWaId: "5511999998888",
      errorCode: 131047,
      errorMessage: "Janela de atendimento expirada",
    });

    const [event] = normalizeWebhookPayload(payload);
    expect(event).toMatchObject({ kind: "status_event", status: "failed", errorCode: "131047" });
  });

  it("round-trip: o que o simulador constrói, o normalizador lê de volta sem perder nada", () => {
    const timestamp = new Date("2026-09-11T12:00:00.000Z");
    const payload = buildSimulatedInboundMessage({
      phoneNumberId: "phone-sim-1",
      fromWaId: "5511988887777",
      waMessageId: "wamid.sim.abc",
      bodyText: "Olá, tudo bem?",
      profileName: "Fulano",
      timestamp,
    });

    const [event] = normalizeWebhookPayload(payload);
    expect(event).toMatchObject({
      kind: "inbound_message",
      phoneNumberId: "phone-sim-1",
      fromWaIdRaw: "5511988887777",
      waMessageId: "wamid.sim.abc",
      bodyText: "Olá, tudo bem?",
      profileName: "Fulano",
    });
    expect((event as { timestamp: Date }).timestamp.getTime()).toBe(timestamp.getTime());
  });

  it("um payload pode carregar várias mensagens/status ao mesmo tempo (batch real da Meta)", () => {
    const payload: WhatsAppWebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "1", phone_number_id: "phone-1" },
                messages: [
                  { from: "551111111", id: "wamid.a", timestamp: "1000", type: "text", text: { body: "a" } },
                  { from: "551122222", id: "wamid.b", timestamp: "1001", type: "text", text: { body: "b" } },
                ],
                statuses: [
                  { id: "wamid.c", status: "sent", timestamp: "1002", recipient_id: "551133333" },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWebhookPayload(payload);
    expect(events).toHaveLength(3);
    expect(events.filter((e) => e.kind === "inbound_message")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "status_event")).toHaveLength(1);
  });
});
