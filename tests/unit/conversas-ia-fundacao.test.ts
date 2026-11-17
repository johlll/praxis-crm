/**
 * @vitest-environment node
 *
 * Conversas + IA, PR 1 — fundação das trilhas de status (sem IA).
 * docs/decisoes/conversas-ia-fundacao.md
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const guardMock = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/authz/safe", () => ({
  requirePermissionSafe: (permission: string) => guardMock(permission),
}));
vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ rpc: rpcMock }),
}));

import { Constants } from "@/server/types/database";
import { roleHasPermission, type Role } from "@/lib/roles";
import { toUserMessage } from "@/lib/errors";
import { auditActionLabel } from "@/modules/audit/catalog";
import { PRIVACY_EXPORT_LIST_CATEGORIES } from "@/modules/privacy/export-format";
import { listConversationMessages, messageAuthorKind } from "@/modules/conversations/queries";
import {
  ATTENDANCE_STATUSES,
  ATTENDANCE_STATUS_LABEL,
  CASE_PROGRESS_STATUSES,
  CASE_PROGRESS_STATUS_LABEL,
  STATUS_TRACKS,
  TRACK_EDIT_PERMISSION,
  setAttendanceSchema,
  setCaseProgressSchema,
  setTrackAutomationSchema,
} from "@/modules/status-tracks/schema";
import {
  StatusTrackLoadError,
  getConversationCase,
  getStatusTrack,
  listConversationCaseOptions,
  listStatusTrackHistory,
  mapStatusTrackEvent,
  mapStatusTrackState,
} from "@/modules/status-tracks/queries";
import {
  setConversationAttendanceAction,
  setOpportunityCaseProgressAction,
  setStatusTrackAutomationAction,
} from "@/modules/status-tracks/actions";

const CONV = "c0000000-0000-4000-8000-000000000001";
const OPP = "0a000000-0000-4000-8000-000000000001";
const MSG = "e0000000-0000-4000-8000-000000000001";
const ROOT = join(import.meta.dirname, "..", "..");
const MIGRATION = readFileSync(join(ROOT, "supabase/migrations/20261117130000_conversas_ia_fundacao.sql"), "utf8").split("\r").join("");

beforeEach(() => {
  rpcMock.mockReset();
  guardMock.mockReset();
  guardMock.mockResolvedValue({ ctx: { userId: "20000000-0000-0000-0000-000000000001", workspaceId: "w" } });
});

describe("vocabulários", () => {
  it("são exatamente os enums do banco, na mesma ordem", () => {
    expect([...ATTENDANCE_STATUSES]).toEqual([...Constants.public.Enums.conversation_attendance_status]);
    expect([...CASE_PROGRESS_STATUSES]).toEqual([...Constants.public.Enums.case_progress_status]);
    expect([...STATUS_TRACKS]).toEqual([...Constants.public.Enums.status_track_kind]);
  });

  it("têm a condição explícita de não informado e rótulo para cada valor", () => {
    expect(ATTENDANCE_STATUSES[0]).toBe("nao_informado");
    expect(CASE_PROGRESS_STATUSES[0]).toBe("nao_informado");
    for (const s of ATTENDANCE_STATUSES) expect(ATTENDANCE_STATUS_LABEL[s]).toBeTruthy();
    for (const s of CASE_PROGRESS_STATUSES) expect(CASE_PROGRESS_STATUS_LABEL[s]).toBeTruthy();
    expect(CASE_PROGRESS_STATUS_LABEL.documentos_recebidos).toBe("Documentos recebidos, ainda não analisados");
  });
});

describe("validação das correções manuais", () => {
  const base = { conversationId: CONV, status: "aguardando_cliente", expectedVersion: 0 };

  it("aceita um valor real e assume evidência vazia", () => {
    const r = setAttendanceSchema.safeParse(base);
    expect(r.success && r.data.evidenceMessageIds).toEqual([]);
  });

  it("nao_informado nunca é escolha manual", () => {
    expect(setAttendanceSchema.safeParse({ ...base, status: "nao_informado" }).success).toBe(false);
    expect(setCaseProgressSchema.safeParse({ opportunityId: OPP, status: "nao_informado", expectedVersion: 0 }).success).toBe(false);
  });

  it("andamento não aceita valor da situação do atendimento e vice-versa", () => {
    expect(setCaseProgressSchema.safeParse({ opportunityId: OPP, status: "encerrado", expectedVersion: 0 }).success).toBe(false);
    expect(setAttendanceSchema.safeParse({ ...base, status: "em_analise" }).success).toBe(false);
  });

  it("versão esperada obrigatória, inteira e não negativa", () => {
    expect(setAttendanceSchema.safeParse({ ...base, expectedVersion: -1 }).success).toBe(false);
    expect(setAttendanceSchema.safeParse({ ...base, expectedVersion: 1.5 }).success).toBe(false);
    expect(setAttendanceSchema.safeParse({ conversationId: CONV, status: "novo" }).success).toBe(false);
  });

  it("evidência: até 20 ids distintos, formato de uuid", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `e0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(setAttendanceSchema.safeParse({ ...base, evidenceMessageIds: ids(20) }).success).toBe(true);
    expect(setAttendanceSchema.safeParse({ ...base, evidenceMessageIds: ids(21) }).success).toBe(false);
    expect(setAttendanceSchema.safeParse({ ...base, evidenceMessageIds: [MSG, MSG] }).success).toBe(false);
    expect(setAttendanceSchema.safeParse({ ...base, evidenceMessageIds: ["x"] }).success).toBe(false);
  });

  it("pausa: trilha conhecida e booleano explícito", () => {
    expect(setTrackAutomationSchema.safeParse({ track: "case_progress", targetId: OPP, paused: true, expectedVersion: 0 }).success).toBe(true);
    expect(setTrackAutomationSchema.safeParse({ track: "kanban", targetId: OPP, paused: true, expectedVersion: 0 }).success).toBe(false);
  });
});

describe("permissões", () => {
  const roles: Role[] = ["owner", "admin", "manager", "lawyer", "sales", "viewer"];
  const who = (p: Parameters<typeof roleHasPermission>[1]) => roles.filter((r) => roleHasPermission(r, p));

  it("situação do atendimento: quem atende; andamento jurídico: sem atendimento nem visualizador", () => {
    expect(who("conversation.attendance_edit")).toEqual(["owner", "admin", "manager", "lawyer", "sales"]);
    expect(who("case.progress_edit")).toEqual(["owner", "admin", "manager", "lawyer"]);
  });

  it("cada trilha tem a permissão própria (a de envio não é reaproveitada)", () => {
    expect(TRACK_EDIT_PERMISSION).toEqual({
      attendance: "conversation.attendance_edit",
      case_progress: "case.progress_edit",
      commercial_stage: "opportunity.edit",
    });
    expect(Object.values(TRACK_EDIT_PERMISSION)).not.toContain("conversation.send");
  });

  it("o banco repete as mesmas faixas de papel", () => {
    const attendanceFn = MIGRATION.split("create function public.set_conversation_attendance_status")[1]!.split("$body$;")[0]!;
    const progressFn = MIGRATION.split("create function public.set_opportunity_case_progress")[1]!.split("$body$;")[0]!;
    expect(attendanceFn).toContain("v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales')");
    expect(progressFn).toContain("v_role not in ('owner', 'admin', 'manager', 'lawyer')");
  });
});

describe("autoria exibível das mensagens", () => {
  const k = (origin: string | null, cls: string | null, direction: "inbound" | "outbound" = "outbound") =>
    messageAuthorKind({ direction, origin: origin as never, senderClassification: cls as never });

  it("chatbot com correlação é automação — nunca uma pessoa nem a Vitória", () => {
    expect(k("chatbot", "automation")).toBe("automation");
  });

  it("sem correlação a classificação desconhecida é preservada", () => {
    expect(k("external_api", "unresolved")).toBe("unidentified");
    expect(k("inbound", "unresolved", "inbound")).toBe("unidentified");
    expect(k(null, null)).toBe("unidentified");
  });

  it("cliente, Dr. pelo celular, equipe pelo CRM e identidade interna", () => {
    expect(k("inbound", "external", "inbound")).toBe("client");
    expect(k("business_app", "internal")).toBe("office_phone");
    expect(k("crm", "internal")).toBe("office_crm");
    expect(k("inbound", "internal", "inbound")).toBe("internal");
  });

  it("listConversationMessages devolve origem, classificação e tipo como gravados", async () => {
    rpcMock.mockResolvedValue({
      data: [{
        items: [{
          id: MSG, direction: "outbound", body_text: null, status: "delivered", status_updated_at: "t", error_reason: null,
          sent_by: null, created_at: "t", wa_message_id: null, origin: "external_api", sender_classification: "unresolved",
          content_kind: "document",
        }],
        has_more: false,
      }],
      error: null,
    });
    const page = await listConversationMessages(CONV);
    expect(page.items[0]).toMatchObject({ origin: "external_api", senderClassification: "unresolved", contentKind: "document" });
  });
});

describe("leituras", () => {
  it("estado padrão de dado legado", () => {
    const s = mapStatusTrackState({ track: "attendance", conversation_id: CONV, applicable: true, has_record: false, status: "nao_informado", version: 0, automation_paused: false });
    expect(s).toMatchObject({ status: "nao_informado", version: 0, automationPaused: false, hasRecord: false, manualDecidedAt: null });
  });

  it("ausência legítima vira null; falha operacional vira erro, nunca 'sem dado'", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "opportunity_not_found" } });
    expect(await getStatusTrack("case_progress", OPP)).toBeNull();
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "connection reset" } });
    await expect(getStatusTrack("case_progress", OPP)).rejects.toBeInstanceOf(StatusTrackLoadError);
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "timeout" } });
    await expect(listConversationCaseOptions(CONV)).rejects.toBeInstanceOf(StatusTrackLoadError);
  });

  it("histórico: evidência só por referência, contagens de oculta/removida e cursor da próxima página", async () => {
    const ev = {
      id: "e1", event: "status_changed", from_status: "nao_informado", to_status: "em_analise", from_version: 0, to_version: 1,
      actor_kind: "user", actor_user_id: "u", actor_name: "Ana", occurred_at: "2026-11-17T12:00:00Z", evidence_count: 3,
      evidence: [{ message_id: MSG, conversation_id: CONV, direction: "inbound", origin: "inbound", sender_classification: "external", content_kind: "text", created_at: "t" }],
      evidence_hidden: 1, evidence_removed: 1,
    };
    rpcMock.mockResolvedValue({ data: [{ items: [ev], has_more: true }], error: null });
    const page = await listStatusTrackHistory("case_progress", OPP, { limit: 1 });
    expect(page?.next).toEqual({ before: "2026-11-17T12:00:00Z", beforeId: "e1" });
    expect(page?.items[0]).toMatchObject({ evidenceCount: 3, evidenceHidden: 1, evidenceRemoved: 1 });
    expect(Object.keys(page!.items[0]!.evidence[0]!)).not.toContain("bodyText");
    expect(rpcMock).toHaveBeenCalledWith("list_status_track_history", { p_track: "case_progress", p_target_id: OPP, p_limit: 1 });
    expect(mapStatusTrackEvent({ ...ev, evidence: undefined }).evidence).toEqual([]);
  });

  it("caso não selecionável (outro contato, fora do alcance) vira null, sem escrever nada", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "case_not_selectable" } });
    expect(await getConversationCase(CONV, OPP)).toBeNull();
    expect(rpcMock).toHaveBeenCalledWith("get_conversation_case", { p_conversation_id: CONV, p_opportunity_id: OPP });
  });
});

describe("ações (correções humanas e pausa)", () => {
  const ok = { track_id: "t", track: "attendance", conversation_id: CONV, opportunity_id: null, status: "aguardando_cliente", version: 1, automation_paused: false, manual_decided_at: "t", event_id: "ev", replayed: false };

  it("situação do atendimento: permissão própria, argumentos e resultado", async () => {
    rpcMock.mockResolvedValue({ data: ok, error: null });
    const r = await setConversationAttendanceAction({ conversationId: CONV, status: "aguardando_cliente", expectedVersion: 0, evidenceMessageIds: [MSG] });
    expect(guardMock).toHaveBeenCalledWith("conversation.attendance_edit");
    expect(rpcMock).toHaveBeenCalledWith("set_conversation_attendance_status", {
      p_conversation_id: CONV, p_status: "aguardando_cliente", p_expected_version: 0, p_evidence_message_ids: [MSG],
    });
    expect(r).toEqual({ ok: true, result: expect.objectContaining({ version: 1, eventId: "ev", replayed: false }) });
  });

  it("andamento usa case.progress_edit e repassa a chave de idempotência", async () => {
    rpcMock.mockResolvedValue({ data: { ...ok, track: "case_progress", conversation_id: null, opportunity_id: OPP }, error: null });
    await setOpportunityCaseProgressAction({ opportunityId: OPP, status: "em_execucao", expectedVersion: 2, idempotencyKey: MSG });
    expect(guardMock).toHaveBeenCalledWith("case.progress_edit");
    expect(rpcMock.mock.calls[0]![1]).toMatchObject({ p_opportunity_id: OPP, p_idempotency_key: MSG, p_evidence_message_ids: [] });
  });

  it("sem permissão ou com dado inválido, o banco nem é chamado", async () => {
    guardMock.mockResolvedValueOnce({ error: "Você não tem permissão para isso." });
    expect(await setOpportunityCaseProgressAction({ opportunityId: OPP, status: "em_analise", expectedVersion: 0 })).toEqual({ ok: false, error: "Você não tem permissão para isso." });
    expect(await setConversationAttendanceAction({ conversationId: CONV, status: "nao_informado", expectedVersion: 0 })).toMatchObject({ ok: false });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("pausa usa a permissão de edição da própria trilha", async () => {
    rpcMock.mockResolvedValue({ data: { ...ok, automation_paused: true }, error: null });
    await setStatusTrackAutomationAction({ track: "commercial_stage", targetId: OPP, paused: true, expectedVersion: 3 });
    expect(guardMock).toHaveBeenCalledWith("opportunity.edit");
    await setStatusTrackAutomationAction({ track: "attendance", targetId: CONV, paused: false, expectedVersion: 4 });
    expect(guardMock).toHaveBeenLastCalledWith("conversation.attendance_edit");
  });

  it("erros do banco viram mensagem em português, sem detalhe técnico", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "track_conflict" } });
    const r = await setConversationAttendanceAction({ conversationId: CONV, status: "encerrado", expectedVersion: 0 });
    expect(r).toEqual({ ok: false, error: toUserMessage({ message: "track_conflict" }) });
    for (const code of ["invalid_evidence", "idempotency_conflict", "opportunity_not_won", "automation_already_paused", "case_not_selectable"]) {
      expect(toUserMessage({ message: code })).not.toBe(toUserMessage({ message: "algo_desconhecido" }));
    }
  });
});

describe("auditoria e exportação do titular", () => {
  it("as quatro ações novas têm rótulo", () => {
    for (const a of ["conversation.attendance_changed", "opportunity.case_progress_changed", "status_track.automation_paused", "status_track.automation_resumed"]) {
      expect(auditActionLabel(a)).not.toBe(a);
    }
  });

  it("a exportação exige as duas seções novas, depois das anteriores", () => {
    expect(PRIVACY_EXPORT_LIST_CATEGORIES.slice(-3)).toEqual(["custom_fields", "status_tracks", "status_track_history"]);
  });
});

describe("migration", () => {
  it("é aditiva: não apaga nada e não mexe na autoria de stage_transitions", () => {
    expect(MIGRATION).not.toMatch(/\bdrop\s+(table|column|function|type|trigger|index)\b/i);
    expect(MIGRATION).not.toMatch(/alter\s+table\s+public\.stage_transitions/i);
    expect(MIGRATION).not.toMatch(/actor_user_id\s+drop\s+not\s+null/i);
  });

  it("a exportação substituída preserva o corpo anterior da C3a byte a byte", () => {
    const c3a = readFileSync(join(ROOT, "supabase/migrations/20261112120000_c3a_exportacao_titular.sql"), "utf8").split("\r").join("");
    const original = c3a.split("create function private.privacy_export_payload(p_workspace_id uuid, p_contact_id uuid)")[1]!.split("$body$;")[0]!;
    const replaced = MIGRATION.split("create or replace function private.privacy_export_payload(p_workspace_id uuid, p_contact_id uuid)")[1]!.split("$body$;")[0]!;
    const keep = original.slice(0, original.lastIndexOf("    ), '[]'::jsonb)\n  );"));
    expect(replaced.startsWith(keep)).toBe(true);
    expect(replaced).toContain("'status_tracks'");
    expect(replaced).toContain("'status_track_history'");
    const added = replaced.slice(keep.length);
    expect(added).not.toContain("'actor_user_id'");
    expect(added).not.toContain("'idempotency_key'");
    expect(added).not.toContain("'automation_paused_by'");
  });

  it("evidência por referência, em cascata com a mensagem; sem texto copiado", () => {
    expect(MIGRATION).toMatch(/status_track_event_evidence_message_fkey[\s\S]*?references public\.messages \(workspace_id, id\) on delete cascade/);
    const history = MIGRATION.split("create function public.list_status_track_history")[1]!.split("$body$;")[0]!;
    expect(history).not.toContain("body_text");
  });

  it("nenhuma função nova envia mensagem, cria atividade ou chama o outbox", () => {
    const fns = MIGRATION.split("-- 13) Mensagens")[0]!;
    expect(fns).not.toMatch(/insert into public\.(whatsapp_outbox|activities|automation_events|messages)\b/);
  });
});
