import type { NormalizedMessageStatus } from "@/server/whatsapp/provider/contract";

/**
 * Projeção do status de uma mensagem de saída diante de atualizações
 * repetidas e fora de ordem (B3.2a, docs/decisoes/b3-whatsapp-real.md §1.3).
 *
 * A YCloud não garante a ordem dos webhooks: `delivered` pode chegar depois
 * de `failed` (e vice-versa, com vários aparelhos), o mesmo `delivered` pode
 * chegar mais de uma vez, e `read` pode vir sem `delivered`. Por isso NÃO é
 * uma ordenação simples com `failed` terminal:
 *  - a prova de entrega (`delivered`/`read`) prevalece sobre um `failed`
 *    anterior;
 *  - nada regride de `delivered`/`read` para `failed`;
 *  - `accepted`/`sent` depois de `failed` não apagam o `failed`;
 *  - fora isso, só avança em accepted → sent → delivered → read.
 *
 * Pura: a B3.2d aplica a mesma regra no banco. O log guarda toda entrega.
 */

const PROGRESS: Readonly<Record<Exclude<NormalizedMessageStatus, "failed">, number>> = {
  accepted: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

function isDeliveryProof(status: NormalizedMessageStatus): boolean {
  return status === "delivered" || status === "read";
}

export function projectWhatsAppMessageStatus(
  current: NormalizedMessageStatus | null,
  incoming: NormalizedMessageStatus,
): { status: NormalizedMessageStatus; changed: boolean } {
  if (current === null) return { status: incoming, changed: true };
  if (current === incoming) return { status: current, changed: false };

  if (incoming === "failed") {
    return isDeliveryProof(current) ? { status: current, changed: false } : { status: "failed", changed: true };
  }
  if (current === "failed") {
    return isDeliveryProof(incoming) ? { status: incoming, changed: true } : { status: current, changed: false };
  }
  return PROGRESS[incoming] > PROGRESS[current] ? { status: incoming, changed: true } : { status: current, changed: false };
}
