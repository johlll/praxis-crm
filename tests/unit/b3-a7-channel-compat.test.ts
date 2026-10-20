import { describe, expect, it, vi } from "vitest";

/**
 * B3.1 — compatibilidade com a A7. Depois da evolução de whatsapp_channels,
 * `phone_number_id` passou a aceitar nulo (canal da B3, roteado por
 * routing_key). O simulador da A7 nunca pode receber um canal da B3: a RLS
 * já o esconde, e listWhatsAppChannels() descarta qualquer linha sem
 * phone_number_id como segunda barreira.
 */

const { rows } = vi.hoisted(() => ({ rows: { value: [] as unknown[] } }));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: async () => ({ data: rows.value, error: null }),
    };
    return { from: () => chain };
  },
}));

const { listWhatsAppChannels } = await import("@/modules/conversations/queries");

describe("listWhatsAppChannels (simulador da A7)", () => {
  it("mantém os canais legados da A7 exatamente como antes", async () => {
    rows.value = [
      { id: "c1", label: "Canal QA", phone_number_id: "a7-phone", display_phone_number: "+55 11 0000-0001", is_simulator: true, status: "active" },
    ];
    await expect(listWhatsAppChannels("ws")).resolves.toEqual([
      { id: "c1", label: "Canal QA", phoneNumberId: "a7-phone", displayPhoneNumber: "+55 11 0000-0001", isSimulator: true, status: "active" },
    ]);
  });

  it("nunca oferece ao simulador um canal sem phone_number_id (canal da B3)", async () => {
    rows.value = [
      { id: "c1", label: "Legado", phone_number_id: "a7-phone", display_phone_number: "1", is_simulator: true, status: "active" },
      { id: "c2", label: "B3", phone_number_id: null, display_phone_number: "2", is_simulator: true, status: "active" },
    ];
    const result = await listWhatsAppChannels("ws");
    expect(result.map((c) => c.id)).toEqual(["c1"]);
  });
});
