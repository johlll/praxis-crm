import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { roleHasPermission, ROLES } from "@/lib/roles";
import {
  CASE_DOCUMENT_MAX_BYTES,
  cleanDocumentName,
  formatFileSize,
  mapCaseDocument,
  precheckFile,
  reviewSchema,
} from "@/modules/case-documents/schema";
import { checkUploadedContent, detectContentType } from "@/server/case-documents/content";
import { caseDocumentsUploadEnabledByServer } from "@/server/case-documents/gate";
import { downloadFileName } from "@/server/case-documents/admin/documents";
import { BLOCK_REASON_CODES, describeBlockReason } from "@/modules/privacy/retention";
import { PRIVACY_EXPORT_LIST_CATEGORIES } from "@/modules/privacy/export-format";
import { auditActionLabel } from "@/modules/audit/catalog";

/**
 * Documentos por caso (docs/decisoes/conversas-documentos-caso.md) — parte pura e contratos: conferência do
 * CONTEÚDO (não da extensão), nome só para exibição, limites, permissões, trava do servidor fechada por padrão,
 * migration (portão fechado, bucket privado, funções de escrita só service_role) e o backup preparado sem mudar o
 * que roda hoje.
 */

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").split("\r").join("");
const MIGRATION = "supabase/migrations/20261123120000_conversas_documentos_caso.sql";

const ascii = (s: string) => Uint8Array.from(Buffer.from(s, "latin1"));
const concat = (...parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));
const PDF = concat(ascii("%PDF-1.7\n% sintético\n1 0 obj << >> endobj\n"), ascii("x".repeat(200)), ascii("\n%%EOF\n"));
const PNG = concat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ascii("y".repeat(40)), Uint8Array.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]));
const JPEG = concat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), ascii("z".repeat(40)), Uint8Array.from([0xff, 0xd9]));

describe("conferência do conteúdo no servidor (não é antivírus)", () => {
  it("reconhece PDF, PNG e JPEG completos pelo conteúdo", () => {
    expect(detectContentType(PDF)).toBe("application/pdf");
    expect(detectContentType(PNG)).toBe("image/png");
    expect(detectContentType(JPEG)).toBe("image/jpeg");
  });
  it("arquivo truncado (sem a marca de fim) é recusado", () => {
    expect(detectContentType(PDF.slice(0, PDF.length - 8))).toBeNull();
    expect(detectContentType(PNG.slice(0, PNG.length - 4))).toBeNull();
    expect(detectContentType(JPEG.slice(0, JPEG.length - 1))).toBeNull();
  });
  it("HTML, script ou executável renomeado para .pdf não passa (a extensão não decide)", () => {
    expect(detectContentType(ascii("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(detectContentType(ascii("MZ\x90\x00 executável"))).toBeNull();
    expect(checkUploadedContent(ascii("<svg onload=alert(1)></svg>"), "application/pdf")).toEqual({ ok: false, code: "case_document_content_invalid" });
  });
  it("tipo declarado diferente do conteúdo: recusado", () => {
    expect(checkUploadedContent(PNG, "application/pdf")).toEqual({ ok: false, code: "case_document_content_mismatch" });
  });
  it("vazio e acima de 10 MiB: recusados", () => {
    expect(checkUploadedContent(new Uint8Array(0), "application/pdf")).toEqual({ ok: false, code: "case_document_empty" });
    const big = new Uint8Array(CASE_DOCUMENT_MAX_BYTES + 1);
    big.set(PDF.slice(0, 9));
    expect(checkUploadedContent(big, "application/pdf")).toEqual({ ok: false, code: "case_document_too_large" });
  });
  it("válido: devolve tipo, tamanho e SHA-256", () => {
    const r = checkUploadedContent(PDF, "application/pdf");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.byteSize).toBe(PDF.length);
      expect(r.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("nome só para exibição, pré-conferência e formatos", () => {
  it("tira caminho, controles e marcas de direção; nunca vazio", () => {
    expect(cleanDocumentName("C:\\fotos\\matrícula.pdf")).toBe("matrícula.pdf");
    expect(cleanDocumentName("../../etc/passwd")).toBe("passwd");
    expect(cleanDocumentName("contrato\u202efdp.exe")).toBe("contratofdp.exe");
    expect(cleanDocumentName("  a\t\nb  .pdf ")).toBe("a b .pdf");
    expect(cleanDocumentName("")).toBe("documento");
    expect(cleanDocumentName("x".repeat(400))).toHaveLength(180);
  });
  it("HTML no nome continua TEXTO (o banco e a tela não interpretam)", () => {
    expect(cleanDocumentName("<img src=x onerror=alert(1)>.pdf")).toBe("<img src=x onerror=alert(1)>.pdf");
  });
  it("pré-conferência na tela avisa cedo (o servidor confere o conteúdo de novo)", () => {
    expect(precheckFile({ name: "a.pdf", size: 10, type: "application/pdf" })).toEqual({ ok: true, type: "application/pdf" });
    expect(precheckFile({ name: "foto.JPG", size: 10, type: "" })).toEqual({ ok: true, type: "image/jpeg" });
    expect(precheckFile({ name: "a.docx", size: 10, type: "application/msword" }).ok).toBe(false);
    expect(precheckFile({ name: "a.pdf", size: 0, type: "application/pdf" }).ok).toBe(false);
    expect(precheckFile({ name: "a.pdf", size: CASE_DOCUMENT_MAX_BYTES + 1, type: "application/pdf" }).ok).toBe(false);
  });
  it("nome do arquivo baixado: o original sem acentos nem caracteres especiais (o Storage codifica duas vezes)", () => {
    expect(downloadFileName("Matrícula atualizada do imóvel.pdf")).toBe("Matricula atualizada do imovel.pdf");
    expect(downloadFileName("RG <frente>/verso\"x\".jpg")).toBe("RG _frente_verso_x_.jpg");
    expect(downloadFileName("..‮.pdf")).toBe("pdf");
    expect(downloadFileName("ççç")).toBe("ccc");
    expect(downloadFileName("日本語")).toBe("documento");
  });
  it("tamanho legível", () => {
    expect(formatFileSize(512)).toBe("512 bytes");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1,5 MB");
  });
  it("pendência exige observação; conferido não", () => {
    const base = { documentId: "d0000000-0000-4000-8000-000000000001", expectedVersion: 0 };
    expect(reviewSchema.safeParse({ ...base, status: "com_pendencia", note: "  " }).success).toBe(false);
    expect(reviewSchema.safeParse({ ...base, status: "com_pendencia", note: "falta a página 2" }).success).toBe(true);
    expect(reviewSchema.safeParse({ ...base, status: "conferido", note: "" }).success).toBe(true);
  });
  it("linha do banco com estrutura inesperada nunca vira documento", () => {
    expect(() => mapCaseDocument({ id: "x" })).toThrow();
    expect(() => mapCaseDocument({ id: "d1", opportunity_id: "o1", status: "pending", name: "a", content_type: "application/pdf", byte_size: 1, uploaded_at: "2026-01-01", review_status: "recebido", review_version: 0 })).toThrow();
  });
});

describe("permissões", () => {
  it("envio: owner, admin, manager, lawyer, sales; conferência e remoção: owner, admin, manager, lawyer; visualizador nada", () => {
    const by = (p: Parameters<typeof roleHasPermission>[1]) => ROLES.filter((r) => roleHasPermission(r, p));
    expect(by("case_document.upload")).toEqual(["owner", "admin", "manager", "lawyer", "sales"]);
    expect(by("case_document.review")).toEqual(["owner", "admin", "manager", "lawyer"]);
    expect(by("case_document.remove")).toEqual(["owner", "admin", "manager", "lawyer"]);
  });
});

describe("trava do recebimento no servidor: ausente = fechado", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([undefined, "", "TRUE", "1", "yes", " true", "true "])("valor %j fecha", (v) => {
    if (v === undefined) vi.stubEnv("CASE_DOCUMENTS_UPLOAD_ENABLED", undefined as unknown as string);
    else vi.stubEnv("CASE_DOCUMENTS_UPLOAD_ENABLED", v);
    expect(caseDocumentsUploadEnabledByServer()).toBe(false);
  });
  it('só exatamente "true" abre (e o banco ainda tem o portão dele)', () => {
    vi.stubEnv("CASE_DOCUMENTS_UPLOAD_ENABLED", "true");
    expect(caseDocumentsUploadEnabledByServer()).toBe(true);
  });
});

describe("privacidade e auditoria", () => {
  it("bloqueio de anonimização conhecido pela tela, com texto claro", () => {
    expect(BLOCK_REASON_CODES).toContain("case_document_present");
    expect(describeBlockReason("case_document_present", null)).toMatch(/remova os documentos/);
  });
  it("exportação exige a seção de metadados dos documentos", () => {
    expect(PRIVACY_EXPORT_LIST_CATEGORIES).toContain("case_documents");
  });
  it("as cinco ações novas têm rótulo", () => {
    for (const a of ["case_document.uploaded", "case_document.upload_failed", "case_document.reviewed", "case_document.removal_requested", "case_document.removed"]) {
      expect(auditActionLabel(a)).not.toBe(a);
    }
  });
});

describe("contrato da migration", () => {
  const sql = read(MIGRATION);
  const code = sql.replace(/--.*$/gm, "");
  const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  it("é a última, logo depois das observações, e não carrega a da #358", () => {
    expect(migrations.at(-1)).toBe("20261123120000_conversas_documentos_caso.sql");
    expect(migrations.at(-2)).toBe("20261122120000_conversas_observacoes_caso.sql");
    expect(migrations).not.toContain("20261119120000_conversas_horario_origem.sql");
    expect(code).not.toMatch(/origin_time/);
    expect(code).not.toMatch(/^\s*lock table/im);
  });
  it("portão nasce fechado e só abre com a referência da ativação; sem exceção por escritório", () => {
    expect(code).toMatch(/insert into public\.case_document_upload_gate \(singleton, enabled\) values \(true, false\)/);
    expect(code).toMatch(/not enabled or \(backup_activation_ref is not null/);
    expect(code).not.toMatch(/case_document_upload_gate[^;]*workspace_id/);
    expect(code).not.toMatch(/d10a0000-0000-4000-8000-000000000001/); // nada do escritório demonstrativo
  });
  it("bucket privado, 10 MiB, só PDF/JPEG/PNG, sem policy de Storage", () => {
    expect(code).toMatch(/values \('case-documents', 'case-documents', false, 10485760, array\['application\/pdf', 'image\/jpeg', 'image\/png'\]\)/);
    expect(code).not.toMatch(/create policy/i);
  });
  it("funções de escrita do arquivo: EXECUTE só para service_role; begin e finalize conferem o portão", () => {
    for (const fn of ["begin_case_document", "finalize_case_document", "begin_case_document_abandon", "finalize_case_document_abandon", "begin_case_document_removal", "finalize_case_document_removal", "case_document_cleanup_claim", "case_document_cleanup_complete"]) {
      expect(code).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated;`));
      expect(code).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`));
    }
    const begin = code.slice(code.indexOf("create function public.begin_case_document("), code.indexOf("comment on function public.begin_case_document("));
    const fin = code.slice(code.indexOf("create function public.finalize_case_document("), code.indexOf("comment on function public.finalize_case_document("));
    expect(begin).toMatch(/if not private\.case_document_upload_open\(\) then\s+raise exception 'case_documents_upload_disabled'/);
    expect(fin).toMatch(/if not private\.case_document_upload_open\(\) then\s+raise exception 'case_documents_upload_disabled'/);
  });
  it("o caminho do objeto é gerado pelo banco (escritório/caso/documento), nunca pelo navegador", () => {
    expect(code).toMatch(/storage_path = workspace_id::text \|\| '\/' \|\| opportunity_id::text \|\| '\/' \|\| id::text/);
  });
  it("não toca andamento, roteiro, atendimento, etapa, automações nem integrações", () => {
    expect(code).not.toMatch(/insert into public\.(status_track_events|case_service_events|stage_transitions|automation_events|outbox|whatsapp_outbox|calendar_effect_intents)/);
    expect(code).not.toMatch(/update public\.(status_tracks|case_service_plans|opportunities|conversations)/);
  });
  it("a avaliação de anonimização recriada acrescenta só o bloqueio novo", () => {
    const c3b = read("supabase/migrations/20261113120000_c3b_retencao_anonimizacao.sql");
    const original = c3b.slice(c3b.indexOf("create function private.privacy_retention_assess("), c3b.indexOf("revoke all on function private.privacy_retention_assess"));
    const novo = sql.slice(sql.indexOf("create or replace function private.privacy_retention_assess("), sql.lastIndexOf("revoke all on function private.privacy_retention_assess"));
    const semBloqueio = novo.replace(/  -- Documentos de caso moram no Storage[\s\S]*?v_reasons := array_append\(v_reasons, 'case_document_present'\);\n  end if;\n/, "");
    expect(semBloqueio.replace("create or replace function", "create function").trim()).toBe(original.trim());
  });
});

describe("backup preparado, sem mudar o que roda hoje", () => {
  const lib = read("scripts/backup/lib-storage.sh");
  const workflow = read("docs/backup/modelo-repositorio-privado/.github/workflows/backup-diario.yml");
  it("lista FECHADA com exatamente os dois buckets; o padrão continua sendo o das propostas", () => {
    expect(lib).toMatch(/^PRAXIS_STORAGE_BUCKET="proposal-documents"$/m);
    expect(lib).toMatch(/^PRAXIS_STORAGE_BUCKETS=\("proposal-documents" "case-documents"\)$/m);
  });
  it("o workflow-modelo do backup diário não foi tocado (não escolhe o bucket novo)", () => {
    expect(workflow).not.toMatch(/case-documents|BACKUP_STORAGE_BUCKET/);
  });
  it("a restauração só aceita o pacote no MESMO bucket de origem", () => {
    expect(read("scripts/backup/restore-storage.sh")).toMatch(/jq -e --arg f "\$PRAXIS_STORAGE_FORMAT" --arg b "\$BUCKET" '/);
  });
});

describe("isolamento do cliente de serviço", () => {
  it("só o arquivo do cliente constrói service_role cru no módulo (regra de lint)", () => {
    const eslint = read("eslint.config.mjs");
    expect(eslint).toMatch(/files: \["src\/server\/case-documents\/\*\*\/\*\.\{ts,tsx\}"\]/);
    expect(eslint).toMatch(/ignores: \["src\/server\/case-documents\/admin\/supabase\.ts"\]/);
  });
  it("componente do navegador não importa nada do servidor", () => {
    const ui = read("src/components/conversations/context/case-documents.tsx");
    expect(ui.startsWith('"use client"')).toBe(true);
    expect(ui).not.toMatch(/@\/server\//);
  });
});
