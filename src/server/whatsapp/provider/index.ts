import type { WhatsAppProvider } from "@/server/whatsapp/provider/contract";
import { SimulatedWhatsAppProvider } from "@/server/whatsapp/provider/simulated";

/**
 * Seleção do provedor de WhatsApp por `WHATSAPP_PROVIDER` (B3.1).
 *
 * FALHA FECHADA: ausente, vazio ou desconhecido → desligado. Nesta etapa só
 * o provedor simulado existe; `ycloud` e `meta` são reconhecidos, mas
 * continuam desligados até o adaptador real (e os portões P1–P9 do plano).
 * O simulado nunca liga em Production.
 */
export type WhatsAppProviderResolution =
  | { status: "enabled"; provider: WhatsAppProvider }
  | {
      status: "disabled";
      reason: "missing" | "unknown" | "not_available" | "simulated_not_allowed_in_production";
    };

const REAL_PROVIDERS = new Set(["ycloud", "meta"]);

export type WhatsAppProviderEnv = Readonly<Record<string, string | undefined>>;

export function resolveWhatsAppProvider(env: WhatsAppProviderEnv = process.env): WhatsAppProviderResolution {
  const raw = env.WHATSAPP_PROVIDER;
  if (raw === undefined || raw.trim() === "") return { status: "disabled", reason: "missing" };

  if (raw === "simulated") {
    if (env.VERCEL_ENV === "production") {
      return { status: "disabled", reason: "simulated_not_allowed_in_production" };
    }
    return { status: "enabled", provider: new SimulatedWhatsAppProvider() };
  }
  if (REAL_PROVIDERS.has(raw)) return { status: "disabled", reason: "not_available" };
  return { status: "disabled", reason: "unknown" };
}

export function getWhatsAppProvider(env: WhatsAppProviderEnv = process.env): WhatsAppProvider | null {
  const resolution = resolveWhatsAppProvider(env);
  return resolution.status === "enabled" ? resolution.provider : null;
}
