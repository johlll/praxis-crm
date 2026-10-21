/**
 * @vitest-environment node
 *
 * B3.2a — projeção de status fora de ordem e repetidos.
 *
 * A YCloud não garante a ordem dos webhooks; `delivered` pode chegar depois
 * de `failed` (e vice-versa), e o mesmo `delivered` pode chegar mais de uma
 * vez (guia oficial de `whatsapp.message.updated`). Regra do plano (§1.3):
 * a prova de entrega (`delivered`/`read`) prevalece sobre um `failed`
 * anterior, e nada regride de `delivered`/`read` para `failed`.
 *
 * Função pura; a B3.2d aplica a mesma regra no banco. Escritos ANTES da
 * implementação, contra a main 7b97297.
 */
import { describe, expect, it } from "vitest";

const load = () => import("@/server/whatsapp/status-projection");

type S = "accepted" | "sent" | "delivered" | "read" | "failed";

async function project(current: S | null, incoming: S) {
  const { projectWhatsAppMessageStatus } = await load();
  return projectWhatsAppMessageStatus(current, incoming);
}

async function fold(sequence: S[]) {
  const { projectWhatsAppMessageStatus } = await load();
  let current: S | null = null;
  for (const status of sequence) current = projectWhatsAppMessageStatus(current, status).status;
  return current;
}

describe("projeção de status", () => {
  it("delivered depois de failed corrige o failed", async () => {
    expect(await project("failed", "delivered")).toEqual({ status: "delivered", changed: true });
    expect(await project("failed", "read")).toEqual({ status: "read", changed: true });
  });

  it("failed depois de delivered ou read nunca regride", async () => {
    expect(await project("delivered", "failed")).toEqual({ status: "delivered", changed: false });
    expect(await project("read", "failed")).toEqual({ status: "read", changed: false });
  });

  it("failed vale sobre accepted e sent", async () => {
    expect(await project("accepted", "failed")).toEqual({ status: "failed", changed: true });
    expect(await project("sent", "failed")).toEqual({ status: "failed", changed: true });
    expect(await project(null, "failed")).toEqual({ status: "failed", changed: true });
  });

  it("sent depois de failed não apaga o failed (não é prova de entrega)", async () => {
    expect(await project("failed", "sent")).toEqual({ status: "failed", changed: false });
    expect(await project("failed", "accepted")).toEqual({ status: "failed", changed: false });
  });

  it("nunca regride na ordem accepted → sent → delivered → read", async () => {
    expect(await project("read", "delivered")).toEqual({ status: "read", changed: false });
    expect(await project("delivered", "sent")).toEqual({ status: "delivered", changed: false });
    expect(await project("sent", "accepted")).toEqual({ status: "sent", changed: false });
  });

  it("repetido não muda nada", async () => {
    for (const s of ["accepted", "sent", "delivered", "read", "failed"] as const) {
      expect(await project(s, s)).toEqual({ status: s, changed: false });
    }
  });

  it("read pode chegar sem delivered (a YCloud omite o delivered implícito)", async () => {
    expect(await project("sent", "read")).toEqual({ status: "read", changed: true });
  });

  it("o resultado final não depende da ordem de chegada", async () => {
    const outcomes = new Set<S | null>();
    const all: S[][] = [
      ["sent", "failed", "delivered"],
      ["failed", "delivered", "sent"],
      ["delivered", "sent", "failed"],
      ["failed", "sent", "delivered"],
      ["delivered", "failed", "sent"],
      ["sent", "delivered", "failed"],
    ];
    for (const sequence of all) outcomes.add(await fold(sequence));
    expect([...outcomes]).toEqual(["delivered"]);
  });
});
