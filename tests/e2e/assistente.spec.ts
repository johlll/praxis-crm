import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { SEED_PAINEL } from "./fixtures";
import { callRpcDirect, getSupabaseAccessToken, login, switchWorkspace } from "./helpers";

/**
 * Assistente (primeira versão), ponta a ponta com o banco local e dados fictícios. A INTERPRETAÇÃO é
 * simulada (regras fixas, sem provedor de IA); as consultas e o cadastro passam pelos caminhos reais do
 * CRM: list_activities e get_dashboard no diagnóstico; assistant_find_contact_matches,
 * assistant_find_registration e assistant_register_client (que chama create_contact e create_lead) no
 * cadastro.
 */

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

/** Sobrenome inventado e único por execução: o interpretador simulado lê nomes com iniciais maiúsculas. */
const surname = () =>
  Array.from({ length: 6 }, (_, i) => String.fromCharCode((i === 0 ? 65 : 97) + Math.floor(Math.random() * 26))).join("");

const message = (page: Page) => page.getByRole("textbox", { name: "Mensagem" });

async function send(page: Page, text: string) {
  await message(page).fill(text);
  await message(page).press("Enter");
  await expect(page.getByText("Consultando o CRM…")).toHaveCount(0);
}

type Api = Parameters<typeof getSupabaseAccessToken>[0];
type Match = { contact_id: string; name: string } & Record<string, unknown>;

async function matchesFor(request: Api, name: string, workspaceId: string = SEED_PAINEL.workspaceId, email: string = SEED_PAINEL.owner.email) {
  const token = await getSupabaseAccessToken(request, email);
  const { body } = await callRpcDirect(request, token, "assistant_find_contact_matches", { p_workspace_id: workspaceId, p_name: name });
  return (body as Match[]).filter((m) => m.name === name);
}

/** Leads que a pessoa vê para um nome, pela listagem oficial (com o alcance do perfil dela). */
async function visibleLeads(request: Api, name: string, email: string = SEED_PAINEL.owner.email) {
  const token = await getSupabaseAccessToken(request, email);
  const { body } = await callRpcDirect(request, token, "list_leads", { p_workspace_id: SEED_PAINEL.workspaceId, p_search: name });
  return Number((body as { total_count: number }[])[0]?.total_count ?? 0);
}

const userIdOf = (token: string) => (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { sub: string }).sub;

test.describe.serial("Assistente", () => {
  test("1. menu, tela inicial e diagnóstico com pendências, com links para os registros", async ({ page }) => {
    const errors = watchConsole(page);
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/visao-geral");
    await page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link", { name: "Assistente" }).click();
    await expect(page).toHaveURL(/\/assistente$/);
    await expect(page.getByRole("note")).toContainText("Interpretação simulada");

    await page.getByRole("button", { name: "O que precisa da minha atenção hoje?" }).click();
    const opportunities = page.getByRole("region", { name: "Oportunidades que exigem atenção" });
    await expect(opportunities).toBeVisible();
    await expect(page.getByRole("region", { name: "Atividades atrasadas" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Agenda de hoje" })).toBeVisible();
    await expect(page.getByText(/^Encontrei /)).toBeVisible();

    // O link leva ao registro de origem.
    const first = opportunities.getByRole("link").first();
    await expect(first).toHaveAttribute("href", /^\/oportunidades\/[0-9a-f-]{36}$/);
    await first.click();
    await expect(page).toHaveURL(/\/oportunidades\/[0-9a-f-]{36}/);
    expect(errors.filter((e) => /hydrat|did not match/i.test(e))).toEqual([]);
  });

  test("2. diagnóstico sem pendências, num escritório novo, sem nada dos outros", async ({ page, request }) => {
    // Escritório criado agora, pela função oficial (o seed põe dados de demonstração nos dois painéis).
    const token = await getSupabaseAccessToken(request, SEED_PAINEL.ownerB.email);
    const suffix = surname().toLowerCase();
    const workspaceName = `Assistente vazio ${suffix}`;
    const created = await callRpcDirect(request, token, "create_workspace_with_owner", { p_name: workspaceName, p_slug: `assistente-vazio-${suffix}` });
    expect(created.status).toBe(200);
    const workspaceId = (created.body as { id: string }).id;
    const counts = await callRpcDirect(request, token, "get_activity_counts", { p_workspace_id: workspaceId });
    expect(counts.body).toMatchObject({ overdue: 0, today: 0 });

    await login(page, SEED_PAINEL.ownerB.email);
    await switchWorkspace(page, workspaceName);
    await page.goto("/assistente");
    await page.getByRole("button", { name: "O que precisa da minha atenção hoje?" }).click();
    await expect(page.getByText(/^Nada precisa da sua atenção agora/)).toBeVisible();
    await expect(page.getByText("Nenhuma atividade atrasada.")).toBeVisible();
    await expect(page.getByRole("main").getByRole("link", { name: /·/ })).toHaveCount(0);
  });

  test("3. cadastro completo: cartão, confirmação com clique duplo, um cadastro só e links", async ({ page, request }) => {
    const name = `Ana Ribeiro ${surname()}`;
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/assistente");
    await send(page, `Cadastre ${name} para um caso de regularização de imóvel`);

    const card = page.getByRole("region", { name: "Cadastrar pessoa e caso" });
    await expect(card).toContainText(name);
    await expect(card).toContainText("Imobiliário");
    await expect(card).toContainText("Regularização de imóvel");
    expect(await matchesFor(request, name)).toEqual([]);

    await card.getByRole("button", { name: "Confirmar cadastro" }).dblclick();
    await expect(page.getByText("Cadastro gravado")).toBeVisible();
    const matches = await matchesFor(request, name);
    expect(matches).toHaveLength(1);
    expect(await visibleLeads(request, name)).toBe(1);

    await page.getByRole("link", { name: "Abrir o lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    await expect(page.getByText(name).first()).toBeVisible();
    await expect(page.getByText("Imobiliário").first()).toBeVisible();
  });

  test("4. pedido incompleto pergunta só o que falta; duplicidade mostra o registro e o caso vai no contato existente", async ({ page, request }) => {
    const name = `Bruno Lima ${surname()}`;
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/assistente");

    await page.getByRole("button", { name: "Cadastre um cliente" }).click();
    await expect(page.getByText(/preciso do nome da pessoa e do assunto do caso/)).toBeVisible();
    await send(page, name);
    await expect(page.getByText(new RegExp(`Qual é a área jurídica do caso de ${name}`))).toBeVisible();
    await send(page, "Trabalhista");
    await page.getByRole("region", { name: "Cadastrar pessoa e caso" }).getByRole("button", { name: "Confirmar cadastro" }).click();
    await expect(page.getByText("Cadastro gravado")).toBeVisible();

    // Mesmo nome de novo: o Assistente mostra quem já existe e a pessoa decide.
    await send(page, `Cadastre ${name} para um caso de inventário`);
    const duplicate = page.getByRole("region", { name: new RegExp(`Possível duplicidade para “${name}”`) });
    await expect(duplicate).toContainText("nome igual");
    await expect(duplicate).not.toContainText(/lead/i);
    await expect(duplicate.getByRole("link", { name: new RegExp(name) })).toHaveAttribute("href", /^\/contatos\//);
    await duplicate.getByRole("button", { name: "Usar este contato" }).click();
    const caseCard = page.getByRole("region", { name: `Novo caso para ${name}` });
    await expect(caseCard).toContainText("Família");
    await caseCard.getByRole("button", { name: "Confirmar cadastro" }).click();
    await expect(page.getByText(`Lead de Família criado no contato existente de ${name}.`)).toBeVisible();

    const matches = await matchesFor(request, name);
    expect(matches).toHaveLength(1);
    expect(await visibleLeads(request, name)).toBe(2);
  });

  test("5. cancelar não grava nada", async ({ page, request }) => {
    const name = `Carla Nunes ${surname()}`;
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/assistente");
    await send(page, `Cadastre ${name} para um caso de aposentadoria`);
    await page.getByRole("region", { name: "Cadastrar pessoa e caso" }).getByRole("button", { name: "Cancelar" }).click();
    await expect(page.getByText("Cadastro cancelado. Nada foi gravado.")).toBeVisible();
    expect(await matchesFor(request, name)).toEqual([]);
  });

  test("6. repetir a mesma confirmação devolve o mesmo cadastro; outro escritório e visualizador são recusados", async ({ request }) => {
    const owner = await getSupabaseAccessToken(request, SEED_PAINEL.owner.email);
    const args = {
      p_workspace_id: SEED_PAINEL.workspaceId,
      p_request_id: randomUUID(),
      p_name: `Diego Rocha ${surname()}`,
      p_legal_area: "Cível",
    };
    const first = await callRpcDirect(request, owner, "assistant_register_client", args);
    const again = await callRpcDirect(request, owner, "assistant_register_client", args);
    expect(first.status).toBe(200);
    expect(again.body).toMatchObject({ ...(first.body as object), replayed: true });
    expect(await matchesFor(request, args.p_name)).toHaveLength(1);

    const other = await getSupabaseAccessToken(request, SEED_PAINEL.ownerB.email);
    const attempts: [string, Record<string, unknown>][] = [
      ["assistant_register_client", { ...args, p_request_id: randomUUID() }],
      ["assistant_find_contact_matches", { p_workspace_id: SEED_PAINEL.workspaceId, p_name: args.p_name }],
    ];
    for (const [fn, fnArgs] of attempts) {
      const denied = await callRpcDirect(request, other, fn, fnArgs);
      expect(denied.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(denied.body)).toContain("insufficient_permission");
    }

    const viewer = await getSupabaseAccessToken(request, SEED_PAINEL.viewer.email);
    const deniedViewer = await callRpcDirect(request, viewer, "assistant_register_client", { ...args, p_request_id: randomUUID(), p_name: "Visualizador Tentou" });
    expect(JSON.stringify(deniedViewer.body)).toContain("insufficient_permission");
  });

  test("7. visualizador recebe a recusa ao pedir cadastro, mas consulta o diagnóstico", async ({ page }) => {
    await login(page, SEED_PAINEL.viewer.email);
    await page.goto("/assistente");
    await send(page, "Cadastre Ana Ribeiro para um caso de regularização de imóvel");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Seu perfil (Visualizador) pode consultar o CRM, mas não cadastrar");
    await expect(page.getByRole("region", { name: "Cadastrar pessoa e caso" })).toHaveCount(0);
    await send(page, "O que precisa da minha atenção hoje?");
    await expect(page.getByRole("region", { name: "Agenda de hoje" })).toBeVisible();
  });

  test("8. celular: campo de mensagem no rodapé visível e sem rolagem lateral", async ({ browser, page }) => {
    await login(page, SEED_PAINEL.owner.email);
    const storageState = await page.context().storageState();
    const phone = await browser.newContext({ storageState, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const tab = await phone.newPage();
    await tab.goto("/assistente");
    await tab.getByRole("button", { name: "O que precisa da minha atenção hoje?" }).tap();
    await expect(tab.getByRole("region", { name: "Agenda de hoje" })).toBeVisible();
    const box = (await tab.getByRole("textbox", { name: "Mensagem" }).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await expect.poll(() => tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
    await phone.close();
  });

  test("9. cartão aberto num escritório e escritório trocado em outra aba: a confirmação antiga não grava em nenhum dos dois", async ({ page, request }) => {
    // Otávio é proprietário do Painel B e, agora, de um escritório novo: pode cadastrar nos dois.
    const token = await getSupabaseAccessToken(request, SEED_PAINEL.ownerB.email);
    const suffix = surname().toLowerCase();
    const otherName = `Assistente troca ${suffix}`;
    const created = await callRpcDirect(request, token, "create_workspace_with_owner", { p_name: otherName, p_slug: `assistente-troca-${suffix}` });
    expect(created.status).toBe(200);
    const otherId = (created.body as { id: string }).id;
    const painelB = { id: "10000000-0000-0000-0000-000000000011", name: "Escritório Painel B (seed)" };

    await login(page, SEED_PAINEL.ownerB.email);
    const switcher = page.getByRole("button", { name: "Trocar de workspace" });
    await expect(switcher).toBeVisible();
    if (!((await switcher.textContent()) ?? "").includes(painelB.name)) await switchWorkspace(page, painelB.name);
    await expect(switcher).toContainText(painelB.name);
    await page.goto("/assistente");
    const name = `Helio Troca ${surname()}`;
    await send(page, `Cadastre ${name} para um caso de rescisão`);
    const card = page.getByRole("region", { name: "Cadastrar pessoa e caso" });
    await expect(card).toBeVisible();

    // Outra aba da mesma sessão troca o escritório ativo.
    const otherTab = await page.context().newPage();
    await otherTab.goto("/visao-geral");
    await switchWorkspace(otherTab, otherName);

    await card.getByRole("button", { name: "Confirmar cadastro" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("O escritório ativo mudou depois que este cartão foi aberto");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Nada foi gravado.");
    await expect(card).toHaveCount(0);

    expect(await matchesFor(request, name, painelB.id, SEED_PAINEL.ownerB.email)).toEqual([]);
    expect(await matchesFor(request, name, otherId, SEED_PAINEL.ownerB.email)).toEqual([]);
    await otherTab.close();
  });

  test("10. resposta da gravação perdida: o aviso diz que não se sabe se gravou, e confirmar de novo devolve os mesmos links", async ({ page, request }) => {
    const name = `Iara Perdida ${surname()}`;
    await login(page, SEED_PAINEL.owner.email);
    await page.goto("/assistente");
    await send(page, `Cadastre ${name} para um caso de divórcio`);
    const card = page.getByRole("region", { name: "Cadastrar pessoa e caso" });

    // A primeira confirmação chega ao servidor (e grava), mas a resposta não volta ao navegador.
    let lost = 0;
    await page.route("**/assistente", async (route) => {
      const req = route.request();
      if (lost === 0 && req.method() === "POST" && (req.postData() ?? "").includes('"ticket"')) {
        lost += 1;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await card.getByRole("button", { name: "Confirmar cadastro" }).click();
    await expect(card.getByRole("alert")).toContainText("Não sei se o cadastro foi gravado");
    expect(lost).toBe(1);
    const saved = await matchesFor(request, name);
    expect(saved).toHaveLength(1);

    await card.getByRole("button", { name: "Confirmar de novo" }).click();
    await expect(page.getByText("Este cadastro já estava gravado")).toBeVisible();
    await expect(page.getByText(/Possível duplicidade/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Abrir o contato" })).toHaveAttribute("href", `/contatos/${saved[0]!.contact_id}`);
    await expect(page.getByRole("link", { name: "Abrir o lead" })).toHaveAttribute("href", /^\/leads\/[0-9a-f-]{36}$/);
    expect(await matchesFor(request, name)).toHaveLength(1);
    expect(await visibleLeads(request, name)).toBe(1);

    await page.getByRole("link", { name: "Abrir o lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    await expect(page.getByText(name).first()).toBeVisible();
  });

  test("11. contato com leads de dois responsáveis: a busca de duplicidade não conta leads, para nenhum perfil", async ({ page, request }) => {
    const owner = await getSupabaseAccessToken(request, SEED_PAINEL.owner.email);
    const name = `Helena Dupla ${surname()}`;
    const first = await callRpcDirect(request, owner, "assistant_register_client", {
      p_workspace_id: SEED_PAINEL.workspaceId,
      p_request_id: randomUUID(),
      p_name: name,
      p_legal_area: "Família",
    });
    const contactId = (first.body as { contact_id: string }).contact_id;
    const second = await callRpcDirect(request, owner, "assistant_register_client", {
      p_workspace_id: SEED_PAINEL.workspaceId,
      p_request_id: randomUUID(),
      p_name: name,
      p_legal_area: "Cível",
      p_existing_contact_id: contactId,
    });
    // Um lead fica com a proprietária, o outro com o advogado.
    for (const [lead, assignee] of [
      [(first.body as { lead_id: string }).lead_id, userIdOf(owner)],
      [(second.body as { lead_id: string }).lead_id, SEED_PAINEL.lawyer.userId],
    ] as const) {
      const current = await callRpcDirect(request, owner, "get_lead", { p_lead_id: lead });
      const assigned = await callRpcDirect(request, owner, "assign_lead", {
        p_lead_id: lead,
        p_assigned_to: assignee,
        p_expected_updated_at: (current.body as { updated_at: string }).updated_at,
      });
      expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    }
    expect(await visibleLeads(request, name, SEED_PAINEL.owner.email)).toBe(2);
    expect(await visibleLeads(request, name, SEED_PAINEL.lawyer.email)).toBe(1);

    const asOwner = await matchesFor(request, name, SEED_PAINEL.workspaceId, SEED_PAINEL.owner.email);
    const asLawyer = await matchesFor(request, name, SEED_PAINEL.workspaceId, SEED_PAINEL.lawyer.email);
    expect(asLawyer).toEqual(asOwner);
    expect(Object.keys(asLawyer[0]!).sort()).toEqual(["contact_id", "created_at", "name", "signals"]);

    await login(page, SEED_PAINEL.lawyer.email);
    await page.goto("/assistente");
    await send(page, `Cadastre ${name} para um caso de inventário`);
    const duplicate = page.getByRole("region", { name: new RegExp(`Possível duplicidade para “${name}”`) });
    await expect(duplicate).toContainText("nome igual");
    await expect(duplicate).not.toContainText(/lead/i);
  });
});
