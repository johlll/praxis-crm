/**
 * C3b (última correção) — contato anonimizado e o esqueleto que ele preservou são imutáveis.
 *
 * O banco é a proteção principal (pgTAP 53). Aqui, o lado da aplicação: o código fechado
 * `contact_anonymized` vira texto claro e genérico; as telas de lead e oportunidade ficam somente
 * leitura e explicam por quê; o seletor de "novo lead" não oferece contato anonimizado; a consulta
 * que decide isso não revela nada a quem não enxerga o contato.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnonymizedRecordNotice } from "@/components/contacts/anonymized-record-notice";
import { toUserMessage } from "@/lib/errors";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8").split("\r").join("");

type Result = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  contacts: { data: null, error: null } as { data: unknown; error: { message: string } | null },
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    from: (table: string) => {
      const builder: Record<string | symbol, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
                Promise.resolve(state.contacts as Result).then(res, rej);
            }
            if (prop === "maybeSingle") return async () => state.contacts as Result;
            return (...args: unknown[]) => {
              state.calls.push({ table, method: String(prop), args });
              return builder;
            };
          },
        },
      );
      return builder;
    },
  }),
}));

const { isContactAnonymized } = await import("@/modules/contacts/queries");

beforeEach(() => {
  state.contacts = { data: null, error: null };
  state.calls = [];
});
afterEach(cleanup);

describe("recusa do banco vira texto claro e genérico", () => {
  it("contact_anonymized tem mensagem própria, sem o código e sem dado nenhum", () => {
    const msg = toUserMessage({ message: "contact_anonymized" });
    expect(msg).toMatch(/contato anonimizado/);
    expect(msg).toMatch(/cadastre um contato novo/);
    expect(msg).not.toMatch(/contact_anonymized/);
    expect(msg).not.toBe(toUserMessage({ message: "qualquer coisa desconhecida" }));
  });

  it("um texto de banco que apenas contenha o código não é reaproveitado (só o código exato)", () => {
    const msg = toUserMessage({ message: 'erro: contact_anonymized em "leads" (id 123)' });
    expect(msg).toBe(toUserMessage({ message: "texto desconhecido" }));
    expect(msg).not.toMatch(/leads|123/);
  });

  it("todas as Server Actions de lead, oportunidade, atividade e proposta passam por toUserMessage", () => {
    for (const file of [
      "src/modules/leads/actions.ts",
      "src/modules/opportunities/actions.ts",
      "src/modules/activities/actions.ts",
      "src/modules/proposals/actions.ts",
    ]) {
      const source = read(file);
      expect(source, file).toContain("toUserMessage(");
      expect(source, file).not.toMatch(/error: error\.message/);
    }
  });
});

describe("aviso das telas de lead e oportunidade", () => {
  it("explica em linguagem clara, sem nome, telefone ou qualquer dado do titular", () => {
    render(<AnonymizedRecordNotice />);
    const note = screen.getByRole("note");
    expect(note.textContent).toMatch(/Contato anonimizado/);
    expect(note.textContent).toMatch(/só para consulta/);
    expect(note.textContent).toMatch(/cadastre um contato novo/);
    expect(note.textContent).not.toMatch(/\d{4,}/);
  });
});

describe("telas somente leitura", () => {
  it("o lead de contato anonimizado perde toda ação de escrita (permissões derivadas de um único ajudante)", () => {
    const page = read("src/app/(app)/leads/[id]/page.tsx");
    expect(page).toContain("const anonymized = await isContactAnonymized(lead.contactId);");
    expect(page).toContain("const may = (permission: Parameters<typeof roleHasPermission>[1]) => !anonymized && roleHasPermission(user.role, permission);");
    // Nenhuma permissão é calculada fora do ajudante: não sobra caminho que ignore o contato anonimizado.
    const direct = page.match(/roleHasPermission\(user\.role, /g) ?? [];
    expect(direct).toHaveLength(1);
    for (const permission of [
      "lead.edit",
      "opportunity.edit",
      "activity.edit",
      "calendar.connect_own",
      "proposal.edit",
      "attribution.correct",
      "continuity.issue",
      "conflict_check.edit",
      "lead_note.edit",
      "proposal_document.manage",
    ]) {
      expect(page, permission).toContain(`may("${permission}")`);
    }
    expect(page).toContain("{anonymized ? <AnonymizedRecordNotice /> : null}");
  });

  it("a oportunidade de contato anonimizado também fica somente leitura", () => {
    const page = read("src/app/(app)/oportunidades/[id]/page.tsx");
    expect(page).toContain("const lead = await getLeadDetail(opportunity.leadId);");
    expect(page).toContain("lead ? await isContactAnonymized(lead.contactId) : false");
    expect(page).toContain('const canEdit = !anonymized && roleHasPermission(user.role, "opportunity.edit");');
    expect(page).toContain('const canEditActivities = !anonymized && roleHasPermission(user.role, "activity.edit");');
    expect(page).toContain("{anonymized ? <AnonymizedRecordNotice /> : null}");
  });

  it("o seletor de novo lead não oferece contato anonimizado", () => {
    expect(read("src/modules/leads/queries.ts")).toMatch(/\.is\("merged_into_contact_id", null\)[\s\S]*\.is\("anonymized_at", null\)/);
  });

  it("a tela do contato continua escondendo a edição", () => {
    const page = read("src/app/(app)/contatos/[id]/page.tsx");
    expect(page).toContain("const anonymized = Boolean(contact.anonymizedAt);");
    expect(page).toContain("anonymized ? (");
  });
});

describe("isContactAnonymized", () => {
  it("true quando há marca; false quando não há; false sem linha (outro workspace, mesclado, inexistente)", async () => {
    state.contacts = { data: { anonymized_at: "2026-11-11T12:00:00+00:00" }, error: null };
    expect(await isContactAnonymized("c0000000-0000-0000-0000-000000000001")).toBe(true);
    state.contacts = { data: { anonymized_at: null }, error: null };
    expect(await isContactAnonymized("c0000000-0000-0000-0000-000000000001")).toBe(false);
    state.contacts = { data: null, error: null };
    expect(await isContactAnonymized("c0000000-0000-0000-0000-000000000009")).toBe(false);
  });

  it("lê só a marca (nenhum dado pessoal) e falha de leitura sobe como erro de carga, sem texto do banco", async () => {
    state.contacts = { data: { anonymized_at: null }, error: null };
    await isContactAnonymized("c0000000-0000-0000-0000-000000000001");
    expect(state.calls.find((c) => c.method === "select")?.args).toEqual(["anonymized_at"]);

    state.contacts = { data: null, error: { message: 'permission denied for table "contacts" SEGREDO' } };
    await expect(isContactAnonymized("c0000000-0000-0000-0000-000000000001")).rejects.toThrow(/Falha ao carregar o contato/);
    await expect(isContactAnonymized("c0000000-0000-0000-0000-000000000001")).rejects.not.toThrow(/SEGREDO/);
  });
});
