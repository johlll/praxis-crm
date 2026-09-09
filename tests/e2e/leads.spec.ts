import { expect, test } from "@playwright/test";

import { SEED_CONTACTS, SEED_CPF_RAW, SEED_USERS } from "./fixtures";
import { callRpcDirect, getSupabaseAccessToken, login } from "./helpers";

/**
 * Jornada da A4 contra o Supabase local do CI — mesmas regras da A3:
 * nunca contra o projeto hospedado, sem depender de e-mail. Cobre o que
 * só aparece testando de ponta a ponta: criação/edição com persistência,
 * busca/filtro/paginação no servidor, o payload real que um visualizador
 * recebe (não só o texto visível — DOM, respostas de rede e CPF do
 * contato vinculado), recusa de escrita no SERVIDOR (não só a interface
 * escondendo botão), duas edições concorrentes de verdade, isolamento
 * entre workspaces, e a integração com mesclar/desfazer da A3.
 *
 * Honorários NÃO faz parte do modelo de dados de leads (revisão pós-A4:
 * o plano só coloca valor em `opportunities`, A5) — não há mais campo,
 * tela nem teste de "faixa para atendimento" aqui.
 *
 * `test.describe.serial`: o lead criado no teste 1 é reaproveitado pelos
 * testes seguintes (edição, busca, payload, escrita negada, concorrência).
 */
test.describe.serial("leads — A4", () => {
  let leadUrl: string;

  test("1. criação de lead com persistência, vinculado a um contato existente", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/leads/novo");
    await page.getByLabel("Contato").selectOption({ label: SEED_CONTACTS.carlaFerreira.name });
    await page.getByLabel("Área jurídica").fill("Trabalhista");
    await page.getByLabel("Resumo").fill("Rescisão indireta");
    await page.getByRole("button", { name: "Criar lead" }).click();

    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    leadUrl = page.url();
    await expect(page.getByLabel("Área jurídica")).toHaveValue("Trabalhista");
  });

  test("2. edição básica persiste", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(leadUrl);

    await page.getByLabel("Resumo").fill("Rescisão indireta — audiência marcada");
    await page.getByRole("button", { name: "Salvar" }).click();

    // Sem page.reload(): o Server Action já revalida e reflete o dado
    // novo via re-render do Server Component (mesmo padrão de
    // contacts.spec.ts) — um reload logo depois de editar um <textarea>
    // não controlado disputa com a restauração de formulário do próprio
    // Chrome e pode concatenar o valor antigo ao novo, um falso positivo
    // de bug que não existe na aplicação.
    await expect(page.getByText("Dados salvos.")).toBeVisible();
    await expect(page.getByLabel("Resumo")).toHaveValue("Rescisão indireta — audiência marcada");
  });

  test("3. busca e filtro no servidor encontram o lead certo", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto(`/leads?q=${encodeURIComponent(SEED_CONTACTS.carlaFerreira.name)}`);
    await expect(page.getByRole("link", { name: SEED_CONTACTS.carlaFerreira.name })).toBeVisible();

    // Filtro que não bate com nenhum lead: lista vazia, não erro.
    await page.goto("/leads?priority=baixa");
    await expect(page.getByText("Nenhum lead encontrado")).toBeVisible();
  });

  test("4. visualizador nunca recebe honorários nem CPF — no DOM nem nas respostas de rede", async ({ page }) => {
    await login(page, SEED_USERS.elisa.email);

    // Escuta TODA resposta relevante (navegação e o RSC payload que a
    // sustenta) — checar só page.content() (o DOM final já renderizado)
    // não prova nada sobre o que trafegou na resposta em si; o que
    // importa é o que o servidor efetivamente mandou pro navegador.
    const bodies: string[] = [];
    page.on("response", (response) => {
      const contentType = response.headers()["content-type"] ?? "";
      if (contentType.includes("html") || contentType.includes("json") || contentType.includes("text")) {
        void response
          .text()
          .then((text) => bodies.push(text))
          .catch(() => {
            // Resposta sem corpo utilizável (ex.: redirect) — as demais
            // respostas coletadas já bastam para a asserção.
          });
      }
    });

    await page.goto(leadUrl);
    // A seção de valor não existe mais para NENHUM papel — nem chave
    // ausente condicionalmente: o campo não existe no modelo de dados de
    // leads depois da revisão (ver docs/decisoes/a4-leads.md).
    await expect(page.getByRole("heading", { name: "Valor estimado de honorários" })).not.toBeVisible();

    // "Ver contato" segue o mesmo vínculo que a A3 já protege — o teste
    // reforça que essa proteção continua valendo alcançada a partir do
    // fluxo de leads, usando um contato com CPF fictício CONHECIDO
    // (mesmo contato da criação no teste 1).
    await page.getByRole("link", { name: "Ver contato" }).click();
    await expect(page).toHaveURL(/\/contatos\/[0-9a-f-]{36}$/);

    await page.waitForTimeout(300); // dá tempo das respostas assíncronas acima serem coletadas
    const html = await page.content();
    const cpfDigits = SEED_CPF_RAW.replace(/\D/g, "");

    for (const forbidden of ["7.300,00", "estimated_value", SEED_CPF_RAW, cpfDigits]) {
      expect(html, `HTML final não deve conter "${forbidden}"`).not.toContain(forbidden);
      for (const body of bodies) {
        expect(body, `resposta de rede não deve conter "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });

  test("5. visualizador não edita — recusado pelo SERVIDOR, não só a interface escondendo o botão", async ({
    page,
    request,
  }) => {
    await login(page, SEED_USERS.elisa.email);
    await page.goto(leadUrl);

    // A interface esconde o botão — mas isso sozinho não prova nada sobre
    // o servidor.
    await expect(page.getByRole("button", { name: "Salvar" })).not.toBeVisible();
    await expect(page.getByLabel("Área jurídica")).toHaveValue("Trabalhista");

    // Tentativa REAL de escrita por fora da tela, direto na API do
    // Supabase (mesma sessão da Elisa, token obtido via password grant) —
    // é isso que prova que a recusa não depende da página Next.js.
    const leadId = leadUrl.split("/").pop()!;
    const accessToken = await getSupabaseAccessToken(request, SEED_USERS.elisa.email);
    const attempt = await callRpcDirect(request, accessToken, "update_lead_basic_fields", {
      p_lead_id: leadId,
      p_legal_area: "Escrita direta deveria ser recusada",
      p_summary: null,
      p_tags: [],
      p_priority: "media",
      p_expected_updated_at: new Date().toISOString(),
    });
    expect(attempt.status, JSON.stringify(attempt.body)).toBeGreaterThanOrEqual(400);

    // Dado preservado — a tentativa recusada não mudou nada.
    await page.reload();
    await expect(page.getByLabel("Área jurídica")).toHaveValue("Trabalhista");
  });

  test("6. duas edições concorrentes de verdade: só uma grava, a outra recebe conflito", async ({
    page,
    request,
  }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(leadUrl);

    const leadId = leadUrl.split("/").pop()!;
    // Mesma versão inicial pros dois — o hidden field é exatamente o que
    // o formulário real enviaria (lead.updatedAt), não um valor forjado.
    const expectedUpdatedAt = await page.locator('input[name="expectedUpdatedAt"]').first().inputValue();
    const accessToken = await getSupabaseAccessToken(request, SEED_USERS.ana.email);

    const [first, second] = await Promise.all([
      callRpcDirect(request, accessToken, "update_lead_basic_fields", {
        p_lead_id: leadId,
        p_legal_area: "Trabalhista",
        p_summary: "Vencedor A",
        p_tags: [],
        p_priority: "alta",
        p_expected_updated_at: expectedUpdatedAt,
      }),
      callRpcDirect(request, accessToken, "update_lead_basic_fields", {
        p_lead_id: leadId,
        p_legal_area: "Trabalhista",
        p_summary: "Vencedor B",
        p_tags: [],
        p_priority: "alta",
        p_expected_updated_at: expectedUpdatedAt,
      }),
    ]);

    const results = [first, second];
    const succeeded = results.filter((r) => r.status >= 200 && r.status < 300);
    const failed = results.filter((r) => r.status >= 400);

    // A checagem de versão é atômica (parte do WHERE do próprio UPDATE) —
    // exatamente uma das duas chamadas simultâneas grava, a outra recebe
    // conflito. Sem essa atomicidade (o bug original: SELECT, comparar em
    // PL/pgSQL, só DEPOIS gravar sem condição no WHERE) as duas podiam
    // "vencer" em sequência, a segunda sobrescrevendo a primeira em
    // silêncio.
    expect(succeeded, JSON.stringify(results)).toHaveLength(1);
    expect(failed, JSON.stringify(results)).toHaveLength(1);

    await page.reload();
    const finalSummary = await page.getByLabel("Resumo").inputValue();
    expect(["Vencedor A", "Vencedor B"]).toContain(finalSummary);
  });

  test("7. isolamento entre workspaces — lead de um escritório não existe para outro", async ({ page }) => {
    // Daniel, não Bruno: o e2e da A2 (auth-workspace.spec.ts, mesmo banco
    // local do CI, sem reset entre arquivos) convida e aceita Bruno no
    // Escritório Um mais cedo na mesma execução — ele deixa de ser um
    // "estranho" de verdade a essa altura. Daniel cria só o workspace
    // dele próprio na A2 e nunca ganha acesso ao Escritório Um em
    // nenhum outro teste — achado pelo CI (rerun idêntico confirmou que
    // não era instabilidade, e sim exatamente essa premissa errada).
    await login(page, SEED_USERS.daniel.email);
    await page.goto(leadUrl);

    // notFound() do Next — a página de "não encontrado", nunca o
    // conteúdo do lead de outro workspace.
    await expect(page.getByText(SEED_CONTACTS.carlaFerreira.name)).not.toBeVisible();
  });

  test("8. mesclar contato reparenta o lead para o vencedor escolhido; desfazer restaura ao original", async ({
    page,
  }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/contatos/novo");
    await page.getByLabel("Nome").fill("Lead Merge Um");
    await page.getByLabel("Telefone").fill("11955500011");
    await page.getByRole("button", { name: "Criar contato" }).click();
    // Espera o redirect terminar ANTES de ler page.url() — lido cedo
    // demais, ainda mostraria /contatos/novo (achado pelo CI: o
    // contactId virava a string "novo", pré-selecionando o contato
    // errado no formulário de lead seguinte).
    await expect(page).toHaveURL(/\/contatos\/[0-9a-f-]{36}$/);
    const contactUmUrl = page.url();
    const contactUmId = contactUmUrl.split("/").pop()!;

    await page.goto("/contatos/novo");
    await page.getByLabel("Nome").fill("Lead Merge Dois");
    await page.getByLabel("Telefone").fill("11955500011");
    await page.getByRole("button", { name: "Criar contato" }).click();
    await expect(page).toHaveURL(/\/contatos\/[0-9a-f-]{36}$/);
    const contactDoisUrl = page.url();
    const contactDoisId = contactDoisUrl.split("/").pop()!;

    // O lead pertence a "Lead Merge Dois". O teste escolhe DE PROPÓSITO o
    // outro contato ("Lead Merge Um", que NÃO tem o lead) como vencedor
    // da mesclagem — prova reparentamento de verdade, não uma coincidência
    // de o vencedor já ser o dono original.
    await page.goto(`/leads/novo?contactId=${contactDoisId}`);
    await page.getByLabel("Área jurídica").fill("Cível");
    await page.getByRole("button", { name: "Criar lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    const mergeLeadUrl = page.url();
    await expect(page.getByRole("heading", { name: "Lead Merge Dois" })).toBeVisible();

    await page.goto("/contatos/duplicidades");
    const row = page.getByTestId("duplicate-candidate-row").filter({ hasText: "Lead Merge" });
    await row.getByRole("link", { name: "Comparar" }).click();

    // Seleciona explicitamente "Lead Merge Um" — quem NÃO possui o lead —
    // como o contato a manter.
    await page.getByRole("radio", { name: /Manter Lead Merge Um/ }).check();
    await page.getByRole("button", { name: "Mesclar, mantendo Lead Merge Um" }).click();
    // mergeContactsAction() também faz redirect().
    await expect(page).toHaveURL(/\/contatos\/[0-9a-f-]{36}$/);
    const keptContactUrl = page.url();
    expect(keptContactUrl).toBe(contactUmUrl);

    // Confirma a transferência pelo ID de destino, não só pelo nome no
    // heading (que poderia coincidir por acaso).
    await page.goto(mergeLeadUrl);
    await expect(page.getByRole("heading", { name: "Lead Merge Um" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ver contato" })).toHaveAttribute(
      "href",
      `/contatos/${contactUmId}`,
    );

    await page.goto(keptContactUrl);
    await page.getByRole("button", { name: "Desfazer mesclagem" }).click();
    // unmergeContactAction() não faz redirect — só revalidatePath(). O
    // primeiro reparo (esperar o botão "Desfazer mesclagem" sumir) não
    // bastou: o trace de rede do CI mostrou a navegação seguinte
    // acontecendo 42ms depois do clique, ABORTANDO a própria requisição
    // POST em voo (status -1) — o "sinal" que eu achava que provava a
    // mutação concluída não provava nada. Espera a RESPOSTA de rede da
    // Server Action de verdade, registrada ANTES do clique que a dispara,
    // pra não ter corrida com a resposta chegando rápido demais.
    const undoResponse = page.waitForResponse(
      (response) => response.url() === keptContactUrl && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Confirmar desfazer" }).click();
    await undoResponse;

    // Restaura ao contato ORIGINAL — de novo, confirmado pelo ID.
    await page.goto(mergeLeadUrl);
    await expect(page.getByRole("heading", { name: "Lead Merge Dois" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ver contato" })).toHaveAttribute(
      "href",
      `/contatos/${contactDoisId}`,
    );
  });
});
