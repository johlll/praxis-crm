/**
 * @vitest-environment node
 *
 * B5 — auditoria: rótulos, lista de permissão dos detalhes e filtros da URL.
 *
 * O banco já devolve só chaves e valores de vocabulário fechado
 * (supabase/tests/database/45_b5_auditoria_e_posse.test.sql). Aqui a segunda
 * barreira: a interface repete a lista de permissão, e a query string —
 * editável à mão — nunca vira parâmetro sem validação.
 */
import { describe, expect, it } from "vitest";

import {
  AUDIT_ACTION_GROUPS,
  AUDIT_DETAIL_KEYS,
  auditActionLabel,
  auditDetailLines,
  sanitizeAuditDetails,
} from "@/modules/audit/catalog";
import {
  AUDIT_PATH,
  auditHref,
  formatAuditCursor,
  parseAuditCursor,
  parseAuditSearchParams,
  type AuditFilters,
} from "@/modules/audit/schema";

const ANA = "20000000-0000-0000-0000-000000000001";
const ID = "a1000000-0000-0000-0000-000000000001";

describe("catálogo de ações", () => {
  const codes = AUDIT_ACTION_GROUPS.flatMap((g) => g.actions.map((a) => a.code));

  it("códigos únicos, no formato que o filtro e o banco aceitam", () => {
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/);
  });

  it("inclui a ação nova e as ações da equipe", () => {
    for (const code of [
      "workspace.ownership_transferred",
      "membership.role_changed",
      "membership.removed",
      "invitation.created",
      "whatsapp.channel.send_enabled",
      "calendar.sync.access_lost",
      "whatsapp.message.send_uncertain",
    ]) {
      expect(codes).toContain(code);
    }
  });

  it("rótulo conhecido; ação sem rótulo aparece com o próprio código, nunca some", () => {
    expect(auditActionLabel("membership.role_changed")).toBe("Papel alterado");
    expect(auditActionLabel("acao.futura.sem_rotulo")).toBe("acao.futura.sem_rotulo");
    // Chaves herdadas de Object não viram rótulo.
    expect(auditActionLabel("constructor")).toBe("constructor");
    expect(auditActionLabel("__proto__")).toBe("__proto__");
  });
});

describe("sanitizeAuditDetails — lista de permissão", () => {
  it("mantém papel, ambiente e provedor de vocabulário conhecido", () => {
    expect(
      sanitizeAuditDetails({
        from_role: "viewer",
        to_role: "admin",
        role: "lawyer",
        new_owner_previous_role: "lawyer",
        previous_owner_new_role: "admin",
        environment: "preview",
        provider: "ycloud",
      }),
    ).toEqual({
      from_role: "viewer",
      to_role: "admin",
      role: "lawyer",
      new_owner_previous_role: "lawyer",
      previous_owner_new_role: "admin",
      environment: "preview",
      provider: "ycloud",
    });
  });

  it("descarta qualquer outra chave: e-mail, nome, rótulo, token, chave, telefone, texto, ids", () => {
    const out = sanitizeAuditDetails({
      role: "lawyer",
      email: "convidado@exemplo.com",
      name: "Maria Silva",
      label: "Canal do João",
      token: "tok_123",
      api_key: "sk_live_x",
      phone: "+5511999990000",
      body_text: "texto sigiloso",
      provider_message_id: "msg_ABC",
      new_owner_user_id: ANA,
      removed_user_id: ANA,
    });
    expect(out).toEqual({ role: "lawyer" });
    expect(JSON.stringify(out)).not.toMatch(/exemplo|Maria|tok_123|sk_live|5511|sigiloso|msg_ABC|2000000/);
  });

  it("descarta valor fora do vocabulário ou de tipo errado", () => {
    expect(
      sanitizeAuditDetails({
        role: "superuser",
        from_role: 5,
        to_role: { x: 1 },
        environment: "staging",
        provider: "outro",
      }),
    ).toEqual({});
  });

  it("chaves de protótipo não passam por papel, ambiente ou provedor", () => {
    expect(sanitizeAuditDetails({ role: "constructor", environment: "constructor", provider: "toString" })).toEqual({});
    expect(sanitizeAuditDetails(JSON.parse('{"__proto__": {"role": "owner"}, "environment": "__proto__"}'))).toEqual({});
  });

  it("entrada que nem é objeto vira vazio", () => {
    for (const raw of [null, undefined, "texto", 42, ["role", "owner"], true]) {
      expect(sanitizeAuditDetails(raw)).toEqual({});
    }
  });

  it("o conjunto de chaves é exatamente o do banco", () => {
    expect([...AUDIT_DETAIL_KEYS].sort()).toEqual(
      ["environment", "from_role", "new_owner_previous_role", "previous_owner_new_role", "provider", "role", "to_role"].sort(),
    );
  });
});

describe("auditDetailLines", () => {
  it("papéis, ambiente e provedor em português", () => {
    expect(
      auditDetailLines("membership.role_changed", { from_role: "viewer", to_role: "admin" }, null),
    ).toEqual([
      { label: "Papel anterior", value: "Visualizador" },
      { label: "Papel novo", value: "Administrador" },
    ]);
    expect(auditDetailLines("whatsapp.channel.created", { environment: "preview", provider: "ycloud" }, null)).toEqual([
      { label: "Ambiente", value: "Preview (testes)" },
      { label: "Provedor", value: "YCloud" },
    ]);
  });

  it("a pessoa-alvo vem primeiro, só nas duas ações que têm uma", () => {
    expect(
      auditDetailLines(
        "workspace.ownership_transferred",
        { new_owner_previous_role: "lawyer", previous_owner_new_role: "admin" },
        "Carla",
      ),
    ).toEqual([
      { label: "Novo proprietário", value: "Carla" },
      { label: "Papel anterior do novo proprietário", value: "Advogado" },
      { label: "Novo papel de quem transferiu", value: "Administrador" },
    ]);
    expect(auditDetailLines("membership.removed", { role: "viewer" }, "Elisa")).toEqual([
      { label: "Pessoa removida", value: "Elisa" },
      { label: "Papel", value: "Visualizador" },
    ]);
    // Nome de alvo numa ação que não tem alvo: ignorado.
    expect(auditDetailLines("lead.assigned", {}, "Alguém")).toEqual([]);
    expect(auditDetailLines("constructor", {}, "Alguém")).toEqual([]);
    // Ação com alvo, mas sem nome resolvido: sem linha.
    expect(auditDetailLines("membership.removed", {}, null)).toEqual([]);
  });
});

describe("parseAuditSearchParams — query string editável à mão", () => {
  it("sem nada: sem filtro, sem cursor", () => {
    expect(parseAuditSearchParams({})).toEqual({
      filters: { action: null, actorUserId: null, from: null, to: null },
      cursor: null,
      periodError: false,
    });
  });

  it("aceita filtros válidos", () => {
    const parsed = parseAuditSearchParams({
      acao: "membership.role_changed",
      pessoa: ANA.toUpperCase(),
      de: "2026-11-01",
      ate: "2026-11-09",
    });
    expect(parsed.filters).toEqual({
      action: "membership.role_changed",
      actorUserId: ANA,
      from: "2026-11-01",
      to: "2026-11-09",
    });
    expect(parsed.periodError).toBe(false);
  });

  it("valor fora do formato vira 'sem filtro', nunca erro nem repasse ao banco", () => {
    const parsed = parseAuditSearchParams({
      acao: "lead.created'; drop table audit_logs;--",
      pessoa: "nao-e-uuid",
      de: "2026-02-30",
      ate: "amanhã",
    });
    expect(parsed.filters).toEqual({ action: null, actorUserId: null, from: null, to: null });
    expect(parsed.periodError).toBe(false);
  });

  it("recusa ação em maiúsculas, com espaço, vazia ou longa demais", () => {
    for (const acao of ["Lead.Created", "lead created", "", "a".repeat(81), ".lead", "lead..created"]) {
      expect(parseAuditSearchParams({ acao }).filters.action).toBeNull();
    }
    expect(parseAuditSearchParams({ acao: "a".repeat(80) }).filters.action).toBe("a".repeat(80));
  });

  it("datas fora de 2000–2100 ou inexistentes são ignoradas", () => {
    for (const de of ["1999-12-31", "2101-01-01", "2026-13-01", "2026-00-10", "2026-4-1", "2026-11-31"]) {
      expect(parseAuditSearchParams({ de }).filters.from).toBeNull();
    }
    expect(parseAuditSearchParams({ de: "2000-01-01" }).filters.from).toBe("2000-01-01");
    expect(parseAuditSearchParams({ ate: "2100-12-31" }).filters.to).toBe("2100-12-31");
    expect(parseAuditSearchParams({ de: "2028-02-29" }).filters.from).toBe("2028-02-29");
    expect(parseAuditSearchParams({ de: "2027-02-29" }).filters.from).toBeNull();
  });

  it("período invertido: ignora o período inteiro e avisa", () => {
    const parsed = parseAuditSearchParams({ de: "2026-11-10", ate: "2026-11-01", acao: "lead.created" });
    expect(parsed.periodError).toBe(true);
    expect(parsed.filters).toEqual({ action: "lead.created", actorUserId: null, from: null, to: null });
  });

  it("parâmetro repetido: vale o primeiro", () => {
    expect(parseAuditSearchParams({ acao: ["lead.created", "lead.updated"] }).filters.action).toBe("lead.created");
    expect(parseAuditSearchParams({ acao: [] }).filters.action).toBeNull();
  });

  it("parâmetros desconhecidos (inclusive workspace) são ignorados", () => {
    const parsed = parseAuditSearchParams({
      workspace: "10000000-0000-0000-0000-000000000002",
      workspaceId: "10000000-0000-0000-0000-000000000002",
      p_workspace_id: "10000000-0000-0000-0000-000000000002",
    });
    expect(JSON.stringify(parsed)).not.toContain("10000000");
  });
});

describe("cursor", () => {
  const cursor = { createdAt: "2026-11-09T15:09:00.123456+00:00", id: ID };

  it("ida e volta, com microssegundos e fuso", () => {
    expect(parseAuditCursor(formatAuditCursor(cursor))).toEqual(cursor);
    expect(parseAuditCursor(`2026-11-09T15:09:00Z|${ID.toUpperCase()}`)).toEqual({
      createdAt: "2026-11-09T15:09:00Z",
      id: ID,
    });
    expect(parseAuditCursor(`2026-11-09T12:09:00-03:00|${ID}`)).not.toBeNull();
  });

  it("formato inválido ou data impossível: sem cursor (volta ao início)", () => {
    for (const bad of [
      null,
      "",
      "texto",
      ID,
      `2026-11-09|${ID}`,
      `2026-11-09T15:09:00+00:00`,
      `2026-11-09T15:09:00+00:00|nao-uuid`,
      `2026-13-45T25:61:61+00:00|${ID}`,
      `2026-11-09T15:09:00+00:00|${ID}|extra`,
      `2026-11-09T15:09:00.1234567+00:00|${ID}`,
    ]) {
      expect(parseAuditCursor(bad)).toBeNull();
    }
  });
});

describe("auditHref", () => {
  const filters: AuditFilters = {
    action: "membership.role_changed",
    actorUserId: ANA,
    from: "2026-11-01",
    to: "2026-11-09",
  };

  it("sem filtros: o caminho puro", () => {
    expect(auditHref({ action: null, actorUserId: null, from: null, to: null })).toBe(AUDIT_PATH);
  });

  it("preserva os filtros e carrega o cursor; o '+' do fuso é codificado e volta igual", () => {
    const cursor = { createdAt: "2026-11-09T15:09:00.123456+00:00", id: ID };
    const href = auditHref(filters, cursor);
    expect(href.startsWith(`${AUDIT_PATH}?`)).toBe(true);
    expect(href).not.toContain("+00:00");
    const query = Object.fromEntries(new URL(href, "http://x").searchParams);
    const parsed = parseAuditSearchParams(query);
    expect(parsed.filters).toEqual(filters);
    expect(parsed.cursor).toEqual(cursor);
  });
});
