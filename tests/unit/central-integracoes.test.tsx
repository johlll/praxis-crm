import { fireEvent, render, screen, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Central de Integrações (docs/decisoes/central-integracoes.md): categorias, estados comprováveis, permissões,
 * erro de consulta, nenhuma ação externa e preservação das rotas do Google Agenda. Mais o menu das duas páginas.
 */

import type { CalendarConnectionListItem as Connection } from "@/modules/calendar/queries";

const mocks = vi.hoisted(() => ({
  provider: null as null | { kind: "google" | "simulated" },
  providerError: false,
  connections: [] as unknown[],
  connectionsError: false,
  channels: [] as { isSimulator: boolean; status: string; displayPhoneNumber: string; label: string }[],
  channelsError: false,
  calls: [] as string[],
  refresh: vi.fn(),
  role: "owner",
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }), usePathname: () => "/integracoes" }));
vi.mock("@/server/calendar/provider", () => ({
  getCalendarProvider: async () => {
    if (mocks.providerError) throw new Error("config quebrada");
    // Qualquer chamada ao provedor (Google) faria o teste falhar: ele não tem métodos.
    return mocks.provider;
  },
}));
vi.mock("@/modules/calendar/queries", () => ({
  listCalendarConnections: async (workspaceId: string) => {
    mocks.calls.push(`listCalendarConnections:${workspaceId}`);
    if (mocks.connectionsError) throw new Error("segredo interno do banco");
    return mocks.connections;
  },
}));
vi.mock("@/modules/conversations/queries", () => ({
  listWhatsAppChannels: async (workspaceId: string) => {
    mocks.calls.push(`listWhatsAppChannels:${workspaceId}`);
    if (mocks.channelsError) throw new Error("falha");
    return mocks.channels;
  },
}));
vi.mock("@/modules/auth/actions", () => ({ signOutAction: vi.fn() }));
vi.mock("@/modules/workspace/actions", () => ({ switchWorkspaceAction: vi.fn() }));

const { loadIntegrationCards } = await import("@/modules/integrations/status");
const { CARD_ORDER, categoryCounts } = await import("@/modules/integrations/cards");
const { IntegrationsHub } = await import("@/components/integrations/integrations-hub");
const { Sidebar } = await import("@/components/app-shell/sidebar");

const root = resolve(__dirname, "..", "..");
const connection = (patch: Partial<Connection>): Connection => ({
  id: "c",
  userId: "u",
  isMine: true,
  googleAccountEmail: "pessoa.secreta@exemplo.test",
  calendarId: "agenda@exemplo.test",
  calendarSummary: "Agenda secreta",
  status: "active",
  createdAt: "2026-11-01T00:00:00Z",
  ...patch,
});
const load = (role: Parameters<typeof loadIntegrationCards>[0]["role"] = "owner") => loadIntegrationCards({ workspaceId: "w-1", role });
const byId = async (id: string, role: Parameters<typeof loadIntegrationCards>[0]["role"] = "owner") =>
  (await load(role)).find((c) => c.id === id)!;

beforeEach(() => {
  mocks.provider = null;
  mocks.providerError = false;
  mocks.connections = [];
  mocks.connectionsError = false;
  mocks.channels = [];
  mocks.channelsError = false;
  mocks.calls.length = 0;
  mocks.refresh.mockReset();
});

describe("cartões e categorias", () => {
  it("seis cartões, na ordem da referência, com contagens derivadas deles", async () => {
    const cards = await load();
    expect(cards.map((c) => c.id)).toEqual([...CARD_ORDER]);
    expect(categoryCounts(cards)).toEqual([
      { category: "Comunicação", count: 1 },
      { category: "Agenda", count: 1 },
      { category: "Marketing", count: 2 },
      { category: "Documentos", count: 1 },
      { category: "Automação", count: 1 },
    ]);
    expect(categoryCounts(cards.slice(0, 2)).map((c) => c.category)).toEqual(["Comunicação", "Agenda"]);
  });

  it("logotipos são arquivos locais, sem script nem referência externa; Automações usa o ícone do Praxis", async () => {
    const cards = await load();
    expect(cards.find((c) => c.id === "automacoes")!.logo).toBeNull();
    for (const card of cards.filter((c) => c.logo)) {
      const file = resolve(root, "public", `.${card.logo}`);
      expect(existsSync(file), card.logo!).toBe(true);
      const svg = readFileSync(file, "utf8");
      expect(svg).toContain("<svg");
      expect(svg).not.toMatch(/<script|on\w+=|javascript:|<foreignObject|<image|(href|src)="https?:|@import/i);
    }
  });

  it("nenhum cartão declara conexão que o sistema não comprova", async () => {
    mocks.channels = [{ isSimulator: true, status: "active", displayPhoneNumber: "+55 11 99999-0000", label: "Canal X" }];
    for (const id of ["whatsapp", "meta-ads", "google-ads", "assinatura-digital", "automacoes"]) {
      const card = await byId(id);
      expect(`${card.state.label} ${card.state.lines.join(" ")}`, id).not.toMatch(/(?<!não )(?<![Dd]es)conectad[oa]/i);
      expect(card.state.tone, id).not.toBe("ok");
    }
    for (const id of ["meta-ads", "google-ads"]) {
      expect(await byId(id)).toMatchObject({ state: { label: "Ainda não disponível", tone: "unavailable" }, action: null });
    }
    const signature = await byId("assinatura-digital");
    expect(signature.state.label).toBe("Funcionalidade futura");
    expect(signature.action).toBeNull();
    expect(signature.details.paragraphs.join(" ")).toContain("não indica integração nem contrato com a D4Sign");
    expect(`${signature.description} ${signature.details.paragraphs.join(" ")}`).not.toMatch(/validade jurídica|100% digital/i);
  });
});

describe("Google Agenda", () => {
  it("ambiente sem configuração: diz isso e não consulta conexões", async () => {
    const card = await byId("google-agenda");
    expect(card.state).toMatchObject({ label: "Não configurado neste ambiente", tone: "unavailable" });
    expect(card.action).toEqual({ href: "/configuracoes/integracoes", label: "Abrir configuração" });
    expect(mocks.calls.filter((c) => c.startsWith("listCalendarConnections"))).toEqual([]);
  });

  it("visualizador não consulta conexões e não recebe ação", async () => {
    mocks.provider = { kind: "google" };
    const card = await byId("google-agenda", "viewer");
    expect(card.state.label).toBe("Sem acesso para conectar");
    expect(card.action).toBeNull();
    expect(card.details.links).toEqual([]);
    expect(mocks.calls.filter((c) => c.startsWith("listCalendarConnections"))).toEqual([]);
  });

  it.each<[string, Partial<Connection> | null, string, string, string]>([
    ["ativa com agenda", {}, "Sua conta: conectada", "ok", "Gerenciar"],
    ["sem agenda escolhida", { calendarId: null }, "Sua conta: falta escolher a agenda", "attention", "Gerenciar"],
    ["precisa autorizar", { status: "needs_reauth" }, "Sua conta: precisa autorizar de novo", "attention", "Gerenciar"],
    ["sem conexão própria", null, "Sua conta: não conectada", "neutral", "Configurar"],
  ])("conexão pessoal %s", async (_, mine, label, tone, action) => {
    mocks.provider = { kind: "google" };
    mocks.connections = mine ? [connection(mine)] : [];
    const card = await byId("google-agenda", "lawyer");
    expect(card.state).toMatchObject({ label, tone });
    expect(card.action).toEqual({ href: "/configuracoes/integracoes", label: action });
    expect(mocks.calls).toContain("listCalendarConnections:w-1");
  });

  it("a conexão da equipe não conta como a pessoal, só aparece para quem administra e nunca com e-mail", async () => {
    mocks.provider = { kind: "google" };
    mocks.connections = [
      connection({ id: "a", isMine: false }),
      connection({ id: "b", isMine: false, status: "needs_reauth" }),
      connection({ id: "c", isMine: false, calendarId: null }),
    ];
    for (const role of ["owner", "admin"] as const) {
      const card = await byId("google-agenda", role);
      expect(card.state.label).toBe("Sua conta: não conectada");
      expect(card.state.lines).toEqual(["Equipe (outras pessoas): 1 conectada, 1 sem agenda escolhida, 1 precisando autorizar de novo."]);
    }
    for (const role of ["manager", "lawyer", "sales"] as const) {
      expect((await byId("google-agenda", role)).state.lines).toEqual([]);
    }
    expect(JSON.stringify(await load("owner"))).not.toMatch(/secret|exemplo\.test/i);
  });

  it("provedor simulado é identificado como ambiente de teste", async () => {
    mocks.provider = { kind: "simulated" };
    expect((await byId("google-agenda")).state.lines[0]).toBe("Ambiente de teste: provedor simulado, não é o Google.");
  });

  it.each(["connectionsError", "providerError"] as const)("falha (%s) é erro, nunca 'não conectado', sem detalhe interno", async (flag) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.provider = { kind: "google" };
    mocks[flag] = true;
    const cards = await load();
    const card = cards.find((c) => c.id === "google-agenda")!;
    expect(card.state).toMatchObject({ tone: "error", label: "Não foi possível consultar" });
    expect(JSON.stringify(cards)).not.toMatch(/não conectada|segredo interno|config quebrada/i);
    expect(cards).toHaveLength(6);
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/segredo interno|config quebrada/);
    log.mockRestore();
  });
});

describe("WhatsApp e Automações", () => {
  it("conta só canais fictícios ativos, sem número nem nome, e não afirma nada sobre canal real", async () => {
    mocks.channels = [
      { isSimulator: true, status: "active", displayPhoneNumber: "+55 11 98888-7777", label: "Canal do João" },
      { isSimulator: true, status: "disabled", displayPhoneNumber: "+55 11 90000-0000", label: "Velho" },
    ];
    const card = await byId("whatsapp");
    expect(card.state.label).toBe("Canal real não validado");
    expect(card.state.lines).toEqual(["Simulador interno: 1 canal fictício ativo.", "Testes com WhatsApp real pausados."]);
    expect(card.details.paragraphs.join(" ")).toContain("não afirma que há conexão nem que não há");
    expect(JSON.stringify(card)).not.toMatch(/98888|Canal do João/);
  });

  it("falha na leitura do simulador é erro", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.channelsError = true;
    expect((await byId("whatsapp")).state.tone).toBe("error");
    log.mockRestore();
  });

  it("simulador e automações só para quem tem permissão", async () => {
    expect((await byId("whatsapp", "owner")).details.links.map((l) => l.href)).toContain("/configuracoes/simulador-whatsapp");
    expect((await byId("whatsapp", "manager")).details.links.map((l) => l.href)).toEqual(["/conversas"]);
    expect((await byId("automacoes", "manager")).action).toEqual({ href: "/automacoes", label: "Abrir automações" });
    const lawyer = await byId("automacoes", "lawyer");
    expect(lawyer.action).toBeNull();
    expect(lawyer.state.lines).toEqual(["Seu papel não tem acesso ao módulo."]);
    expect(lawyer.details.paragraphs.join(" ")).toContain("Não é a inteligência artificial");
  });
});

describe("tela", () => {
  it("filtra por categoria, com o estado do botão e a contagem", async () => {
    render(<IntegrationsHub cards={await load()} />);
    const list = () => within(screen.getByRole("list", { name: "Integrações" })).getAllByRole("listitem");
    expect(screen.getByRole("button", { name: "Todas (6)" })).toHaveAttribute("aria-pressed", "true");
    expect(list()).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Marketing (2)" }));
    expect(screen.getByRole("button", { name: "Marketing (2)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Todas (6)" })).toHaveAttribute("aria-pressed", "false");
    expect(list().map((li) => within(li).getByRole("heading").textContent)).toEqual(["Meta Ads", "Google Ads"]);
    fireEvent.click(screen.getByRole("button", { name: "Todas (6)" }));
    expect(list()).toHaveLength(6);
  });

  it("sem menu ⋮, sem botão 'Conectar' e todo cartão tem 'Ver detalhes' que explica", async () => {
    render(<IntegrationsHub cards={await load()} />);
    expect(screen.queryByRole("button", { name: /^Conectar|mais opções/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Conectar/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("⋮");
    expect(screen.getAllByRole("button", { name: /^Ver detalhes de / })).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes de Meta Ads" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Nenhuma conta, senha ou chave é pedida agora.");
    expect(dialog.querySelectorAll("input, form")).toHaveLength(0);
    expect(within(dialog).getByRole("link", { name: "Abrir Tráfego Pago" })).toHaveAttribute("href", "/trafego-pago");
  });

  it("erro tem alerta e 'Tentar novamente', que só recarrega a página", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.channelsError = true;
    render(<IntegrationsHub cards={await load()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível consultar");
    fireEvent.click(screen.getByRole("button", { name: "Tentar consultar WhatsApp novamente" }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});

describe("sem ação externa e Google Agenda preservado", () => {
  const source = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  it("a central não importa nada que renove, sincronize, grave ou leia segredo", () => {
    for (const file of [
      "src/modules/integrations/status.ts",
      "src/modules/integrations/cards.ts",
      "src/components/integrations/integrations-hub.tsx",
      "src/app/(app)/integracoes/page.tsx",
    ]) {
      expect(source(file), file).not.toMatch(
        /listChoosableCalendars|loadFreshTokens|connection-context|calendar\/actions|calendar\/automation|refreshAccessToken|listCalendars|server\/whatsapp|createAdminSupabaseClient|service_role|process\.env|fetch\(|"use server"|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/,
      );
    }
  });

  it("a tela de configuração e os retornos de autorização continuam no mesmo endereço", () => {
    expect(existsSync(resolve(root, "src/app/(app)/configuracoes/integracoes/page.tsx"))).toBe(true);
    for (const file of ["src/app/api/calendar/oauth/start/route.ts", "src/app/api/calendar/oauth/callback/route.ts"]) {
      expect(readFileSync(resolve(root, file), "utf8"), file).toContain('const INTEGRATIONS = "/configuracoes/integracoes";');
    }
    expect(source("src/modules/integrations/status.ts")).toContain('const SETTINGS = "/configuracoes/integracoes"');
  });
});

describe("menu", () => {
  const sidebar = (role: "owner" | "manager" | "lawyer" | "viewer") => {
    const ws = { id: "w", name: "Escritório", slug: "e", role };
    return render(<Sidebar activeWorkspace={ws} workspaces={[ws]} />);
  };
  const labels = () => within(screen.getByRole("navigation", { name: "Navegação principal" })).getAllByRole("link").map((a) => a.textContent);

  it("Financeiro vem antes de Tráfego Pago e Integrações antes de Configurações, com os itens antigos", () => {
    sidebar("owner");
    expect(labels()).toEqual([
      "Visão geral", "Contatos", "Leads", "Pipeline", "Conversas", "Atividades", "Agenda", "Clientes",
      "Financeiro", "Tráfego Pago", "Automações", "Relatórios", "Integrações", "Configurações",
    ]);
  });

  it.each(["lawyer", "viewer"] as const)("%s não vê Financeiro, mas vê o resto", (role) => {
    sidebar(role);
    expect(labels()).not.toContain("Financeiro");
    expect(labels()).toHaveLength(13);
  });

  it("gestor vê Financeiro", () => {
    sidebar("manager");
    expect(labels()).toContain("Financeiro");
  });
});
