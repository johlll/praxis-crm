import { describe, expect, it } from "vitest";

import {
  blindIndexesForSearch,
  decryptCpfCnpj,
  encryptCpfCnpj,
  normalizeCpfCnpj,
} from "@/server/crypto/contact-sensitive";

const WS_A = "10000000-0000-0000-0000-000000000001";
const WS_B = "10000000-0000-0000-0000-000000000002";

describe("normalizeCpfCnpj", () => {
  it("mantém só dígitos", () => {
    expect(normalizeCpfCnpj("111.222.333-44")).toBe("11122233344");
  });
});

describe("encryptCpfCnpj / decryptCpfCnpj", () => {
  it("cifra e decifra de volta para o mesmo valor normalizado", () => {
    const encrypted = encryptCpfCnpj(WS_A, "111.222.333-44");
    const decrypted = decryptCpfCnpj(encrypted.ciphertextBase64, encrypted.keyVersion);
    expect(decrypted).toBe("11122233344");
  });

  it("gera um ciphertext diferente a cada chamada (IV aleatório) mesmo para o mesmo valor", () => {
    const first = encryptCpfCnpj(WS_A, "111.222.333-44");
    const second = encryptCpfCnpj(WS_A, "111.222.333-44");
    expect(first.ciphertextBase64).not.toBe(second.ciphertextBase64);
  });

  it("blind index é igual para o mesmo CPF no mesmo workspace, mesmo com ciphertexts diferentes", () => {
    const first = encryptCpfCnpj(WS_A, "111.222.333-44");
    const second = encryptCpfCnpj(WS_A, "111.222.333-44");
    expect(first.blindIndexBase64).toBe(second.blindIndexBase64);
  });

  it("blind index é DIFERENTE para o mesmo CPF em workspaces diferentes — sem correlação entre escritórios", () => {
    const inA = encryptCpfCnpj(WS_A, "111.222.333-44");
    const inB = encryptCpfCnpj(WS_B, "111.222.333-44");
    expect(inA.blindIndexBase64).not.toBe(inB.blindIndexBase64);
  });

  it("decifrar com uma versão de chave desconhecida falha cedo, antes de tentar decifrar", () => {
    const encrypted = encryptCpfCnpj(WS_A, "111.222.333-44");
    expect(() => decryptCpfCnpj(encrypted.ciphertextBase64, "99")).toThrow();
  });

  it("ciphertext adulterado falha ao decifrar (GCM detecta a adulteração)", () => {
    const encrypted = encryptCpfCnpj(WS_A, "111.222.333-44");
    const bytes = Buffer.from(encrypted.ciphertextBase64, "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! + 1) % 256;
    const tampered = bytes.toString("base64");
    expect(() => decryptCpfCnpj(tampered, encrypted.keyVersion)).toThrow();
  });
});

describe("blindIndexesForSearch", () => {
  it("inclui o mesmo blind index que encryptCpfCnpj calculou para o valor equivalente", () => {
    const encrypted = encryptCpfCnpj(WS_A, "111.222.333-44");
    const candidates = blindIndexesForSearch(WS_A, "11122233344");
    expect(candidates).toContain(encrypted.blindIndexBase64);
  });

  it("busca com formatação (pontos/traço) encontra o mesmo índice que a versão só-dígitos", () => {
    const withPunctuation = blindIndexesForSearch(WS_A, "111.222.333-44");
    const digitsOnly = blindIndexesForSearch(WS_A, "11122233344");
    expect(withPunctuation).toEqual(digitsOnly);
  });
});
