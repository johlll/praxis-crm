import { expect, test, type Response } from "@playwright/test";

import { SEED_USERS } from "./fixtures";
import { login } from "./helpers";

/**
 * Jornada da A6 contra o Supabase local do CI. O pgTAP
 * (11_a6_activities.test.sql, 72 asserções) já cobre exaustivamente
 * alcance por registro, coerência de vínculos, concorrência via
 * lock_version, fronteiras de hoje/amanhã/semana/atrasada e a atividade
 * automática por etapa (incluindo o bloqueio por requisito pendente e a
 * ausência de duplicação) — este arquivo foca só no que só um e2e prova
 * de verdade: o fluxo real de UI de ponta a ponta.
 *
 * `test.describe.serial`: os testes reaproveitam o contato/lead criados
 * no teste anterior.
 *
 * Contato criado do zero (não um de SEED_CONTACTS) — achado real no CI:
 * reaproveitar "Carla Ferreira Advocacia" colidia por substring com o
 * "Carla Ferreira" que o teste 3 da A4 (leads.spec.ts) já usa, quebrando
 * um teste PREEXISTENTE que não tem nada a ver com esta fase.
 */
test.describe.serial("atividades e agenda — A6", () => {
  test.use({ timezoneId: "America/Sao_Paulo" });

  const contactName = "Contato Atividades A6 (teste e2e)";
  const leadArea = "Atividades A6 teste e2e";
  let leadUrl: string;

  function tomorrowIso(): string {
    const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }

  function inThreeDaysIso(): string {
    const d = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }

  test("1. criar atividade pela Central de Atividades e concluir", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/contatos/novo");
    await page.getByLabel("Nome", { exact: true }).fill(contactName);
    await page.getByRole("button", { name: "Criar contato" }).click();
    await expect(page).toHaveURL(/\/contatos\/[0-9a-f-]{36}$/);

    await page.goto("/leads/novo");
    await page.getByLabel("Contato").selectOption({ label: contactName });
    await page.getByLabel("Área jurídica").fill(leadArea);
    await page.getByRole("button", { name: "Criar lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
    leadUrl = page.url();

    await page.goto("/atividades");
    await page.getByRole("button", { name: "Nova atividade" }).click();
    await page.getByLabel("Lead", { exact: true }).selectOption({ label: `${contactName} — ${leadArea}` });
    await page.getByLabel("Título", { exact: true }).fill("Ligar pro cliente (teste e2e)");
    await page.getByLabel("Data", { exact: true }).fill(tomorrowIso());
    await page.getByRole("button", { name: "Criar atividade" }).click();
    await expect(page.getByText("Atividade criada")).toBeVisible();
    await page.getByRole("button", { name: "Concluir", exact: true }).click();

    // exact:true — sem isso, o título também casa por substring com o
    // <label class="sr-only"> "Transferir Ligar pro cliente (teste e2e)
    // para" do próprio seletor de responsável da linha (achado real no
    // CI, mesma classe de colisão já documentada na A5).
    await expect(page.getByText("Ligar pro cliente (teste e2e)", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Concluir Ligar pro cliente (teste e2e)" }).click();
    // Some da listagem padrão (status=pending) assim que a Server Action
    // conclui e revalida a rota — sem precisar de reload manual, mesmo
    // padrão já usado (e comprovado) por stage-row.tsx na A5.
    await expect(page.getByText("Ligar pro cliente (teste e2e)", { exact: true })).toHaveCount(0);
  });

  test("2. reagendar e transferir responsável persistem de verdade", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto(leadUrl);
    await page.getByRole("button", { name: "Nova atividade" }).click();
    await page.getByLabel("Título", { exact: true }).fill("Revisar contrato (teste e2e)");
    await page.getByLabel("Data", { exact: true }).fill(tomorrowIso());
    await page.getByRole("button", { name: "Criar atividade" }).click();
    await expect(page.getByText("Atividade criada")).toBeVisible();
    await page.getByRole("button", { name: "Concluir", exact: true }).click();
    await expect(page.getByText("Revisar contrato (teste e2e)", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Reagendar Revisar contrato (teste e2e)" }).click();
    const novaData = inThreeDaysIso();
    await page.getByLabel("Data", { exact: true }).fill(novaData);
    await page.getByRole("button", { name: "Reagendar", exact: true }).click();
    // A ação só fecha o diálogo (onDone) em caso de sucesso — se a RPC
    // tivesse recusado, o Alert de erro apareceria e o diálogo
    // continuaria aberto, o que faria esta espera dar timeout.
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.reload();
    // "YYYY-MM-DD" -> exibido como DD/MM (formato brasileiro, pt-BR) —
    // slice(1) dá [mês, dia]; nomear direito evita inverter a ordem na
    // hora de montar o texto esperado (achado real no CI: a versão
    // anterior desta linha checava "mês/dia" em vez de "dia/mês").
    const [, mes, dia] = novaData.split("-");
    await expect(page.getByText(`${dia}/${mes}`)).toBeVisible();

    // Sem reload explícito aqui de propósito: selectOption() só espera o
    // evento onChange disparar, não a Server Action assíncrona que ele
    // dispara terminar — um reload logo em seguida corre na frente da
    // resposta (mesma classe de corrida já documentada na A5) e cortaria
    // a transferência em voo. O expect com auto-retry do Playwright
    // espera a revalidação automática do Next.js (mesmo padrão já
    // comprovado no teste 1, ao concluir a atividade sem reload manual).
    const responsavelSelect = page.getByLabel("Transferir Revisar contrato (teste e2e) para");
    await responsavelSelect.selectOption({ label: SEED_USERS.ana.fullName });
    await expect(page.getByLabel("Transferir Revisar contrato (teste e2e) para").locator("option:checked")).toHaveText(
      SEED_USERS.ana.fullName,
    );

    // Persistência de verdade (não só estado otimista do cliente): um
    // reload agora, DEPOIS da confirmação acima, deve mostrar o mesmo.
    await page.reload();
    await expect(page.getByLabel("Transferir Revisar contrato (teste e2e) para").locator("option:checked")).toHaveText(
      SEED_USERS.ana.fullName,
    );
  });

  test("3. mover oportunidade para etapa com regra cria atividade automática", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/configuracoes/pipelines");
    // "Configurar" (sem regra ainda) ou "Editar" (se um retry do CI já
    // rodou este teste antes contra o mesmo banco) — o rótulo muda
    // conforme já existe regra ou não; o regex cobre os dois estados.
    await page
      .getByRole("button", { name: /(Configurar|Editar) atividade automática de Qualificar oportunidade/ })
      .click();
    await page.getByLabel("Título", { exact: true }).fill("Enviar proposta inicial (teste e2e)");
    await page.getByRole("button", { name: "Salvar regra" }).click();
    await expect(page.getByText("Regra salva")).toBeVisible();
    await page.getByRole("button", { name: "Concluir", exact: true }).click();

    await page.goto("/leads/novo");
    await page.getByLabel("Contato").selectOption({ label: contactName });
    await page.getByLabel("Área jurídica").fill(`${leadArea} (mover)`);
    await page.getByRole("button", { name: "Criar lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);

    await page.getByRole("button", { name: "Nova oportunidade" }).click();
    await page.getByRole("button", { name: "Criar oportunidade" }).click();
    const link = page.getByRole("link", { name: /Fazer primeiro contato/ });
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    const opportunityUrl = new URL(href!, page.url()).toString();

    await page.goto("/pipeline");
    // requestMove() no pipeline-board dispara DUAS Server Actions em
    // sequência para a mesma /pipeline — checkStageRequirementsAction
    // primeiro (sempre, pra decidir se abre o StageAdvanceDialog) e só
    // depois moveOpportunityStageAction de verdade — indistinguíveis por
    // URL+método. Esperar só UMA resposta pega a checagem, não o
    // movimento, e o goto() seguinte corta o movimento em voo (achado
    // real no CI: DOM snapshot na falha mostrou a oportunidade ainda em
    // "Fazer primeiro contato" mesmo depois de "esperar uma resposta").
    // Como "Qualificar oportunidade" não tem requisito de avanço
    // configurado neste teste, a checagem sempre libera direto pro
    // movimento — são sempre exatamente 2 POSTs, nesta ordem.
    const pipelinePostCount = { n: 0 };
    const countPipelinePost = (response: Response) => {
      if (response.url().endsWith("/pipeline") && response.request().method() === "POST") {
        pipelinePostCount.n += 1;
      }
    };
    page.on("response", countPipelinePost);
    await page.getByLabel(`Mover ${contactName} para etapa`).selectOption({ label: "Qualificar oportunidade" });
    await expect.poll(() => pipelinePostCount.n).toBeGreaterThanOrEqual(2);
    page.off("response", countPipelinePost);
    await expect(page.getByRole("heading", { name: "Qualificar oportunidade" })).toBeVisible();

    await page.goto(opportunityUrl);
    await expect(page.getByText("Etapa")).toBeVisible();
    await expect(page.getByText("Qualificar oportunidade", { exact: true })).toBeVisible();
    await expect(page.getByText("Enviar proposta inicial (teste e2e)", { exact: true })).toBeVisible();
    await expect(page.getByText("Sem próxima ação")).toHaveCount(0);
  });

  test("4. papel sem permissão não vê ações de atividade", async ({ page }) => {
    await login(page, SEED_USERS.elisa.email);

    await page.goto("/atividades");
    await expect(page.getByRole("button", { name: "Nova atividade" })).toHaveCount(0);
  });
});
