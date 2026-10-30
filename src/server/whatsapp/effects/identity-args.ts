import { encryptWhatsAppBsuid, whatsappBsuidBlindIndexes, WhatsAppIdentityCryptoError } from "@/server/whatsapp/identity-crypto";
import type { WhatsAppInboxClaim } from "@/server/whatsapp/inbox";
import { whatsappContactIdentity } from "@/server/whatsapp/provider/contract";

/**
 * Argumentos de identidade (telefone e BSUID) comuns aos efeitos da
 * B3.2d-2b2 (docs/decisoes/b3-whatsapp-real.md §22 e §23).
 *
 * O BSUID vai ao banco só como índice cego em cada versão de chave
 * conhecida (para achar a identidade mesmo gravada numa versão anterior) e
 * texto cifrado na versão ativa, no escopo do claim (ambiente, workspace e
 * canal). O telefone nunca é derivado do BSUID. Nenhuma chave da inbox é
 * usada aqui.
 */

export type WhatsAppEffectIdentityErrorCode = "invalid_identity" | "identity_keys_not_configured";

export class WhatsAppEffectIdentityError extends Error {
  constructor(public readonly code: WhatsAppEffectIdentityErrorCode) {
    super(code);
    this.name = "WhatsAppEffectIdentityError";
  }
}

export type WhatsAppEffectIdentityArgs = {
  p_phone_e164: string | null;
  p_bsuid_lookup: Record<string, string> | null;
  p_bsuid_ciphertext: string | null;
  p_bsuid_key_version: string | null;
};

function bsuidArgs(claim: WhatsAppInboxClaim, bsuid: string | null) {
  if (bsuid === null) return { p_bsuid_lookup: null, p_bsuid_ciphertext: null, p_bsuid_key_version: null };
  const scope = { environment: claim.environment, workspaceId: claim.workspaceId, channelId: claim.channelId };
  try {
    const encrypted = encryptWhatsAppBsuid(scope, bsuid);
    const lookup = Object.fromEntries(whatsappBsuidBlindIndexes(scope, bsuid).map((i) => [i.keyVersion, i.blindIndexBase64]));
    if (lookup[encrypted.keyVersion] !== encrypted.blindIndexBase64) throw new WhatsAppEffectIdentityError("identity_keys_not_configured");
    return { p_bsuid_lookup: lookup, p_bsuid_ciphertext: encrypted.ciphertextBase64, p_bsuid_key_version: encrypted.keyVersion };
  } catch (error) {
    if (error instanceof WhatsAppIdentityCryptoError && error.code !== "not_configured" && error.code !== "unknown_key_version") {
      throw new WhatsAppEffectIdentityError("invalid_identity");
    }
    throw new WhatsAppEffectIdentityError("identity_keys_not_configured");
  }
}

/** Valida o par telefone/BSUID (falha fechada: um identificador presente e
 * malformado invalida tudo) e devolve os argumentos da RPC. */
export function whatsappEffectIdentityArgs(
  claim: WhatsAppInboxClaim,
  contact: { phoneE164: string | null; bsuid: string | null },
): WhatsAppEffectIdentityArgs {
  const identity = whatsappContactIdentity(contact);
  if (!identity || (contact.phoneE164 !== null && identity.phoneE164 === null) || (contact.bsuid !== null && identity.bsuid === null)) {
    throw new WhatsAppEffectIdentityError("invalid_identity");
  }
  return { p_phone_e164: identity.phoneE164, ...bsuidArgs(claim, identity.bsuid) };
}
