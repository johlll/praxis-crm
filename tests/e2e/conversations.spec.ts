import { expect, test, type Page } from "@playwright/test";

import { SEED_USERS } from "./fixtures";
import { login } from "./helpers";

/**
 * Conversas + IA: a tela tem lista, mensagens e o painel do caso (cabeçalho, abas e edição pelo lápis). O painel é a terceira
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
    // Espera a navegação terminar: o formulário de busca carrega o filtro atual em campo oculto e
    // buscar antes disso reaproveitaria o filtro "Novo".
    await expect(page).toHaveURL(/\/conversas$/);
    await expect(list.getByRole("link", { name: /Contato E2E A7/ })).toBeVisible();

    await list.getByLabel("Buscar conversa por contato, telefone ou caso").fill("E2E A7");
    await list.getByRole("button", { name: "Buscar" }).click();
    await expect(page).toHaveURL(/q=E2E(\+|%20)A7/);
    await expect(list.getByRole("link", { name: /Contato E2E A7/ })).toBeVisible();

    await list.getByLabel("Buscar conversa por contato, telefone ou caso").fill("nada disto existe");
    await list.getByRole("button", { name: "Buscar" }).click();
    await expect(list.getByText("Nenhuma conversa encontrada")).toBeVisible();
  });

  test("5. dono corrige a situação pelo lápis, pausa e retoma as alterações automáticas (sem mexer no bot)", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(conversationUrl);
    await openContext(page);
    const panel = page.locator("#painel-contexto");

    // Painel do caso: a consulta não expõe formulários; a edição abre pelo lápis, dentro do painel.
    await expect(panel.getByRole("navigation", { name: "Seções do caso" })).toBeVisible();
    await expect(panel.getByLabel("Corrigir situação")).toHaveCount(0);
    await panel.getByRole("link", { name: "Editar situação e andamento" }).click();
    await expect(page).toHaveURL(/editar=1/);

    await expect(panel.getByText("Ainda sem registro de situação")).toBeVisible();
    await expect(panel.getByText("A automação de status ainda não foi ativada", { exact: false })).toBeVisible();
    // "Não informado" é leitura, nunca opção de correção.
    await expect(panel.getByLabel("Corrigir situação").locator("option", { hasText: "Não informado" })).toHaveCount(0);

    await panel.getByLabel("Corrigir situação").selectOption("aguardando_cliente");
    await panel.getByRole("button", { name: "Salvar" }).first().click();
    await expect(panel.getByText("Registrado.", { exact: true }).first()).toBeVisible();

    await panel.getByRole("button", { name: "Pausar" }).first().click();
    await expect(panel.getByText("Pausadas por", { exact: false }).first()).toBeVisible();
    await panel.getByRole("button", { name: "Retomar" }).first().click();
    await expect(panel.getByText("Liberadas (ainda não ativadas)").first()).toBeVisible();

    // O Histórico (aba) mostra de → para e a pausa, com a origem de cada evento.
    await panel.getByRole("link", { name: "Voltar ao caso" }).click();
    await expect(page).not.toHaveURL(/editar=1/);
    await panel.getByRole("link", { name: /^Histórico/ }).click();
    await expect(page).toHaveURL(/aba=historico/);
    await expect(panel.getByText("De “Não informado” para “Aguardando o cliente”")).toBeVisible();
    await expect(panel.getByText("Alterações automáticas de status pausadas")).toBeVisible();

    // A lista (servidor) mostra a nova situação, identificada como situação do atendimento.
    await closeContext(page);
    const list = page.getByRole("region", { name: "Lista de conversas" });
    await expect(list.getByRole("link", { name: /Contato E2E A7/ }).getByTitle("Situação do atendimento: Aguardando o cliente")).toBeVisible();
  });

  test("6. visualizador lê situação, caso e histórico, sem lápis nem controle de escrita", async ({ page }) => {
    await login(page, SEED_USERS.elisa.email);
    await page.goto(conversationUrl);
    // A situação do atendimento aparece no cabeçalho da conversa, identificada.
    await expect(page.getByTitle("Situação do atendimento: Aguardando o cliente").first()).toBeVisible();
    await openContext(page);
    const panel = page.locator("#painel-contexto");

    await expect(panel.getByRole("link", { name: "Editar situação e andamento" })).toHaveCount(0);
    await panel.getByRole("link", { name: /^Histórico/ }).click();
    await expect(panel.getByText("De “Não informado” para “Aguardando o cliente”")).toBeVisible();
    await expect(panel.getByLabel("Corrigir situação")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Salvar" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Pausar" })).toHaveCount(0);

    // Mesmo com editar=1 no endereço, nada de escrita.
    const editUrl = new URL(conversationUrl);
    editUrl.searchParams.set("editar", "1");
    await page.goto(editUrl.toString());
    await openContext(page);
    await expect(panel.getByLabel("Corrigir situação")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /Salvar|Pausar|Retomar/ })).toHaveCount(0);
    await closeContext(page);
    await expect(page.getByPlaceholder("Escreva uma mensagem (simulada)…")).toHaveCount(0);
    await expect(page.getByText("Seu perfil só visualiza as conversas", { exact: false })).toBeVisible();
  });

  test("7. papel sem permissão de simulador não acessa a tela de configuração", async ({ page }) => {
    await login(page, SEED_USERS.elisa.email);

    await page.goto("/configuracoes/simulador-whatsapp");
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  });

  test("8. número interno só por atribuição explícita (uma vez) e catálogo de serviços só com cópia escolhida", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(conversationUrl);
    await openContext(page);
    const panel = page.locator("#painel-contexto");

    // Caso aberto sem número: nada inventado no Resumo.
    const info = panel.getByRole("region", { name: "Informações do caso" });
    await expect(info.getByText("Não atribuído")).toBeVisible();

    await panel.getByRole("link", { name: "Editar situação e andamento" }).click();
    await expect(page).toHaveURL(/editar=1/);
    const ident = panel.getByRole("region", { name: "Identificação do caso" });
    await ident.getByRole("button", { name: "Atribuir número interno" }).click();
    await ident.getByRole("button", { name: "Confirmar" }).click();
    await expect(ident.getByText("O número não muda.", { exact: false })).toBeVisible();
    await expect(ident.getByRole("button", { name: "Atribuir número interno" })).toHaveCount(0);

    // Cabeçalho do caso e lista mostram o mesmo número.
    await expect(panel.getByRole("heading", { name: /Caso #\d{4}/ })).toBeVisible();
    const number = ((await panel.getByRole("heading", { name: /Caso #\d{4}/ }).textContent()) ?? "").match(/#\d{4,}/)?.[0];
    expect(number).toBeTruthy();
    await closeContext(page);
    const list = page.getByRole("region", { name: "Lista de conversas" });
    await expect(list.getByRole("link", { name: /Contato E2E A7/ }).getByText(new RegExp(`${number} ·`))).toBeVisible();

    // Catálogo: os modelos sugeridos só viram tipo do escritório pela cópia escolhida (e editável).
    await page.goto("/configuracoes/tipos-de-servico");
    await expect(page.getByText("Nenhum tipo de serviço ainda", { exact: false })).toBeVisible();
    const suggestion = page.getByRole("listitem").filter({ hasText: "Consultoria ou parecer" });
    await suggestion.getByRole("button", { name: "Copiar para o catálogo" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Etapa 1", { exact: true })).toHaveValue("Recebimento das informações");
    await dialog.getByLabel("Nome").fill("Consultoria (e2e)");
    await dialog.getByRole("button", { name: "Criar tipo" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Consultoria (e2e)")).toBeVisible();
    await expect(page.getByText("nenhum caso usa agora", { exact: false })).toBeVisible();
  });

  test("9. visualizador não configura o catálogo de tipos de serviço", async ({ page }) => {
    await login(page, SEED_USERS.elisa.email);
    await page.goto("/configuracoes/tipos-de-servico");
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  });

  test("10. observação do caso: escrita pelo lápis, lida no Resumo como texto; visualizador só lê", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(conversationUrl);
    await openContext(page);
    const panel = page.locator("#painel-contexto");
    const card = panel.getByRole("region", { name: "Observações" });
    await expect(card.getByText("Nenhuma observação registrada neste caso.")).toBeVisible();
    await expect(card.getByRole("textbox")).toHaveCount(0);

    await card.getByRole("link", { name: "Escrever" }).click();
    await expect(page).toHaveURL(/editar=1/);
    const section = panel.getByRole("region", { name: "Observações do caso" });
    await expect(section.getByText(/Nova observação para/)).toBeVisible();
    await section.getByRole("textbox").fill("Cliente acompanha pelo WhatsApp.\n<b>sem negrito</b>");
    await section.getByRole("button", { name: "Registrar observação" }).click();
    await expect(section.getByText(/Observação registrada em/)).toBeVisible();
    await expect(section.getByRole("textbox")).toHaveValue("");

    await panel.getByRole("link", { name: "Voltar ao caso" }).click();
    await expect(card.getByText("<b>sem negrito</b>", { exact: false })).toBeVisible();
    await expect(card.locator("b")).toHaveCount(0);
    await expect(card.getByText(/Cliente acompanha pelo WhatsApp\./)).toBeVisible();

    await page.context().clearCookies();
    await login(page, SEED_USERS.elisa.email);
    await page.goto(conversationUrl);
    await openContext(page);
    await expect(card.getByText(/Cliente acompanha pelo WhatsApp\./)).toBeVisible();
    await expect(card.getByRole("link", { name: "Escrever" })).toHaveCount(0);
  });

  test("11. rascunho da observação sobrevive a Voltar/Avançar; resposta perdida não derruba o painel nem duplica", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(conversationUrl);
    await openContext(page);
    const panel = page.locator("#painel-contexto");
    const card = panel.getByRole("region", { name: "Observações" });
    const section = panel.getByRole("region", { name: "Observações do caso" });
    await card.getByRole("link", { name: "Escrever" }).click();
    await expect(page).toHaveURL(/editar=1/);
    const editUrl = page.url();
    await section.getByRole("textbox").fill("Rascunho que sobrevive ao Voltar");

    // Voltar do navegador: a URL volta ao Resumo, o rascunho fica guardado na aba e o Resumo avisa.
    await page.goBack();
    await expect(page).not.toHaveURL(/editar=1/);
    await expect(card.getByRole("status")).toContainText("observação não registrada");
    await page.goForward();
    await expect(page).toHaveURL(editUrl);
    await expect(section.getByRole("textbox")).toHaveValue("Rascunho que sobrevive ao Voltar");
    await expect(section.getByText(/Rascunho recuperado/)).toBeVisible();

    // A resposta da gravação se perde DEPOIS de o servidor gravar: aviso de resultado desconhecido, texto mantido;
    // a nova tentativa reencontra o mesmo pedido ("já estava registrada") e não duplica.
    const text = "Observação com a resposta perdida no caminho";
    let cut = true;
    await page.route("**/conversas/**", async (route) => {
      const req = route.request();
      if (cut && req.method() === "POST" && req.headers()["next-action"] && (req.postData() ?? "").includes(text)) {
        cut = false;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await section.getByRole("textbox").fill(text);
    await section.getByRole("button", { name: "Registrar observação" }).click();
    await expect(section.getByRole("alert")).toContainText("Não foi possível confirmar se a observação foi registrada");
    await expect(section.getByRole("textbox")).toHaveValue(text);
    await expect(section.getByText(/Observação registrada em/)).toHaveCount(0);
    await section.getByRole("button", { name: "Registrar observação" }).click();
    await expect(section.getByText("Esta observação já estava registrada neste caso.")).toBeVisible();
    await page.unroute("**/conversas/**");
    await panel.getByRole("link", { name: "Voltar ao caso" }).click();
    await expect(card.getByText(text, { exact: true })).toHaveCount(1);
  });
});
