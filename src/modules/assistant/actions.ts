"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { AuthzError, requireMembership, type MembershipContext } from "@/server/authz/permissions";
import { DataLoadError } from "@/server/data/load-error";
import { ROLE_LABEL, roleHasPermission } from "@/lib/roles";
import { toUserMessage } from "@/lib/errors";
import { listActivities } from "@/modules/activities/queries";
import { getDashboard } from "@/modules/dashboard/queries";
import { parseDashboardFilters } from "@/modules/dashboard/schema";
import { scheduleAutomationRun } from "@/modules/automations/run";
import { issueCardTicket, verifyCardTicket } from "@/server/assistant/card-ticket";
import { buildDiagnosis } from "./diagnosis";
import { simulatedInterpreter, type AssistantInterpreter } from "./interpreter";
import {
  ASSISTANT_OPERATIONS,
  askAssistantSchema,
  confirmRegistrationSchema,
  isAssistantOperation,
  mergeDraft,
  missingFields,
} from "./operations";
import { mapMatches, questionFor, validateRegistration } from "./registration";
import type { AssistantBlock, AssistantReply, ConfirmResult, RegistrationDraft } from "./types";

/**
 * Servidor do Assistente (docs/decisoes/assistente.md). O intérprete só PROPÕE; aqui se confere a lista de
 * operações, os parâmetros, a sessão e as permissões, e se executa pelos caminhos oficiais do CRM. O
 * escritório vem sempre da sessão, nunca da mensagem.
 */

const interpreter: AssistantInterpreter = simulatedInterpreter;
const interpreterInfo = { id: interpreter.id, simulated: interpreter.simulated };

const HELP =
  "Por enquanto eu faço duas coisas: mostro o que precisa da sua atenção hoje e cadastro uma pessoa com um caso. Experimente “O que precisa da minha atenção hoje?” ou “Cadastre Ana Ribeiro para um caso de regularização de imóvel”.";
const NOTHING_SAVED = "Nada foi gravado.";

const reply = (blocks: AssistantBlock[], pending: RegistrationDraft | null = null): AssistantReply => ({
  blocks,
  pending,
  interpreter: interpreterInfo,
});

const canRegister = (ctx: MembershipContext) =>
  ASSISTANT_OPERATIONS.propose_client_registration.permissions.every((p) => roleHasPermission(ctx.role, p));

const deniedText = (ctx: MembershipContext) =>
  `Seu perfil (${ROLE_LABEL[ctx.role]}) pode consultar o CRM, mas não cadastrar pessoas nem casos. Peça a quem tem perfil de proprietário, administrador, gestor, advogado ou atendimento.`;

async function session(): Promise<{ ctx: MembershipContext } | { blocks: AssistantBlock[] }> {
  try {
    return { ctx: await requireMembership() };
  } catch (error) {
    if (error instanceof AuthzError) return { blocks: [{ type: "denied", text: "Sua sessão não dá acesso a este escritório. Entre de novo." }] };
    if (error instanceof DataLoadError) return { blocks: [{ type: "error", text: "Não consegui confirmar sua sessão agora. Tente de novo." }] };
    throw error;
  }
}

async function legalAreasOf(workspaceId: string): Promise<string[]> {
  try {
    return (await getDashboard(workspaceId, parseDashboardFilters({}))).legalAreas;
  } catch {
    // Só serve para preferir a grafia do escritório; sem ela, vale a sugestão da interpretação.
    return [];
  }
}

async function findMatches(workspaceId: string, draft: RegistrationDraft, phone: string | null, email: string | null) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("assistant_find_contact_matches", {
    p_workspace_id: workspaceId,
    p_name: draft.name ?? "",
    ...(phone ? { p_phone: phone } : {}),
    ...(email ? { p_email: email } : {}),
  });
  if (error) throw new DataLoadError("as possíveis duplicidades do cadastro", error);
  return mapMatches(data);
}

/** Rascunho completo: procura duplicidade e, sem nenhuma, mostra o cartão para confirmar. */
async function proposalFor(ctx: MembershipContext, draft: RegistrationDraft): Promise<AssistantReply> {
  const valid = validateRegistration(ctx.workspaceId, draft);
  if (!valid.ok) {
    return reply([{ type: "text", text: `${valid.message} Corrija no cartão abaixo antes de confirmar.` }, confirmBlock(ctx, draft)]);
  }
  let matches;
  try {
    matches = await findMatches(ctx.workspaceId, draft, valid.value.phones[0]?.value_normalized ?? null, valid.value.emails[0]?.value_normalized ?? null);
  } catch {
    return reply(
      [{ type: "error", text: "Não consegui verificar se essa pessoa já está cadastrada, então não vou propor o cadastro agora. Tente de novo." }],
      draft,
    );
  }
  if (matches.length > 0) {
    return reply([
      { type: "text", text: "Antes de cadastrar: encontrei contatos que podem ser a mesma pessoa. Escolha como seguir." },
      { type: "duplicate", ...newRequest(ctx), draft, matches },
    ]);
  }
  return reply([
    { type: "text", text: "Confira os dados. Nada é gravado antes de você confirmar." },
    confirmBlock(ctx, draft),
  ]);
}

/** Chave da solicitação + comprovante que a liga à pessoa e ao escritório desta sessão. */
function newRequest(ctx: MembershipContext): { requestId: string; ticket: string } {
  const requestId = randomUUID();
  return { requestId, ticket: issueCardTicket({ userId: ctx.userId, workspaceId: ctx.workspaceId, requestId }) };
}

const confirmBlock = (ctx: MembershipContext, draft: RegistrationDraft): AssistantBlock => ({
  type: "confirm",
  ...newRequest(ctx),
  draft,
  decision: null,
});

export async function askAssistantAction(input: unknown): Promise<AssistantReply> {
  const parsed = askAssistantSchema.safeParse(input);
  if (!parsed.success) return reply([{ type: "error", text: parsed.error.issues[0]?.message ?? "Mensagem inválida." }]);
  const { text, pending } = parsed.data;

  const s = await session();
  if ("blocks" in s) return reply(s.blocks);
  const { ctx } = s;

  let proposal = interpreter.interpret(text, { pending, legalAreas: [] });
  if (proposal.operation === "propose_client_registration") {
    proposal = interpreter.interpret(text, { pending, legalAreas: await legalAreasOf(ctx.workspaceId) });
  }

  if (proposal.operation === null || !isAssistantOperation(proposal.operation)) {
    return reply([{ type: "text", text: HELP }], pending);
  }

  const operation = ASSISTANT_OPERATIONS[proposal.operation];
  const params = operation.params.safeParse(proposal.params);
  if (!params.success) return reply([{ type: "error", text: "Não entendi os dados do pedido. Tente escrever de outro jeito." }], pending);

  switch (proposal.operation) {
    case "diagnose_attention": {
      const block = await buildDiagnosis({
        overdue: () => listActivities(ctx.workspaceId, { filter: "overdue", pageSize: 5 }),
        today: () => listActivities(ctx.workspaceId, { filter: "today", pageSize: 5 }),
        attention: () => getDashboard(ctx.workspaceId, parseDashboardFilters({})),
        now: () => new Date(),
      });
      return reply([block], pending);
    }
    case "cancel_registration":
      return reply([{ type: "text", text: `Cadastro cancelado. ${NOTHING_SAVED}` }]);
    case "propose_client_registration": {
      if (!canRegister(ctx)) return reply([{ type: "denied", text: deniedText(ctx) }]);
      const draft = mergeDraft(proposal.fresh ? null : pending, params.data as RegistrationDraft);
      const missing = missingFields(draft);
      if (missing.length > 0) return reply([{ type: "question", text: questionFor(missing, draft), missing }], draft);
      return proposalFor(ctx, draft);
    }
  }
}


/** Recusas do banco: a transação foi desfeita, então é certo que nada foi gravado. */
const RPC_ERRORS: Record<string, string> = {
  assistant_request_conflict: "Esta confirmação já foi usada com outros dados. Peça o cadastro de novo para conferir.",
  contact_not_found: "O contato escolhido não está disponível neste escritório.",
  contact_already_merged: "O contato escolhido foi mesclado a outro.",
};

const STALE_WORKSPACE =
  "O escritório ativo mudou depois que este cartão foi aberto (talvez em outra aba). Para não gravar no escritório errado, este cartão foi encerrado. Nada foi gravado. Peça o cadastro de novo no escritório em que quer cadastrar.";
const STALE_SESSION = "Este cartão não pertence à sua sessão atual. Nada foi gravado. Peça o cadastro de novo.";

const UNCERTAIN =
  "Não consegui confirmar se o cadastro foi gravado: a resposta do servidor não chegou. Confirme de novo para conferir. Se ele já tiver sido gravado, eu mostro o mesmo cadastro, sem criar outro.";
const UNCHECKED =
  "Não consegui conferir se esta confirmação já tinha sido gravada, então não gravei nada agora. Confirme de novo em instantes: a repetição não cria um segundo cadastro.";

type RpcError = { message: string; code?: string | null };

/**
 * Erro com código do banco (SQLSTATE) ou do PostgREST: o servidor respondeu e a transação foi desfeita.
 * Sem código (rede caiu, tempo esgotado, resposta perdida): não dá para saber se a gravação aconteceu.
 */
const answeredByServer = (error: RpcError) => typeof error.code === "string" && error.code.trim() !== "";

type SavedRow = { contact_id?: string; lead_id?: string; contact_created?: boolean; replayed?: boolean };

/**
 * Grava o cadastro confirmado. Na ordem:
 *   1. o cartão precisa ter sido aberto por esta pessoa, neste escritório (comprovante assinado);
 *   2. sessão e permissões conferidas de novo AGORA (não na hora da proposta);
 *   3. se esta mesma confirmação, com os mesmos dados, já foi gravada, devolve aquele cadastro (resposta
 *      perdida, clique repetido) antes de qualquer conferência de duplicidade;
 *   4. grava; a chave da solicitação garante, no banco, um cadastro só, mesmo com chamadas simultâneas.
 */
export async function confirmRegistrationAction(input: unknown): Promise<ConfirmResult> {
  const parsed = confirmRegistrationSchema.safeParse(input);
  if (!parsed.success) return { outcome: "invalid", blocks: [], message: "Dados inválidos. Revise o cartão." };
  const { requestId, ticket, draft, decision } = parsed.data;

  const s = await session();
  if ("blocks" in s) return { outcome: "denied", blocks: s.blocks };
  const { ctx } = s;

  const binding = verifyCardTicket(ticket, { userId: ctx.userId, workspaceId: ctx.workspaceId, requestId });
  if (binding !== "ok") {
    return { outcome: "stale", blocks: [{ type: "denied", text: binding === "workspace_changed" ? STALE_WORKSPACE : STALE_SESSION }] };
  }

  if (!canRegister(ctx)) return { outcome: "denied", blocks: [{ type: "denied", text: deniedText(ctx) }] };

  const valid = validateRegistration(ctx.workspaceId, draft);
  if (!valid.ok) return { outcome: "invalid", blocks: [], message: valid.message };

  const existing = decision?.kind === "existing" ? decision : null;
  const contactName = existing ? existing.contactName : valid.value.name;
  const args = {
    p_workspace_id: ctx.workspaceId,
    p_request_id: requestId,
    p_name: contactName,
    p_legal_area: valid.value.legalArea,
    ...(valid.value.summary ? { p_summary: valid.value.summary } : {}),
    p_phones: existing ? [] : valid.value.phones,
    p_emails: existing ? [] : valid.value.emails,
    ...(existing ? { p_existing_contact_id: existing.contactId } : {}),
  };

  const refused = (error: RpcError): ConfirmResult => {
    if (error.message === "insufficient_permission") return { outcome: "denied", blocks: [{ type: "denied", text: deniedText(ctx) }] };
    return { outcome: "failed", blocks: [], message: `${RPC_ERRORS[error.message] ?? toUserMessage(error)} ${NOTHING_SAVED}` };
  };

  const success = (row: SavedRow): ConfirmResult | null => {
    if (!row.contact_id || !row.lead_id) return null;
    return {
      outcome: "saved",
      blocks: [
        {
          type: "success",
          contactName,
          contactHref: `/contatos/${row.contact_id}`,
          leadHref: `/leads/${row.lead_id}`,
          legalArea: valid.value.legalArea,
          contactCreated: Boolean(row.contact_created),
          replayed: Boolean(row.replayed),
        },
      ],
    };
  };

  const supabase = await createServerSupabaseClient();

  // 3. Resultado já gravado para esta solicitação e estes dados.
  const prior = await supabase.rpc("assistant_find_registration", args);
  if (prior.error) {
    if (prior.error.message === "assistant_request_unavailable" || !answeredByServer(prior.error)) {
      return { outcome: "uncertain", blocks: [], message: UNCHECKED };
    }
    return refused(prior.error);
  }
  if (prior.data) {
    return success(prior.data as SavedRow) ?? { outcome: "uncertain", blocks: [], message: UNCERTAIN };
  }

  // Sem decisão (dados corrigidos ou pessoa nova sem conferência), confere a duplicidade antes de gravar.
  if (!decision) {
    let matches;
    try {
      matches = await findMatches(ctx.workspaceId, draft, valid.value.phones[0]?.value_normalized ?? null, valid.value.emails[0]?.value_normalized ?? null);
    } catch {
      return { outcome: "failed", blocks: [], message: `Não consegui verificar duplicidades agora. ${NOTHING_SAVED} Tente de novo.` };
    }
    if (matches.length > 0) {
      return {
        outcome: "duplicate",
        blocks: [
          { type: "text", text: "Com esses dados, encontrei contatos que podem ser a mesma pessoa. Escolha como seguir." },
          { type: "duplicate", requestId, ticket, draft, matches },
        ],
      };
    }
  }

  // 4. Gravação.
  const { data, error } = await supabase.rpc("assistant_register_client", args);
  if (error) {
    if (error.message === "assistant_request_unavailable" || !answeredByServer(error)) {
      return { outcome: "uncertain", blocks: [], message: UNCERTAIN };
    }
    return refused(error);
  }

  const row = (data ?? {}) as SavedRow;
  const result = success(row);
  if (!result) return { outcome: "uncertain", blocks: [], message: UNCERTAIN };

  if (!row.replayed) {
    revalidatePath("/leads");
    revalidatePath("/contatos");
    scheduleAutomationRun(ctx.workspaceId);
  }
  return result;
}
