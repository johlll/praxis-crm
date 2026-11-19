/**
 * @vitest-environment node
 *
 * Observações por caso — docs/decisoes/conversas-observacoes-caso.md
 *
 * Regras puras (normalização, limites, pedido de página), leitura (cursor sem conversão, ausência × falha), ações
 * (permissão, parâmetros, repetição, erro legível), carga do painel (falha nunca vira "nenhuma observação"), a
 * mesma faixa de permissão no código e no banco e o contrato da migration (privacidade incluída).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));
const guard = vi.hoisted(() => ({ requirePermissionSafe: vi.fn() }));
vi.mock("@/server/authz/safe", () => guard);
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => cache);

import { addCaseNoteSchema, caseNotesPageSchema, CASE_NOTE_MAX, mapCaseNote, normalizeNoteBody } from "@/modules/case-notes/schema";
import { listCaseNotes } from "@/modules/case-notes/queries";
import { addCaseNoteAction, loadCaseNotesAction } from "@/modules/case-notes/actions";
import { loadCaseNotesView } from "@/modules/conversations/context";
import { roleHasPermission, ROLES } from "@/lib/roles";
import { toUserMessage } from "@/lib/errors";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").split("\r").join("");
const MIGRATION = "supabase/migrations/20261122120000_conversas_observacoes_caso.sql";
const OPP = "0a000000-0000-4000-8000-00000000000a";
const KEY = "4e000000-0000-4000-8000-000000000001";
const N1 = "a1000000-0000-4000-8000-000000000001";
const AT = "2026-11-18T12:00:00.123456+00:00";
const row = (id: string, at = AT) => ({ id, opportunity_id: OPP, body: "Texto", author_name: "Ana Souza", created_at: at });

beforeEach(() => {
  rpcMock.mockReset();
  cache.revalidatePath.mockReset();
  guard.requirePermissionSafe.mockReset();
  guard.requirePermissionSafe.mockResolvedValue({ ctx: { workspaceId: "10000000-0000-0000-0000-000000000001", role: "sales" } });
});

describe("regras puras", () => {
  it("normaliza como o banco: CRLF vira LF, quebras internas ficam, só as bordas saem", () => {
    expect(normalizeNoteBody("  linha 1\r\nlinha 2\n\n  linha 4  \n")).toBe("linha 1\nlinha 2\n\n  linha 4");
    expect(normalizeNoteBody("\t \n")).toBe("");
  });
  it("valida texto (1 a 4.000 depois de normalizar), caso e chave", () => {
    expect(addCaseNoteSchema.safeParse({ opportunityId: OPP, body: "  \n ", idempotencyKey: KEY }).success).toBe(false);
    expect(addCaseNoteSchema.safeParse({ opportunityId: OPP, body: "a".repeat(CASE_NOTE_MAX + 1), idempotencyKey: KEY }).success).toBe(false);
    expect(addCaseNoteSchema.safeParse({ opportunityId: OPP, body: ` ${"a".repeat(CASE_NOTE_MAX)} `, idempotencyKey: KEY }).success).toBe(true);
    expect(addCaseNoteSchema.safeParse({ opportunityId: "x", body: "ok", idempotencyKey: KEY }).success).toBe(false);
    expect(addCaseNoteSchema.safeParse({ opportunityId: OPP, body: "ok", idempotencyKey: "x" }).success).toBe(false);
    expect(caseNotesPageSchema.safeParse({ opportunityId: OPP, before: "ontem", beforeId: N1 }).success).toBe(false);
  });
  it("mapeia a observação (texto intacto, inclusive HTML, que a tela mostra como texto)", () => {
    expect(mapCaseNote({ ...row(N1), body: "<b>x</b>\nlinha" })).toEqual({
      id: N1, opportunityId: OPP, body: "<b>x</b>\nlinha", authorName: "Ana Souza", createdAt: AT,
    });
    expect(mapCaseNote({ ...row(N1), author_name: null }).authorName).toBeNull();
  });
  it("mensagens legíveis para os códigos novos", () => {
    expect(toUserMessage({ message: "case_note_body_required" })).toMatch(/Escreva a observação/);
    expect(toUserMessage({ message: "case_note_too_long" })).toMatch(/4\.000/);
    expect(toUserMessage({ message: "case_note_immutable" })).toMatch(/não mudam/);
  });
});

describe("leitura paginada no servidor", () => {
  it("primeira página com o limite pedido; cursor da próxima = última observação, sem conversão", async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ items: [row("n3"), row("n2")], has_more: true }], error: null });
    const page = await listCaseNotes(OPP, { limit: 3 });
    expect(rpcMock).toHaveBeenCalledWith("list_case_notes", { p_opportunity_id: OPP, p_limit: 3 });
    expect(page).toMatchObject({ hasMore: true, next: { before: AT, beforeId: "n2" } });
  });
  it("página seguinte leva o cursor; última página sem cursor", async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ items: [row("n1")], has_more: false }], error: null });
    const page = await listCaseNotes(OPP, { cursor: { before: AT, beforeId: "n2" } });
    expect(rpcMock).toHaveBeenCalledWith("list_case_notes", { p_opportunity_id: OPP, p_before: AT, p_before_id: "n2", p_limit: 10 });
    expect(page).toMatchObject({ hasMore: false, next: null });
  });
  it("fora do alcance é ausência (null); falha de verdade SOBE (nunca vira lista vazia)", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "opportunity_not_found" } });
    expect(await listCaseNotes(OPP)).toBeNull();
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(listCaseNotes(OPP)).rejects.toThrow();
    rpcMock.mockResolvedValueOnce({ data: [{ items: "?" }], error: null });
    await expect(listCaseNotes(OPP)).rejects.toThrow();
  });
  it("carga do painel: falha vira estado de ERRO; sem alcance vira 'indisponível'; vazio é vazio", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect(await loadCaseNotesView(OPP)).toEqual({ status: "error" });
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "insufficient_permission" } });
    expect(await loadCaseNotesView(OPP)).toEqual({ status: "unavailable" });
    rpcMock.mockResolvedValueOnce({ data: [{ items: [], has_more: false }], error: null });
    expect(await loadCaseNotesView(OPP)).toEqual({ status: "ok", page: { items: [], hasMore: false, next: null } });
    expect(rpcMock).toHaveBeenLastCalledWith("list_case_notes", { p_opportunity_id: OPP, p_limit: 3 });
  });
  it("carregar anteriores: valida, devolve a página ou um erro legível", async () => {
    expect(await loadCaseNotesAction({ opportunityId: OPP, before: "x", beforeId: N1 })).toMatchObject({ ok: false });
    expect(rpcMock).not.toHaveBeenCalled();
    rpcMock.mockResolvedValueOnce({ data: [{ items: [row(N1)], has_more: false }], error: null });
    expect(await loadCaseNotesAction({ opportunityId: OPP, before: AT, beforeId: N1 })).toMatchObject({ ok: true, page: { items: [{ id: N1 }] } });
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect(await loadCaseNotesAction({ opportunityId: OPP, before: AT, beforeId: N1 })).toEqual({ ok: false, error: "Não foi possível carregar as observações. Tente de novo." });
  });
});

describe("acrescentar", () => {
  it("confere a permissão, envia caso, texto normalizado e chave; devolve o registro e revalida", async () => {
    rpcMock.mockResolvedValueOnce({ data: { ...row(N1), body: "a\nb", replayed: false }, error: null });
    const r = await addCaseNoteAction({ opportunityId: OPP, body: "  a\r\nb  ", idempotencyKey: KEY });
    expect(guard.requirePermissionSafe).toHaveBeenCalledWith("case_note.add");
    expect(rpcMock).toHaveBeenCalledWith("add_case_note", { p_opportunity_id: OPP, p_body: "a\nb", p_idempotency_key: KEY });
    expect(r).toMatchObject({ ok: true, replayed: false, note: { id: N1, body: "a\nb" } });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/conversas", "layout");
  });
  it("resposta perdida: a repetição volta como repetição", async () => {
    rpcMock.mockResolvedValueOnce({ data: { ...row(N1), replayed: true }, error: null });
    expect(await addCaseNoteAction({ opportunityId: OPP, body: "Texto", idempotencyKey: KEY })).toMatchObject({ ok: true, replayed: true });
  });
  it("sem permissão não chama o banco; texto inválido não chama o banco; erro do banco vira mensagem", async () => {
    guard.requirePermissionSafe.mockResolvedValueOnce({ error: "Seu perfil não pode fazer isso." });
    expect(await addCaseNoteAction({ opportunityId: OPP, body: "x", idempotencyKey: KEY })).toEqual({ ok: false, error: "Seu perfil não pode fazer isso." });
    expect(await addCaseNoteAction({ opportunityId: OPP, body: "   ", idempotencyKey: KEY })).toMatchObject({ ok: false });
    expect(rpcMock).not.toHaveBeenCalled();
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "idempotency_conflict" } });
    expect(await addCaseNoteAction({ opportunityId: OPP, body: "x", idempotencyKey: KEY })).toEqual({ ok: false, error: toUserMessage({ message: "idempotency_conflict" }) });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("permissões: a mesma faixa no código e no banco", () => {
  it("case_note.add = lead_note.edit: owner, admin, manager, lawyer, sales; visualizador só lê", () => {
    const allowed = ROLES.filter((r) => roleHasPermission(r, "case_note.add"));
    expect(allowed).toEqual(ROLES.filter((r) => roleHasPermission(r, "lead_note.edit")));
    expect(allowed.sort()).toEqual(["admin", "lawyer", "manager", "owner", "sales"]);
    expect(read(MIGRATION)).toContain("v_target.o_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales')");
  });
});

describe("contrato da migration", () => {
  const sql = read(MIGRATION);
  const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  it("é a última, logo depois da publicada (20261121120000), e não carrega a da #358", () => {
    expect(migrations.at(-1)).toBe("20261122120000_conversas_observacoes_caso.sql");
    expect(migrations.at(-2)).toBe("20261121120000_conversas_painel_servico.sql");
    expect(migrations).not.toContain("20261119120000_conversas_horario_origem.sql");
    expect(sql).not.toMatch(/origin_time/);
    expect(sql).not.toMatch(/^\s*lock table/im);
  });
  it("registros acrescentados e imutáveis; nada migrado nem associado por inferência", () => {
    expect(sql).toContain("raise exception 'case_note_immutable'");
    const outside = sql.replace(/\$body\$[\s\S]*?\$body\$/g, "");
    expect(outside).not.toMatch(/insert into public\.case_notes/);
    expect(outside).not.toMatch(/(update|delete from) public\.(lead_notes|opportunities|status_tracks|conversations)/);
    expect(sql).not.toMatch(/from public\.lead_notes[\s\S]{0,200}insert into public\.case_notes/);
  });
  it("deny-all e funções privadas fechadas; públicas só para authenticated", () => {
    expect(sql).toContain("alter table public.case_notes force row level security;");
    expect(sql).toContain("revoke all on table public.case_notes from public, anon, authenticated, service_role;");
    for (const f of ["case_note_guard()", "case_note_target(uuid, uuid)", "case_note_json(public.case_notes)"]) {
      expect(sql).toContain(`revoke all on function private.${f} from public, anon, authenticated, service_role;`);
    }
    expect(sql).toContain("grant execute on function public.add_case_note(uuid, text, uuid) to authenticated;");
    expect(sql).toContain("grant execute on function public.list_case_notes(uuid, timestamptz, uuid, integer) to authenticated;");
  });
  it("não mexe em trilhas, roteiro, etapa, vínculo, mensagens nem automação; auditoria sem o texto", () => {
    const add = sql.slice(sql.indexOf("create function public.add_case_note("), sql.indexOf("comment on function public.add_case_note"));
    expect(add).not.toMatch(/status_tracks|case_service|stage_transitions|conversations|messages|automation|lead_notes/);
    expect(add).toContain("jsonb_build_object('note_id', v_note.id, 'length', char_length(v_body))");
    expect(add).not.toMatch(/'body'/);
  });
  it("exportação: seção case_notes só com id, caso e data; as anteriores ficam como estavam", () => {
    const exp = sql.slice(sql.indexOf("create or replace function private.privacy_export_payload"));
    const section = exp.slice(exp.indexOf("'case_notes'"), exp.indexOf("'conflict_checks'"));
    expect(section).toContain("'id', x.id, 'opportunity_id', x.opportunity_id, 'created_at', x.created_at");
    expect(section).not.toMatch(/x\.body|created_by|author/);
    const previous = read("supabase/migrations/20261121120000_conversas_painel_servico.sql");
    const prevFn = previous.slice(previous.indexOf("create or replace function private.privacy_export_payload"));
    const prevBody = prevFn.slice(0, prevFn.indexOf("$body$;", prevFn.indexOf("as $body$") + 9));
    const newBody = exp.slice(0, exp.indexOf("$body$;", exp.indexOf("as $body$") + 9));
    const withoutNew = newBody.replace(/ {4}-- Observações por caso[\s\S]*?\), '\[\]'::jsonb\),\n/, "");
    expect(withoutNew).toBe(prevBody);
  });
  it("anonimização: apaga as observações e a conferência final as inclui; o resto da função da C3b é igual", () => {
    const anon = sql.slice(sql.indexOf("create or replace function private.privacy_anonymize_contact"));
    expect(anon).toContain("delete from public.case_notes where workspace_id = p_workspace_id and opportunity_id = any(v_opp_ids);");
    expect(anon).toContain("or exists (select 1 from public.case_notes where workspace_id = p_workspace_id and opportunity_id = any(v_opp_ids))");
    const c3b = read("supabase/migrations/20261113120000_c3b_retencao_anonimizacao.sql");
    const orig = c3b.slice(c3b.indexOf("create function private.privacy_anonymize_contact"));
    const origBody = orig.slice(0, orig.indexOf("$body$;") + 7);
    const newBody = anon.slice(0, anon.indexOf("$body$;") + 7)
      .replace("create or replace function", "create function")
      .split("\n")
      .filter((l) => !l.includes("public.case_notes"))
      .join("\n");
    expect(newBody).toBe(origBody);
  });
});
