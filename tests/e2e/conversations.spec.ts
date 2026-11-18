import { expect, test, type Page } from "@playwright/test";

import { SEED_USERS } from "./fixtures";
import { login } from "./helpers";

/**
 * Conversas + IA (PR 2): a tela tem lista, mensagens e um painel de contexto. O painel é a terceira
 * coluna a partir de 1400 px e uma gaveta abaixo disso (o e2e roda em 1280 px). Estes ajudantes
 * abrem e fecham a gaveta só quando ela existe, para o mesmo teste valer nas duas larguras.
 */
async function openContext(page: Page) {
  const toggle = page.getByRole("button", { name: "Contexto", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.locator("#painel-contexto")).toBeVisible();
}

async function closeContext(page: Page) {
  const toggle = page.getByRole("button", { name: "Contexto", exact: true });
  if (await toggle.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(page.locator("#painel-contexto")).toBeHidden();
  }
}

/**
 * Jornada da A7 contra o Supabase local do CI. pgTAP
 * (12_a7_conversations.test.sql) e o teste de concorrência real
 * (scripts/a7-concurrency-check.mjs) já cobrem exaustivamente idempotência,
 * isolamento, alcance por papel e consentimento no nível do banco — este
 * arquivo foca no que só um e2e prova de verdade: o fluxo real de UI de
 * ponta a ponta (mensagem recebida → cadastro inicial → conversa →
 * consentimento → resposta simulada → estados de entrega/leitura).
 *
 * `test.describe.serial`: os testes reaproveitam o canal/conversa criados
 * no teste anterior.
 */
test.describe.serial("conversas + simulador de WhatsApp — A7", () => {
  const phoneNumberId = `e2e-phone-${Date.now()}`;
  const fromPhone = "+55 11 96543-2109";
  let conversationUrl: string;

  test("1. cria canal e simula mensagem recebida de número desconhecido", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/configuracoes/simulador-whatsapp");
    await page.getByLabel("Nome do canal").fill("Canal e2e");
    await page.getByLabel("Número (fictício)").fill("+55 11 5555-9999");
    await page.getByLabel("Identificador do número (phone_number_id)").fill(phoneNumberId);
    await page.getByRole("button", { name: "Criar canal" }).click();
    // "Canal e2e" aparece na lista de canais E como <option> do select do
    // formulário de simulação logo abaixo — getByRole("list") escopa só a
    // lista (achado real no CI: strict mode violation do Playwright).
    await expect(page.getByRole("list").getByText("Canal e2e")).toBeVisible();

    await page.getByLabel("Número de quem envia").fill(fromPhone);
    await page.getByLabel("Nome (opcional)").fill("Contato E2E A7");
    await page.getByLabel("Mensagem").fill("Olá, preciso de ajuda jurídica (teste e2e)");
    await page.getByRole("button", { name: "Simular mensagem recebida" }).click();

    const conversationLink = page.getByRole("link", { name: "Ver conversa" });
    await expect(conversationLink).toBeVisible();
    const href = await conversationLink.getAttribute("href");
    conversationUrl = new URL(href!, page.url()).toString();

    await page.goto(conversationUrl);
    await expect(page.getByRole("heading", { name: "Contato E2E A7" })).toBeVisible();
    // A mesma frase aparece na prévia da lista; a conferência é sobre o histórico de mensagens.
    const thread = page.getByRole("log", { name: "Mensagens da conversa" });
    await expect(thread.getByText("Olá, preciso de ajuda jurídica (teste e2e)")).toBeVisible();
    // Número desconhecido: nunca fica com "Vínculo pendente" — já sai
    // totalmente resolvido (contato+lead+oportunidade+atividade automáticos).
    await expect(page.getByText("Vínculo pendente")).toHaveCount(0);
  });

  test("2. envio sem consentimento é bloqueado; registrar consentimento libera", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(conversationUrl);

    await expect(page.getByText("Sem consentimento vigente para WhatsApp", { exact: false })).toBeVisible();

    const composer = page.getByPlaceholder("Escreva uma mensagem (simulada)…");
    await composer.fill("Oi! Recebemos sua mensagem.");
    await page.getByRole("button", { name: "Enviar" }).click();
    // O servidor recusa (consent_required) com uma mensagem tratada — nunca
    // um erro cru, nem a mensagem enviada silenciosamente.
    await expect(page.getByText("Sem consentimento vigente para enviar mensagem por este canal", { exact: false })).toBeVisible();
    // O texto continua no <textarea> (não perde o que foi digitado numa
    // falha) — getByText("...") bate nisso também, então checa a ausência
    // de BOLHA de mensagem (item de lista), não de qualquer ocorrência do
    // texto na página (achado real no CI). A prévia da lista também mostra a
    // frase depois de enviada, por isso o escopo é o histórico de mensagens.
    const thread = page.getByRole("log", { name: "Mensagens da conversa" });
    await expect(thread.getByRole("listitem").filter({ hasText: "Oi! Recebemos sua mensagem." })).toHaveCount(0);

    // O consentimento fica no painel de contexto (gaveta em 1280 px): abre, registra e fecha.
    await openContext(page);
    await page.getByLabel("Finalidade").fill("Atendimento via WhatsApp (teste e2e)");
    await page.getByRole("button", { name: "Registrar consentimento" }).click();
    await expect(page.getByText("Vigente desde", { exact: false })).toBeVisible();
    await closeContext(page);

    // Mesma client_dedupe_key da tentativa anterior (nunca rotacionada
    // porque aquela tentativa falhou sem gravar nada) — precisa gravar
    // normalmente agora que o consentimento existe.
    await composer.fill("Oi! Recebemos sua mensagem.");
    await page.getByRole("button", { name: "Enviar" }).click();
    // Escopado à BOLHA de mensagem de verdade, não a qualquer ocorrência do
    // texto na página — o mesmo texto também ficaria visível se tivesse
    // apenas sobrado no <textarea> de uma falha (achado real de CI).
    await expect(thread.getByRole("listitem").filter({ hasText: "Oi! Recebemos sua mensagem." })).toBeVisible();
    // Enviada pelo CRM: a autoria vem comprovada (nunca "não identificada").
    await expect(thread.getByText("Equipe · pelo CRM")).toBeVisible();
  });

  test("3. simular entregue/lida no simulador reflete na tela", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(conversationUrl);

    await page.getByRole("button", { name: "SIMULAR" }).first().click();
    await page.getByRole("button", { name: "Marcar entregue" }).click();
    await page.getByRole("button", { name: "SIMULAR" }).first().click();
    await page.getByRole("button", { name: "Marcar lida" }).click();

    // A mensagem lida não oferece mais "SIMULAR" (nada a simular depois de lida).
    await expect(page.getByRole("button", { name: "SIMULAR" })).toHaveCount(0);
  });

  test("4. a lista filtra pela situação (inclusive 'Não informado') e busca no servidor", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto("/conversas");

    const list = page.getByRole("region", { name: "Lista de conversas" });
    const filters = list.getByRole("navigation", { name: "Filtrar pela situação do atendimento" });
    await expect(list.getByRole("link", { name: /Contato E2E A7/ })).toBeVisible();

    // Dado sem registro de situação é "Não informado" — nunca "Novo".
    await filters.getByRole("link", { name: /^Não informado/ }).click();
    await expect(page).toHaveURL(/situacao=nao_informado/);
    await expect(list.getByRole("link", { name: /Contato E2E A7/ })).toBeVisible();

    await filters.getByRole("link", { name: /^Novo/ }).click();
    await expect(list.getByText("Nenhuma conversa encontrada")).toBeVisible();
    await list.getByRole("link", { name: "Limpar busca e filtro" }).click();

    await list.getByLabel("Buscar conversa por contato, telefone ou caso").fill("E2E A7");
    await list.getByRole("button", { name: "Buscar" }).click();
    await expect(page).toHaveURL(/q=E2E(\+|%20)A7/);
    await expect(list.getByRole("link", { name: /Contato E2E A7/ })).toBeVisible();

    await list.getByLabel("Buscar conversa por contato, telefone ou caso").fill("nada disto existe");
    await list.getByRole("button", { name: "Buscar" }).click();
    await expect(list.getByText("Nenhuma conversa encontrada")).toBeVisible();
  });

  test("5. dono corrige a situação, pausa e retoma as alterações automáticas (sem mexer no bot)", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(conversationUrl);
    await openContext(page);
    const panel = page.locator("#painel-contexto");

    await expect(panel.getByText("Ainda sem registro de situação")).toBeVisible();
    await expect(panel.getByText("A automação de status ainda não foi ativada", { exact: false })).toBeVisible();
    // "Não informado" é leitura, nunca opção de correção.
    await expect(panel.getByLabel("Corrigir situação").locator("option", { hasText: "Não informado" })).toHaveCount(0);

    await panel.getByLabel("Corrigir situação").selectOption("aguardando_cliente");
    await panel.getByRole("button", { name: "Salvar" }).first().click();
    await expect(panel.getByText("Registrado.", { exact: true }).first()).toBeVisible();
    await expect(panel.getByText("De “Não informado” para “Aguardando o cliente”")).toBeVisible();

    // A lista (servidor) mostra a nova situação.
    await closeContext(page);
    const list = page.getByRole("region", { name: "Lista de conversas" });
    await expect(list.getByRole("link", { name: /Contato E2E A7/ }).getByText("Aguardando o cliente")).toBeVisible();

    await openContext(page);
    await panel.getByRole("button", { name: "Pausar" }).first().click();
    await expect(panel.getByText("Pausadas por", { exact: false }).first()).toBeVisible();
    await expect(panel.getByText("Alterações automáticas de status pausadas")).toBeVisible();
    await panel.getByRole("button", { name: "Retomar" }).first().click();
    await expect(panel.getByText("Liberadas (ainda não ativadas)").first()).toBeVisible();
  });

  test("6. visualizador lê a situação e o histórico, sem nenhum controle de escrita", async ({ page }) => {
    await login(page, SEED_USERS.elisa.email);
    await page.goto(conversationUrl);
    await openContext(page);
    const panel = page.locator("#painel-contexto");

    await expect(panel.getByText("Aguardando o cliente").first()).toBeVisible();
    await expect(panel.getByText("Seu perfil só visualiza a situação do atendimento.")).toBeVisible();
    await expect(panel.getByLabel("Corrigir situação")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Salvar" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Pausar" })).toHaveCount(0);
    await closeContext(page);
    await expect(page.getByPlaceholder("Escreva uma mensagem (simulada)…")).toHaveCount(0);
    await expect(page.getByText("Seu perfil só visualiza as conversas", { exact: false })).toBeVisible();
  });

  test("7. papel sem permissão de simulador não acessa a tela de configuração", async ({ page }) => {
    await login(page, SEED_USERS.elisa.email);

    await page.goto("/configuracoes/simulador-whatsapp");
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  });
});
