import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { SEED_PAINEL } from "./fixtures";
import { callRpcDirect, getSupabaseAccessToken, login, switchWorkspace } from "./helpers";

/**
 * Assistente (primeira versão), ponta a ponta com o banco local e dados fictícios. A INTERPRETAÇÃO é
 * simulada (regras fixas, sem provedor de IA); as consultas e o cadastro passam pelos caminhos reais do
 * CRM: list_activities e get_dashboard no diagnóstico; assistant_find_contact_matches e
 * assistant_register_client (que chama create_contact e create_lead) no cadastro.
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

async function matchesFor(request: Parameters<typeof getSupabaseAccessToken>[0], name: string) {
  const token = await getSupabaseAccessToken(request, SEED_PAINEL.owner.email);
  const { body } = await callRpcDirect(request, token, "assistant_find_contact_matches", { p_workspace_id: SEED_PAINEL.workspaceId, p_name: name });
  return (body as { name: string; lead_count: number }[]).filter((m) => m.name === name);
}

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
    expect(matches[0]!.lead_count).toBe(1);

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
    await expect(duplicate.getByRole("link", { name: new RegExp(name) })).toHaveAttribute("href", /^\/contatos\//);
    await duplicate.getByRole("button", { name: "Usar este contato" }).click();
    const caseCard = page.getByRole("region", { name: `Novo caso para ${name}` });
    await expect(caseCard).toContainText("Família");
    await caseCard.getByRole("button", { name: "Confirmar cadastro" }).click();
    await expect(page.getByText(`Lead de Família criado no contato existente de ${name}.`)).toBeVisible();

    const matches = await matchesFor(request, name);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.lead_count).toBe(2);
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
});
