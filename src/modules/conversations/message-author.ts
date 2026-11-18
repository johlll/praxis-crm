import type { Database } from "@/server/types/database";

type MessageDirection = Database["public"]["Enums"]["message_direction"];
type MessageOrigin = Database["public"]["Enums"]["whatsapp_message_origin"];
type MessageSenderClassification = Database["public"]["Enums"]["whatsapp_sender_classification"];

/**
 * Autoria exibível de uma mensagem, sem promover nada além do que o banco
 * comprovou. "automation" só com classificação automation (que o banco só
 * aceita com correlação positiva); nunca vira nome de pessoa nem "Vitória".
 */
export type MessageAuthorKind = "client" | "office_crm" | "office_phone" | "internal" | "automation" | "unidentified";

export function messageAuthorKind(
  m: { direction: MessageDirection; origin?: MessageOrigin | null; senderClassification?: MessageSenderClassification | null },
): MessageAuthorKind {
  const cls = m.senderClassification ?? null;
  if (cls === "automation") return "automation";
  if (m.origin === "inbound") return cls === "external" ? "client" : cls === "internal" ? "internal" : "unidentified";
  if (m.origin === "crm" && cls === "internal") return "office_crm";
  if (m.origin === "business_app" && cls === "internal") return "office_phone";
  return "unidentified";
}

