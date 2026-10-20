import type { WhatsAppProvider, WhatsAppProviderKind } from "@/server/whatsapp/provider/contract";
import { SimulatedWhatsAppProvider } from "@/server/whatsapp/provider/simulated";

/**
 * Seleção do adaptador de WhatsApp pelo provedor GRAVADO NO CANAL (B3.1,
 * revisão da PR #42).
 *
 * A identidade vem do canal confiável; `WHATSAPP_PROVIDER` só HABILITA um
 * provedor neste ambiente. Ela nunca substitui a identidade do canal: um
 * canal YCloud nunca recebe o simulador, qualquer que seja a variável.
 *
 * FALHA FECHADA: provedor do canal desconhecido, variável ausente, vazia,
 * desconhecida ou de outro provedor → desligado. `ycloud` e `meta` são
 * reconhecidos, mas continuam sem adaptador até a etapa real (e os portões
 * P1–P9 do plano). O simulado nunca liga em Production.
 */
export type WhatsAppProviderResolution =
  | { status: "enabled"; provider: WhatsAppProvider }
  | {
      status: "disabled";
      reason:
        | "invalid_channel_provider"
        | "missing"
        | "unknown"
        | "provider_not_enabled"
        | "simulated_not_allowed_in_production"
        | "not_available"
        | "provider_mismatch";
    };

export type WhatsAppProviderEnv = Readonly<Record<string, string | undefined>>;

const KINDS: ReadonlySet<string> = new Set<WhatsAppProviderKind>(["simulated", "ycloud", "meta"]);

const ADAPTERS: Readonly<Record<WhatsAppProviderKind, (() => WhatsAppProvider) | null>> = {
  simulated: () => new SimulatedWhatsAppProvider(),
  ycloud: null,
  meta: null,
};

export function resolveWhatsAppProvider(params: {
  channelProvider: WhatsAppProviderKind;
  env?: WhatsAppProviderEnv | undefined;
}): WhatsAppProviderResolution {
  const channelProvider: string = params.channelProvider;
  const env = params.env ?? process.env;
  if (!KINDS.has(channelProvider)) return { status: "disabled", reason: "invalid_channel_provider" };

  const enabled = env.WHATSAPP_PROVIDER;
  if (enabled === undefined || enabled.trim() === "") return { status: "disabled", reason: "missing" };
  if (!KINDS.has(enabled)) return { status: "disabled", reason: "unknown" };
  if (enabled !== channelProvider) return { status: "disabled", reason: "provider_not_enabled" };

  const kind = channelProvider as WhatsAppProviderKind;
  if (kind === "simulated" && env.VERCEL_ENV === "production") {
    return { status: "disabled", reason: "simulated_not_allowed_in_production" };
  }
  const create = ADAPTERS[kind];
  if (!create) return { status: "disabled", reason: "not_available" };

  const provider = create();
  // Defesa em profundidade: o adaptador entregue é sempre do provedor do canal.
  if (provider.kind !== kind) return { status: "disabled", reason: "provider_mismatch" };
  return { status: "enabled", provider };
}
