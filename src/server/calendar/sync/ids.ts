import { createHash } from "node:crypto";

import type { CalendarEnvironment } from "@/server/calendar/environment";

/**
 * Id de evento DETERMINÍSTICO (docs/decisoes/b2-google-agenda.md §6.7).
 *
 * O Google aceita id definido pelo cliente (alfabeto base32hex: 0-9 e a-v,
 * 5 a 1024 caracteres). Derivar o id do compromisso faz uma repetição
 * (retry, duplo clique, resposta perdida) bater em `409` em vez de criar um
 * segundo evento. O ambiente entra na conta para que Preview e Production
 * nunca gerem o mesmo id. `generation` sobe só por ação explícita, quando um
 * evento cancelado no Google precisa de id novo.
 */
const ALPHABET = "0123456789abcdefghijklmnopqrstuv";

function base32hex(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function deterministicEventId(environment: CalendarEnvironment, activityId: string, generation: number): string {
  const digest = createHash("sha256").update(`praxis-event|${environment}|${activityId}|${generation}`).digest();
  return base32hex(digest).slice(0, 32);
}

export function meetRequestId(eventId: string, attempt = 1): string {
  return `praxis-meet-${eventId}-${attempt}`;
}
