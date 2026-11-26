import { roleHasPermission, type Role } from "@/lib/roles";
import { listCalendarConnections, type CalendarConnectionListItem } from "@/modules/calendar/queries";
import { listWhatsAppChannels } from "@/modules/conversations/queries";
import { getCalendarProvider } from "@/server/calendar/provider";
import { CARD_BASE, CARD_ORDER, type IntegrationCard, type IntegrationId } from "./cards";

/**
 * Estado de cada cartão — SOMENTE LEITURA, com a sessão da pessoa.
 *
 * Só duas leituras: a lista de conexões de agenda (RPC já existente, que nunca traz token e já recorta por papel:
 * cada um vê a própria; proprietário e administrador veem as do escritório) e os canais do SIMULADOR de WhatsApp
 * (RLS). Nada aqui chama o Google ou a Meta, renova autorização, sincroniza, lê credencial ou usa a chave de
 * serviço. Falha de leitura vira estado de ERRO no cartão — nunca "não conectado".
 */

type CardState = Pick<IntegrationCard, "state" | "action" | "details">;

const SETTINGS = "/configuracoes/integracoes" as const;

/** Só um código no log: a mensagem original pode ter dado interno. */
function logFailure(card: IntegrationId, error: unknown) {
  console.error(`integrations_hub_read_failed card=${card} type=${error instanceof Error ? error.name : "unknown"}`);
}

const QUERY_FAILED: CardState["state"] = {
  tone: "error",
  label: "Não foi possível consultar",
  lines: ["Isso não significa que está desconectado. Tente novamente."],
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function personalState(mine: CalendarConnectionListItem | undefined): { tone: CardState["state"]["tone"]; label: string } {
  if (!mine) return { tone: "neutral", label: "Sua conta: não conectada" };
  if (mine.status === "needs_reauth") return { tone: "attention", label: "Sua conta: precisa autorizar de novo" };
  if (!mine.calendarId) return { tone: "attention", label: "Sua conta: falta escolher a agenda" };
  return { tone: "ok", label: "Sua conta: conectada" };
}

/** Situação das conexões das OUTRAS pessoas, só em contagens (sem e-mail nem nome). */
function teamLine(others: readonly CalendarConnectionListItem[]): string {
  if (others.length === 0) return "Equipe: nenhuma outra conexão.";
  const ready = others.filter((c) => c.status === "active" && c.calendarId !== null).length;
  const noCalendar = others.filter((c) => c.status === "active" && c.calendarId === null).length;
  const reauth = others.filter((c) => c.status === "needs_reauth").length;
  const parts = [
    ready ? plural(ready, "conectada", "conectadas") : "",
    noCalendar ? `${noCalendar} sem agenda escolhida` : "",
    reauth ? `${reauth} precisando autorizar de novo` : "",
  ].filter(Boolean);
  return `Equipe (outras pessoas): ${parts.join(", ")}.`;
}

async function googleCalendar(workspaceId: string, role: Role): Promise<CardState> {
  const canConnect = roleHasPermission(role, "calendar.connect_own");
  const canSeeTeam = roleHasPermission(role, "calendar.manage");
  const settings = canConnect ? { href: SETTINGS, label: "Abrir configuração" } : null;
  const details = {
    paragraphs: [
      "A conexão é pessoal: cada pessoa autoriza a própria conta Google e escolhe uma agenda dela.",
      canConnect ? "A conexão, a escolha da agenda e a desconexão ficam na tela de configuração." : "Seu papel não permite conectar uma agenda.",
      "O estado mostrado aqui é o último registrado no Praxis. Abrir esta central não consulta o Google nem sincroniza nada.",
    ],
    links: settings ? [settings] : [],
  };

  try {
    // Sem provedor configurado, nada do Google Agenda é consultado no banco.
    const provider = await getCalendarProvider();
    if (!provider) {
      return {
        state: {
          tone: "unavailable",
          label: "Não configurado neste ambiente",
          lines: ["A integração com o Google Agenda não está configurada aqui."],
        },
        action: settings,
        details,
      };
    }
    const simulated = provider.kind === "simulated" ? ["Ambiente de teste: provedor simulado, não é o Google."] : [];
    if (!canConnect) {
      return {
        state: { tone: "neutral", label: "Sem acesso para conectar", lines: [...simulated, "Seu papel não permite conectar uma agenda."] },
        action: null,
        details,
      };
    }
    const connections = await listCalendarConnections(workspaceId);
    const mine = connections.find((c) => c.isMine);
    const personal = personalState(mine);
    return {
      state: {
        ...personal,
        lines: [...simulated, ...(canSeeTeam ? [teamLine(connections.filter((c) => !c.isMine))] : [])],
      },
      action: { href: SETTINGS, label: mine ? "Gerenciar" : "Configurar" },
      details,
    };
  } catch (error) {
    logFailure("google-agenda", error);
    return { state: QUERY_FAILED, action: settings, details };
  }
}

async function whatsapp(workspaceId: string, role: Role): Promise<CardState> {
  const canSimulate = roleHasPermission(role, "conversation.simulate");
  const simulator = canSimulate ? { href: "/configuracoes/simulador-whatsapp" as const, label: "Abrir simulador" } : null;
  const details = {
    paragraphs: [
      "O simulador interno serve para testar o fluxo de conversas sem enviar nem receber mensagens de verdade.",
      "O funcionamento com um número real do WhatsApp ainda não foi validado, e esses testes estão pausados.",
      "Por segurança, esta central não consulta canais reais: não afirma que há conexão nem que não há.",
    ],
    links: [{ href: "/conversas" as const, label: "Abrir Conversas" }, ...(simulator ? [simulator] : [])],
  };
  try {
    const active = (await listWhatsAppChannels(workspaceId)).filter((c) => c.isSimulator && c.status === "active").length;
    return {
      state: {
        tone: "neutral",
        label: "Canal real não validado",
        lines: [
          active > 0
            ? `Simulador interno: ${plural(active, "canal fictício ativo", "canais fictícios ativos")}.`
            : "Simulador interno: nenhum canal fictício neste escritório.",
          "Testes com WhatsApp real pausados.",
        ],
      },
      action: null,
      details,
    };
  } catch (error) {
    logFailure("whatsapp", error);
    return { state: QUERY_FAILED, action: null, details };
  }
}

function futureAds(name: "Meta Ads" | "Google Ads"): CardState {
  return {
    state: { tone: "unavailable", label: "Ainda não disponível", lines: ["Integração futura."] },
    action: null,
    details: {
      paragraphs: [
        `O Praxis ainda não se conecta ao ${name}. Nenhuma conta, senha ou chave é pedida agora.`,
        "Quando for construída, a integração começará somente para leitura: sem criar, pausar ou alterar campanhas ou orçamento.",
        "A página Tráfego Pago já existe, hoje só com dados fictícios no escritório demonstrativo.",
      ],
      links: [{ href: "/trafego-pago", label: "Abrir Tráfego Pago" }],
    },
  };
}

function digitalSignature(): CardState {
  return {
    state: { tone: "unavailable", label: "Funcionalidade futura", lines: ["Fornecedor ainda não escolhido."] },
    action: null,
    details: {
      paragraphs: [
        "O Praxis ainda não envia documentos para assinatura.",
        "Nenhum fornecedor foi escolhido ou contratado. O ícone segue a referência visual da tela e não indica integração nem contrato com a D4Sign.",
      ],
      links: [],
    },
  };
}

function automations(role: Role): CardState {
  const canView = roleHasPermission(role, "automation.view");
  const open = canView ? { href: "/automacoes" as const, label: "Abrir automações" } : null;
  return {
    state: {
      tone: "neutral",
      label: "Recurso interno do Praxis",
      lines: canView ? [] : ["Seu papel não tem acesso ao módulo."],
    },
    action: open,
    details: {
      paragraphs: [
        "Não é um serviço externo: são regras do próprio Praxis, que precisam ser simuladas antes de ativadas.",
        "Não enviam mensagens, e-mails nem notificações.",
        "Não é a inteligência artificial que atualizaria a situação dos atendimentos, que segue pausada.",
      ],
      links: open ? [open] : [],
    },
  };
}

export async function loadIntegrationCards({ workspaceId, role }: { workspaceId: string; role: Role }): Promise<IntegrationCard[]> {
  const [calendar, chat] = await Promise.all([googleCalendar(workspaceId, role), whatsapp(workspaceId, role)]);
  const states: Record<IntegrationId, CardState> = {
    whatsapp: chat,
    "google-agenda": calendar,
    "meta-ads": futureAds("Meta Ads"),
    "google-ads": futureAds("Google Ads"),
    "assinatura-digital": digitalSignature(),
    automacoes: automations(role),
  };
  return CARD_ORDER.map((id) => ({ ...CARD_BASE[id], ...states[id] }));
}
