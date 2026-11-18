/**
 * @vitest-environment node
 *
 * Conversas + IA, PR 2 — interface de Conversas sobre a fundação da #356.
 * docs/decisoes/conversas-interface.md
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
import { ATTENDANCE_STATUSES, ATTENDANCE_STATUS_LABEL } from "@/modules/status-tracks/schema";
import { listConversationInbox, ConversationsLoadError, mapSendMessageResult } from "@/modules/conversations/queries";
import { messageAuthorKind } from "@/modules/conversations/message-author";
import {
  CONTENT_KIND_LABEL,
  INBOX_FILTERS,
  INBOX_FILTER_LABEL,
  INBOX_SEARCH_MAX,
  MESSAGE_AUTHOR_HINT,
  MESSAGE_AUTHOR_LABEL,
  contentKindLabel,
  dayKey,
  formatDaySeparator,
  formatListTime,
  inboxHref,
  isUuid,
  listPreview,
  mapInboxCounts,
  parseInboxParams,
  unsupportedContentNotice,
} from "@/modules/conversations/inbox";
import { resolveFocusId } from "@/modules/conversations/context";
import {
  TRACK_LABEL,
  describeTrackEvent,
  evidenceAbsenceNote,
  evidenceRefLabel,
  formatStamp,
  mergeTimeline,
  statusLabel,
  type TaggedEvent,
} from "@/modules/conversations/context-format";
import { loadStatusTrackHistoryAction, setConversationAttendanceAction } from "@/modules/status-tracks/actions";
import { trackFailure } from "@/modules/status-tracks/queries";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").split("\r").join("");
const CONV = "c0000000-0000-4000-8000-000000000001";
const OPP = "0a000000-0000-4000-8000-000000000001";
const OPP2 = "0a000000-0000-4000-8000-000000000002";

beforeEach(() => {
  rpcMock.mockReset();
  guardMock.mockReset();
  guardMock.mockResolvedValue({ ctx: { userId: "20000000-0000-0000-0000-000000000001", workspaceId: "w" } });
});

describe("estado da URL (busca, situação, página, caso, destaque)", () => {
  it("sem parâmetros, devolve os padrões", () => {
    expect(parseInboxParams({})).toEqual({ q: "", status: "all", page: 1, caso: null, sel: null });
  });

  it("limpa a busca (espaços, tamanho) e usa o primeiro valor se vier repetido", () => {
    expect(parseInboxParams({ q: "  maria   santos  " }).q).toBe("maria santos");
    expect(parseInboxParams({ q: "x".repeat(300) }).q).toHaveLength(INBOX_SEARCH_MAX);
    expect(parseInboxParams({ q: ["primeiro", "segundo"] }).q).toBe("primeiro");
  });

  it("situação inválida cai em 'all'; as válidas (inclusive não informado) passam", () => {
    expect(parseInboxParams({ situacao: "inventado" }).status).toBe("all");
    expect(parseInboxParams({ situacao: "nao_informado" }).status).toBe("nao_informado");
    expect(parseInboxParams({ situacao: "aguardando_escritorio" }).status).toBe("aguardando_escritorio");
  });

  it("página inválida ou fora do intervalo vira 1 ou o teto", () => {
    expect(parseInboxParams({ page: "abc" }).page).toBe(1);
    expect(parseInboxParams({ page: "0" }).page).toBe(1);
    expect(parseInboxParams({ page: "-4" }).page).toBe(1);
    expect(parseInboxParams({ page: "3" }).page).toBe(3);
    expect(parseInboxParams({ page: "999999999" }).page).toBe(10_000);
  });

  it("caso e destaque só valem como uuid", () => {
    expect(parseInboxParams({ caso: OPP.toUpperCase() }).caso).toBe(OPP);
    expect(parseInboxParams({ caso: "nao-e-uuid" }).caso).toBeNull();
    expect(parseInboxParams({ sel: CONV }).sel).toBe(CONV);
    expect(parseInboxParams({ sel: "'; drop table x;--" }).sel).toBeNull();
    expect(isUuid(CONV)).toBe(true);
    expect(isUuid("1234")).toBe(false);
  });

  it("os links existentes não mudam quando não há estado", () => {
    expect(inboxHref(null, {})).toBe("/conversas");
    expect(inboxHref(CONV, {})).toBe(`/conversas/${CONV}`);
  });

  it("preserva busca, situação e página; o caso só quando pedido; o destaque só na lista", () => {
    const params = { q: "maria", status: "novo" as const, page: 2, caso: OPP, sel: CONV };
    const open = inboxHref(CONV, params);
    expect(open).toBe(`/conversas/${CONV}?q=maria&situacao=novo&page=2`);
    expect(inboxHref(CONV, params, { keepCase: true })).toBe(`/conversas/${CONV}?q=maria&situacao=novo&page=2&caso=${OPP}`);
    expect(inboxHref(null, params)).toBe(`/conversas?q=maria&situacao=novo&page=2&sel=${CONV}`);
  });

  it("ida e volta: o que sai de inboxHref volta igual em parseInboxParams", () => {
    const params = { q: "usucapião & cia", status: "aguardando_cliente" as const, page: 4, caso: OPP, sel: null };
    const href = inboxHref(CONV, params, { keepCase: true });
    const sp = Object.fromEntries(new URL(href, "http://x").searchParams.entries());
    expect(parseInboxParams(sp)).toEqual(params);
  });
});

describe("filtros e contagens", () => {
  it("os filtros são 'all' + exatamente as situações do banco, e 'Não informado' é um deles", () => {
    expect(INBOX_FILTERS[0]).toBe("all");
    expect([...INBOX_FILTERS].slice(1)).toEqual([...Constants.public.Enums.conversation_attendance_status]);
    expect(INBOX_FILTER_LABEL.nao_informado).toBe("Não informado");
    expect(INBOX_FILTER_LABEL.all).toBe("Todas");
    for (const s of ATTENDANCE_STATUSES) expect(INBOX_FILTER_LABEL[s]).toBe(ATTENDANCE_STATUS_LABEL[s]);
  });

  it("não existe filtro 'Para humano' nem contador de não lidas", () => {
    expect(JSON.stringify(INBOX_FILTER_LABEL)).not.toMatch(/humano|n[ãa]o lid/i);
  });

  it("mapInboxCounts normaliza ausência, lixo e negativos", () => {
    expect(mapInboxCounts(null)).toEqual({ all: 0, nao_informado: 0, novo: 0, aguardando_escritorio: 0, aguardando_cliente: 0, encerrado: 0 });
    expect(mapInboxCounts({ all: 5, novo: "2", encerrado: -3, aguardando_cliente: "abc" })).toEqual({
      all: 5,
      nao_informado: 0,
      novo: 2,
      aguardando_escritorio: 0,
      aguardando_cliente: 0,
      encerrado: 0,
    });
  });
});

describe("listConversationInbox", () => {
  const row = {
    items: [
      {
        id: CONV,
        wa_id: "+5541999990101",
        contact_id: null,
        contact_name: "Maria",
        lead_id: null,
        legal_area: "Usucapião",
        opportunity_id: null,
        needs_link_review: false,
        last_message_at: "2026-11-18T12:00:00.123456+00:00",
        last_message_text: null,
        last_message_direction: "inbound",
        last_message_status: "delivered",
        last_message_content_kind: "audio",
        attendance_status: "aguardando_escritorio",
      },
    ],
    total_count: 41,
    status_counts: { all: 41, nao_informado: 30, novo: 5, aguardando_escritorio: 6, aguardando_cliente: 0, encerrado: 0 },
  };

  it("repassa página, filtro e busca ao servidor e devolve total e contagens do conjunto", async () => {
    rpcMock.mockResolvedValue({ data: [row], error: null });
    const page = await listConversationInbox("w1", { page: 3, status: "novo", search: "maria" });
    expect(rpcMock).toHaveBeenCalledWith("list_conversation_inbox", {
      p_workspace_id: "w1",
      p_page: 3,
      p_page_size: 20,
      p_status: "novo",
      p_search: "maria",
    });
    expect(page.total).toBe(41);
    expect(page.counts.nao_informado).toBe(30);
    expect(page.items[0]).toMatchObject({
      attendanceStatus: "aguardando_escritorio",
      lastMessageContentKind: "audio",
      lastMessageText: null,
    });
  });

  it("'all' e busca vazia não enviam parâmetros (nada de filtro)", async () => {
    rpcMock.mockResolvedValue({ data: [{ ...row, items: [] }], error: null });
    await listConversationInbox("w1", { status: "all", search: "" });
    expect(rpcMock).toHaveBeenCalledWith("list_conversation_inbox", { p_workspace_id: "w1", p_page: 1, p_page_size: 20 });
  });

  it("situação desconhecida vinda do banco aparece como não informado (nunca inventa 'novo')", async () => {
    rpcMock.mockResolvedValue({ data: [{ ...row, items: [{ ...row.items[0], attendance_status: undefined }] }], error: null });
    const page = await listConversationInbox("w1");
    expect(page.items[0]!.attendanceStatus).toBe("nao_informado");
  });

  it("falha de consulta sobe como erro de carregamento (nunca vira lista vazia)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(listConversationInbox("w1")).rejects.toBeInstanceOf(ConversationsLoadError);
    rpcMock.mockResolvedValue({ data: [], error: null });
    await expect(listConversationInbox("w1")).rejects.toBeInstanceOf(ConversationsLoadError);
  });
});

describe("prévia e hora da lista", () => {
  it("mostra o texto, com 'Você:' nas saídas", () => {
    expect(listPreview({ lastMessageText: "Olá", lastMessageContentKind: "text", lastMessageDirection: "inbound" })).toEqual({ text: "Olá", isKind: false });
    expect(listPreview({ lastMessageText: "Oi", lastMessageContentKind: "text", lastMessageDirection: "outbound" }).text).toBe("Você: Oi");
  });

  it("sem texto, mostra o tipo da mensagem (não 'sem mensagens')", () => {
    expect(listPreview({ lastMessageText: null, lastMessageContentKind: "audio", lastMessageDirection: "inbound" })).toEqual({ text: "Áudio", isKind: true });
    expect(listPreview({ lastMessageText: "  ", lastMessageContentKind: "document", lastMessageDirection: "outbound" }).text).toBe("Você: Documento");
  });

  it("sem nenhuma mensagem, diz que não há", () => {
    expect(listPreview({ lastMessageText: null, lastMessageContentKind: null, lastMessageDirection: null })).toEqual({ text: "Sem mensagens", isKind: true });
  });

  const NOW = new Date("2026-11-18T15:00:00Z"); // 12:00 em São Paulo
  it("hora relativa no fuso do escritório", () => {
    expect(formatListTime("2026-11-18T13:30:00Z", NOW)).toBe("10:30");
    expect(formatListTime("2026-11-17T20:00:00Z", NOW)).toBe("Ontem");
    // 02:30Z já é 23:30 do dia anterior em São Paulo
    expect(formatListTime("2026-11-18T02:30:00Z", NOW)).toBe("Ontem");
    expect(formatListTime("2026-11-14T15:00:00Z", NOW)).toBe("sáb");
    expect(formatListTime("2026-10-01T15:00:00Z", NOW)).toBe("01/10");
    expect(formatListTime(null, NOW)).toBe("");
    expect(formatListTime("lixo", NOW)).toBe("");
  });

  it("separador de dia e chave do dia seguem o mesmo fuso", () => {
    expect(formatDaySeparator("2026-11-18T13:30:00Z", NOW)).toBe("Hoje");
    expect(formatDaySeparator("2026-11-17T13:30:00Z", NOW)).toBe("Ontem");
    expect(formatDaySeparator("2026-11-10T13:30:00Z", NOW)).toBe("10 de novembro de 2026");
    expect(dayKey("2026-11-18T02:30:00Z")).toBe("2026-11-17");
    expect(dayKey("2026-11-18T03:30:00Z")).toBe("2026-11-18");
  });
});

describe("autoria e tipo de conteúdo — só o que foi comprovado", () => {
  it("cada autoria tem rótulo e explicação", () => {
    for (const kind of ["client", "office_crm", "office_phone", "internal", "automation", "unidentified"] as const) {
      expect(MESSAGE_AUTHOR_LABEL[kind].length).toBeGreaterThan(2);
      expect(MESSAGE_AUTHOR_HINT[kind].length).toBeGreaterThan(10);
    }
  });

  it("nunca identifica a Vitória, a IA ou uma pessoa específica da equipe", () => {
    const all = JSON.stringify([MESSAGE_AUTHOR_LABEL, MESSAGE_AUTHOR_HINT]);
    expect(all).not.toMatch(/Vit[óo]ria|Henrique|\bIA\b|rob[ôo]|bot/i);
    expect(MESSAGE_AUTHOR_LABEL.automation).toBe("Automação");
  });

  it("origem chatbot sem correlação continua não identificada; com classificação automation vira só 'automação'", () => {
    expect(messageAuthorKind({ direction: "outbound", origin: "chatbot", senderClassification: "unresolved" })).toBe("unidentified");
    expect(messageAuthorKind({ direction: "outbound", origin: "chatbot", senderClassification: "automation" })).toBe("automation");
    expect(messageAuthorKind({ direction: "outbound", origin: null, senderClassification: null })).toBe("unidentified");
    expect(messageAuthorKind({ direction: "outbound", origin: "crm", senderClassification: "internal" })).toBe("office_crm");
    expect(messageAuthorKind({ direction: "outbound", origin: "business_app", senderClassification: "internal" })).toBe("office_phone");
    expect(messageAuthorKind({ direction: "inbound", origin: "inbound", senderClassification: "external" })).toBe("client");
  });

  it("uma mensagem recém-enviada pelo CRM não vira 'não identificada' (sent_by prova a origem)", () => {
    const sent = mapSendMessageResult({
      message_id: "m1",
      duplicate_submit: false,
      content_conflict: false,
      direction: "outbound",
      body_text: "oi",
      status: "queued",
      status_updated_at: "2026-11-18T12:00:00+00:00",
      error_reason: null,
      sent_by: "20000000-0000-0000-0000-000000000001",
      created_at: "2026-11-18T12:00:00+00:00",
      wa_message_id: "w1",
    });
    expect(messageAuthorKind(sent.message)).toBe("office_crm");
    const noSender = mapSendMessageResult({
      message_id: "m2",
      duplicate_submit: false,
      content_conflict: false,
      direction: "outbound",
      body_text: "oi",
      status: "queued",
      status_updated_at: "2026-11-18T12:00:00+00:00",
      error_reason: null,
      sent_by: null,
      created_at: "2026-11-18T12:00:00+00:00",
      wa_message_id: "w2",
    });
    expect(messageAuthorKind(noSender.message)).toBe("unidentified");
  });

  it("todo tipo de conteúdo do banco tem nome, e o aviso diz que a visualização não existe aqui", () => {
    for (const k of Object.keys(CONTENT_KIND_LABEL)) expect(contentKindLabel(k).length).toBeGreaterThan(2);
    expect(unsupportedContentNotice("audio")).toBe("Áudio — visualização indisponível nesta tela");
    expect(unsupportedContentNotice("coisa-nova")).toBe("Outro conteúdo — visualização indisponível nesta tela");
    expect(unsupportedContentNotice(null)).toContain("visualização indisponível");
  });
});

describe("mensagem sem texto (mídia sem legenda)", () => {
  it("o histórico e o envio nunca devolvem texto nulo", async () => {
    rpcMock.mockResolvedValue({
      data: [{ items: [{ id: "m1", direction: "inbound", body_text: null, status: "delivered", status_updated_at: "2026-11-18T12:00:00+00:00", error_reason: null, sent_by: null, created_at: "2026-11-18T12:00:00+00:00", wa_message_id: "w", origin: "inbound", sender_classification: "external", content_kind: "audio" }], has_more: false }],
      error: null,
    });
    const { listConversationMessages } = await import("@/modules/conversations/queries");
    const page = await listConversationMessages(CONV);
    expect(page.items[0]!.bodyText).toBe("");
    expect(page.items[0]!.contentKind).toBe("audio");
  });
});

describe("caso em foco (a URL pede, o servidor valida, o vínculo persistido não muda)", () => {
  it("o pedido válido da URL vence", () => {
    expect(resolveFocusId({ optionIds: [OPP, OPP2], linkedId: OPP, validRequestedId: OPP2 })).toEqual({ id: OPP2, source: "url" });
  });

  it("sem pedido, vale o vínculo persistido da conversa", () => {
    expect(resolveFocusId({ optionIds: [OPP, OPP2], linkedId: OPP2, validRequestedId: null })).toEqual({ id: OPP2, source: "linked" });
  });

  it("sem vínculo, vale a única oportunidade do lead a que a conversa está ligada", () => {
    expect(resolveFocusId({ optionIds: [OPP, OPP2], linkedId: null, validRequestedId: null, leadOptionIds: [OPP2] })).toEqual({ id: OPP2, source: "lead" });
    // o lead com mais de uma oportunidade é ambíguo: nada é escolhido
    expect(resolveFocusId({ optionIds: [OPP, OPP2], linkedId: null, validRequestedId: null, leadOptionIds: [OPP, OPP2] })).toBeNull();
    // o vínculo persistido continua tendo prioridade sobre o lead
    expect(resolveFocusId({ optionIds: [OPP, OPP2], linkedId: OPP, validRequestedId: null, leadOptionIds: [OPP2] })).toEqual({ id: OPP, source: "linked" });
  });

  it("sem pedido nem vínculo, só o único caso é escolhido", () => {
    expect(resolveFocusId({ optionIds: [OPP], linkedId: null, validRequestedId: null })).toEqual({ id: OPP, source: "only" });
  });

  it("com vários casos e nenhum vínculo, NÃO escolhe por palpite", () => {
    expect(resolveFocusId({ optionIds: [OPP, OPP2], linkedId: null, validRequestedId: null })).toBeNull();
    expect(resolveFocusId({ optionIds: [], linkedId: null, validRequestedId: null })).toBeNull();
  });

  it("pedido que não está entre as opções é ignorado; vínculo fora das opções também", () => {
    expect(resolveFocusId({ optionIds: [OPP], linkedId: null, validRequestedId: OPP2 })).toEqual({ id: OPP, source: "only" });
    expect(resolveFocusId({ optionIds: [OPP, OPP2], linkedId: "0a000000-0000-4000-8000-000000000009", validRequestedId: null })).toBeNull();
  });
});

describe("histórico: texto montado só com códigos", () => {
  it("descreve a mudança de situação com antes e depois, inclusive 'Não informado'", () => {
    expect(describeTrackEvent("attendance", { event: "status_changed", fromStatus: "nao_informado", toStatus: "novo" })).toEqual({
      title: "Situação do atendimento alterada",
      detail: "De “Não informado” para “Novo”",
    });
    expect(describeTrackEvent("case_progress", { event: "status_changed", fromStatus: "documentos_recebidos", toStatus: "em_analise" }).detail).toBe(
      "De “Documentos recebidos, ainda não analisados” para “Em análise”",
    );
    // concordância de gênero em cada trilha
    expect(describeTrackEvent("case_progress", { event: "status_changed", fromStatus: null, toStatus: "em_analise" }).title).toBe("Andamento do caso alterado");
    expect(formatStamp("2026-11-18T15:04:59Z")).toBe("18/11/2026 12:04");
    expect(statusLabel("attendance", null)).toBe("Não informado");
    expect(statusLabel("attendance", "codigo_novo")).toBe("codigo_novo");
  });

  it("a pausa deixa claro que não afeta o bot de atendimento", () => {
    const d = describeTrackEvent("case_progress", { event: "automation_paused", fromStatus: null, toStatus: null });
    expect(d.title).toBe("Alterações automáticas de status pausadas");
    expect(d.detail).toContain("não afeta o bot de atendimento");
    expect(describeTrackEvent("attendance", { event: "automation_resumed", fromStatus: null, toStatus: null }).title).toContain("retomadas");
    expect(TRACK_LABEL.commercial_stage).toBe("Etapa comercial");
  });

  it("referência de evidência: autoria comprovada e tipo, nunca o texto", () => {
    const label = evidenceRefLabel({
      direction: "inbound",
      origin: "inbound",
      senderClassification: "external",
      contentKind: "audio",
      createdAt: "2026-11-18T15:00:00Z",
    });
    expect(label).toBe("Cliente · Áudio · 18/11, 12:00");
    expect(
      evidenceRefLabel({ direction: "outbound", origin: "chatbot", senderClassification: "unresolved", contentKind: "text", createdAt: "2026-11-18T15:00:00Z" }),
    ).toBe("Autoria não identificada · 18/11, 12:00");
  });

  it("evidência fora do alcance ou removida é só contada, sem revelar conteúdo", () => {
    expect(evidenceAbsenceNote({ evidenceHidden: 0, evidenceRemoved: 0 })).toBeNull();
    expect(evidenceAbsenceNote({ evidenceHidden: 1, evidenceRemoved: 0 })).toBe("1 referência fora do seu alcance");
    expect(evidenceAbsenceNote({ evidenceHidden: 2, evidenceRemoved: 1 })).toBe(
      "2 referências fora do seu alcance · 1 removida pela política de retenção",
    );
  });

  it("une as trilhas da mais recente para a mais antiga, desempatando pelo id", () => {
    const e = (id: string, occurredAt: string, track: TaggedEvent["track"]): TaggedEvent =>
      ({ id, occurredAt, track, targetId: "t", event: "status_changed" }) as unknown as TaggedEvent;
    const merged = mergeTimeline([
      e("a", "2026-11-18T10:00:00+00:00", "attendance"),
      e("b", "2026-11-18T12:00:00+00:00", "case_progress"),
      e("c", "2026-11-18T12:00:00+00:00", "attendance"),
    ]);
    expect(merged.map((x) => x.id)).toEqual(["c", "b", "a"]);
  });
});

describe("ações da interface", () => {
  it("conflito de versão é sinalizado (a tela oferece atualizar, nunca repete)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "track_conflict" } });
    const r = await setConversationAttendanceAction({ conversationId: CONV, status: "novo", expectedVersion: 0 });
    expect(r).toMatchObject({ ok: false, conflict: true });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("outros erros não são tratados como conflito e não vazam o código interno", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "insufficient_permission" } });
    const r = await setConversationAttendanceAction({ conversationId: CONV, status: "novo", expectedVersion: 0 });
    expect(r).toMatchObject({ ok: false });
    expect(r).not.toHaveProperty("conflict");
    expect(JSON.stringify(r)).not.toContain("insufficient_permission");
  });

  it("trackFailure só marca conflito para track_conflict", () => {
    expect(trackFailure({ message: "track_conflict" })).toMatchObject({ ok: false, conflict: true });
    expect(trackFailure({ message: "status_unchanged" })).not.toHaveProperty("conflict");
    expect(trackFailure(null)).toMatchObject({ ok: false });
  });

  it("'não informado' nunca é aceito como escolha manual", async () => {
    const r = await setConversationAttendanceAction({ conversationId: CONV, status: "nao_informado", expectedVersion: 0 });
    expect(r.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("carregar histórico mais antigo valida o cursor e devolve só a página pedida", async () => {
    const before = "2026-11-18T12:00:00.123456+00:00";
    rpcMock.mockResolvedValue({
      data: [{ items: [{ id: "e1", event: "status_changed", from_status: "novo", to_status: "encerrado", from_version: 1, to_version: 2, actor_kind: "user", actor_user_id: "u", actor_name: "Ana", occurred_at: before, evidence_count: 0, evidence: [], evidence_hidden: 0, evidence_removed: 0 }], has_more: false }],
      error: null,
    });
    const ok = await loadStatusTrackHistoryAction({ track: "attendance", targetId: CONV, before, beforeId: OPP });
    expect(ok.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("list_status_track_history", expect.objectContaining({ p_before: before, p_before_id: OPP, p_track: "attendance" }));
    for (const bad of [
      { track: "inventada", targetId: CONV, before, beforeId: OPP },
      { track: "attendance", targetId: "x", before, beforeId: OPP },
      { track: "attendance", targetId: CONV, before: "ontem", beforeId: OPP },
      { track: "attendance", targetId: CONV, before, beforeId: "y" },
    ]) {
      expect((await loadStatusTrackHistoryAction(bad)).ok).toBe(false);
    }
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("falha de leitura do histórico vira mensagem genérica", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "relation x does not exist" } });
    const r = await loadStatusTrackHistoryAction({ track: "attendance", targetId: CONV, before: "2026-11-18T12:00:00+00:00", beforeId: OPP });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("relation");
  });
});

describe("permissões na interface (a mesma matriz do servidor)", () => {
  const can = (role: Role, p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(role, p);

  it("visualizador não recebe nenhum controle de escrita", () => {
    for (const p of ["conversation.attendance_edit", "case.progress_edit", "opportunity.edit"] as const) expect(can("viewer", p)).toBe(false);
  });

  it("atendimento corrige a situação, mas não o andamento jurídico", () => {
    expect(can("sales", "conversation.attendance_edit")).toBe(true);
    expect(can("sales", "case.progress_edit")).toBe(false);
  });

  it("advogado, gerente, admin e dono corrigem os dois", () => {
    for (const role of ["lawyer", "manager", "admin", "owner"] as const) {
      expect(can(role, "conversation.attendance_edit")).toBe(true);
      expect(can(role, "case.progress_edit")).toBe(true);
    }
  });

  it("enviar mensagem não dá direito de corrigir o andamento", () => {
    for (const role of ["sales", "viewer", "lawyer", "manager", "admin", "owner"] as const) {
      if (can(role, "conversation.send") && !can(role, "case.progress_edit")) expect(role).toBe("sales");
    }
  });
});

describe("migration da caixa de entrada (20261118120000)", () => {
  const sql = read("supabase/migrations/20261118120000_conversas_interface_inbox.sql");
  const code = sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

  it("é aditiva: só cria uma função, com permissões e comentário", () => {
    expect(code).toMatch(/create function public\.list_conversation_inbox\(/);
    expect(code).not.toMatch(/\balter table\b|\bdrop\b|\binsert\b|\bupdate\b|\bdelete\b|\bcreate table\b|\bcreate or replace\b|\bcreate trigger\b/i);
  });

  it("é de leitura (stable), com search_path vazio e só authenticated executa", () => {
    expect(code).toMatch(/security definer\s+stable\s+set search_path = ''/);
    expect(code).toMatch(/revoke all on function public\.list_conversation_inbox\([^)]*\) from public;/);
    expect(code).toMatch(/grant execute on function public\.list_conversation_inbox\([^)]*\) to authenticated;/);
    expect(code).not.toMatch(/to anon/);
  });

  it("usa o mesmo alcance por papel da list_conversations e não trata % _ \\ da busca como curinga", () => {
    expect(code).toContain("private.conversation_accessible_to_role(v_role, c.lead_id, l.assigned_to, v_actor)");
    expect(code).toContain("replace(replace(replace(v_search, '\\', '\\\\'), '%', '\\%'), '_', '\\_')");
    expect(code).toContain("escape '\\'");
  });

  it("dado sem registro é 'nao_informado', nunca 'novo'", () => {
    expect(code).toContain("coalesce(st.attendance_status::text, 'nao_informado')");
  });

  it("a list_conversations antiga não foi tocada por nenhuma migration nova", () => {
    const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f >= "20261118");
    for (const f of migrations) expect(read(`supabase/migrations/${f}`)).not.toMatch(/function public\.list_conversations\(/);
  });
});

describe("tela de Conversas — promessas que ela não faz", () => {
  function sources(dir: string): Array<{ file: string; text: string }> {
    return readdirSync(join(ROOT, dir)).flatMap((name) => {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) return sources(rel);
      return /\.(ts|tsx)$/.test(name) ? [{ file: rel, text: read(rel) }] : [];
    });
  }
  const ui = [...sources("src/components/conversations"), ...sources("src/app/(app)/conversas")];

  it("não promete IA ativa, humano ativo, Vitória, 'Para humano' nem não lidas", () => {
    for (const { file, text } of ui) {
      const visible = text
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
        .join("\n");
      expect(visible, file).not.toMatch(/IA ativa|Humano ativo|Para humano|Vit[óo]ria|n[ãa]o lidas?\b/i);
    }
  });

  it("não tem botão fictício de áudio, anexo ou gravação", () => {
    for (const { file, text } of ui) {
      expect(text, file).not.toMatch(/aria-label="(Gravar|Anexar arquivo|Anexar|Enviar áudio|Emoji)/i);
      expect(text, file).not.toMatch(/lucide-react[^;]*\b(Mic|Paperclip|Smile)\b/);
    }
  });

  it("componente de cliente nunca importa valor de módulo de servidor (quebraria o navegador)", () => {
    const SERVER_ONLY = [
      "@/modules/conversations/queries",
      "@/modules/status-tracks/queries",
      "@/modules/conversations/context",
      "@/server/",
    ];
    for (const { file, text } of ui) {
      if (!/^"use client";/m.test(text.slice(0, 40))) continue;
      const imports = [...text.matchAll(/^import\s+([\s\S]*?)\s+from\s+"([^"]+)";/gm)];
      for (const [, clause, from] of imports) {
        if (!SERVER_ONLY.some((s) => (s.endsWith("/") ? from!.startsWith(s) : from === s))) continue;
        // só `import type { ... }` é permitido (some na compilação)
        expect(clause, `${file} importa valor de ${from}`).toMatch(/^type\s/);
      }
    }
  });

  it("trocar de conversa não troca a lista por esqueleto: sem loading.tsx no segmento, com um Suspense por conversa", () => {
    // loading.tsx envolveria a página inteira (lista incluída) e zeraria a rolagem dela a cada clique.
    expect(existsSync(join(ROOT, "src/app/(app)/conversas/loading.tsx"))).toBe(false);
    expect(existsSync(join(ROOT, "src/app/(app)/conversas/[id]/loading.tsx"))).toBe(false);
    const workspace = read("src/components/conversations/conversations-workspace.tsx");
    expect(workspace.match(/<Suspense key=\{conversationId\}/g)).toHaveLength(2); // mensagens e contexto
    // a existência da conversa é conferida ANTES da transmissão (404 de verdade para inexistente/fora do alcance)
    expect(workspace.indexOf("getConversation(conversationId)")).toBeLessThan(workspace.indexOf("<Suspense"));
    expect(workspace.indexOf("notFound()")).toBeGreaterThan(-1);
  });

  it("a lista lembra a rolagem (a página remonta ao trocar de conversa)", () => {
    expect(read("src/components/conversations/inbox-list.tsx")).toContain("<ScrollMemoryList");
    const memory = read("src/components/conversations/scroll-memory-list.tsx");
    expect(memory).toContain("sessionStorage");
    expect(memory).toContain('[aria-current="page"]'); // traz a conversa aberta para a área visível
  });

  it("os links da lista dão retorno imediato ao clique (useLinkStatus)", () => {
    expect(read("src/components/conversations/link-pending.tsx")).toContain("useLinkStatus");
    expect(read("src/components/conversations/inbox-list.tsx").match(/<LinkPending \/>/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("o texto de mensagem nunca é gravado como evidência: só ids são enviados", () => {
    const editor = read("src/components/conversations/context/status-editor.tsx");
    expect(editor).toContain("evidenceMessageIds: picked");
    expect(editor).not.toMatch(/evidence[A-Za-z]*:\s*[^,\n]*\.(excerpt|bodyText)/);
  });

  it("o controle de pausa diz que não mexe no bot de atendimento", () => {
    const control = read("src/components/conversations/context/automation-control.tsx");
    expect(control).toContain("Não pausa nem retoma o bot de atendimento");
  });

  it("a tela informa que a automação de status ainda não foi ativada", () => {
    expect(read("src/components/conversations/conversation-context-panel.tsx")).toContain("A automação de status ainda não foi ativada");
  });
});
