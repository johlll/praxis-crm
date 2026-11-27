/**
 * Formato das respostas do Assistente (docs/decisoes/assistente.md). Só dados serializáveis: o servidor
 * monta os blocos, a tela só os desenha. Sem dependência de servidor, para os componentes importarem.
 */

/** Rascunho do cadastro de uma pessoa com um caso. Tudo opcional até a confirmação. */
export type RegistrationDraft = {
  name?: string | undefined;
  legalArea?: string | undefined;
  summary?: string | undefined;
  phone?: string | undefined;
  email?: string | undefined;
};

export type RequiredRegistrationField = "name" | "legalArea";

/** Escolha diante de uma possível duplicidade: cadastrar pessoa nova ou o caso num contato existente. */
export type RegistrationDecision = { kind: "new" } | { kind: "existing"; contactId: string; contactName: string };

export type ContactMatch = {
  contactId: string;
  name: string;
  /** Motivos por extenso: "mesmo telefone", "nome igual"… */
  reasons: string[];
  href: string;
};

export type DiagnosisItem = {
  id: string;
  title: string;
  /** O motivo de estar na lista. */
  reason: string;
  href: string;
  tone: "danger" | "warning" | "neutral";
};

export type DiagnosisSection = {
  key: "overdue" | "today" | "attention";
  title: string;
  /** "unavailable": a consulta falhou; nada é dito sobre o que ela traria. */
  status: "ok" | "unavailable";
  total: number;
  items: DiagnosisItem[];
  emptyText: string;
  moreHref: string;
};

export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "diagnosis"; summary: string; generatedAt: string; sections: DiagnosisSection[] }
  | { type: "question"; text: string; missing: RequiredRegistrationField[] }
  | { type: "duplicate"; requestId: string; ticket: string; draft: RegistrationDraft; matches: ContactMatch[] }
  | {
      type: "confirm";
      requestId: string;
      /** Comprovante assinado pelo servidor: liga o cartão à pessoa e ao escritório que o abriram. */
      ticket: string;
      draft: RegistrationDraft;
      /** null: o servidor confere duplicidade de novo ao confirmar. */
      decision: RegistrationDecision | null;
    }
  | {
      type: "success";
      contactName: string;
      contactHref: string;
      leadHref: string;
      legalArea: string;
      contactCreated: boolean;
      replayed: boolean;
    }
  | { type: "denied"; text: string }
  | { type: "error"; text: string };

export type AssistantReply = {
  blocks: AssistantBlock[];
  /** Rascunho que continua aberto, esperando o que falta (ou null). */
  pending: RegistrationDraft | null;
  /** Quem interpretou a mensagem: neste ciclo, sempre a simulação. */
  interpreter: { id: string; simulated: boolean };
};

export type ConfirmResult = {
  /**
   * saved: gravado (ou já estava, numa repetição). duplicate: apareceu uma possível duplicidade a decidir.
   * invalid: algum dado precisa de correção (o cartão continua aberto). denied: o perfil não pode
   * cadastrar. stale: o cartão foi aberto em outro escritório ou outra sessão; nada foi gravado e ele se
   * encerra. failed: o servidor recusou; nada foi gravado. uncertain: não deu para saber se gravou (o
   * cartão continua, e confirmar de novo devolve o mesmo cadastro se ele existir).
   */
  outcome: "saved" | "duplicate" | "invalid" | "denied" | "stale" | "failed" | "uncertain";
  /** Blocos para colocar no lugar do cartão (vazio quando o cartão continua). */
  blocks: AssistantBlock[];
  message?: string;
};
