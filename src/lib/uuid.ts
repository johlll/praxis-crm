import { z } from "zod";

/**
 * Formato de uuid sem exigir os bits de versão/variante do RFC 4122 —
 * `z.string().uuid()` do Zod valida essa versão estrita, mas os ids fixos
 * do seed (ex.: "10000000-0000-0000-0000-000000000001", escolhidos para
 * serem legíveis nos testes) não têm esses bits e seriam rejeitados como
 * "Invalid UUID" mesmo sendo ids reais de linhas reais do banco. Um uuid
 * gerado por gen_random_uuid() sempre bate com este formato mais solto
 * também — não há perda de validação real, só a exigência descartada é a
 * de versão/variante, que nunca foi o que protegia nada aqui.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const uuidSchema = z.string().regex(UUID_RE, "Invalid UUID");
