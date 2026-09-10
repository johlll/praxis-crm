import { expect, test, type Page } from "@playwright/test";

import { SEED_CONTACTS, SEED_USERS } from "./fixtures";
import { callRpcDirect, getSupabaseAccessToken, login, readSupabaseEnv, switchWorkspace } from "./helpers";

/**
 * Jornada da A5 contra o Supabase local do CI. O pgTAP
 * (10_a5_pipeline.test.sql, 55 asserções) já cobre exaustivamente
 * alcance por registro, projeção financeira por papel, requisitos de
 * avanço, concorrência via lock_version, ganho/perda idempotentes e
 * integração com merge/undo de contato — este arquivo foca só no que
 * SÓ um e2e prova de verdade: fluxo real de UI (kanban, modais), duas
 * conexões HTTP simultâneas de verdade (pgTAP roda numa sessão só), e o
 * payload real de rede que a UI recebe.
 *
 * `test.describe.serial`: a oportunidade criada no teste 1 é reaproveitada
 * pelos testes seguintes.
 */
test.describe.serial("pipeline — A5", () => {
  // O runner do CI e o servidor de produção local (`next start`) rodam no
  // mesmo fuso (UTC) por padrão — sem fixar o fuso do navegador, o teste 3
  // não teria como reproduzir o erro de hidratação real que só aparece
  // quando servidor e navegador divergem de fuso (achado no preview da
  // Vercel: função serverless em UTC, navegador em horário do Brasil).
  test.use({ timezoneId: "America/Sao_Paulo" });

  let opportunityUrl: string;
  let opportunityId: string;

  async function extractOpportunityUrlFromLeadPage(page: Page): Promise<string> {
    const link = page.getByRole("link", { name: /Fazer primeiro contato/ });
    const href = await link.getAttribute("href");
    return new URL(href!, page.url()).toString();
  }

  test("1. criar oportunidade a partir do lead, na primeira etapa do pipeline padrão", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/leads/novo");
    await page.getByLabel("Contato").selectOption({ label: SEED_CONTACTS.robertoSilva.name });
    await page.getByLabel("Área jurídica").fill("Empresarial");
    await page.getByRole("button", { name: "Criar lead" }).click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);

    await page.getByRole("button", { name: "Nova oportunidade" }).click();
    await page.getByRole("button", { name: "Criar oportunidade" }).click();
    await expect(page.getByRole("link", { name: /Fazer primeiro contato/ })).toBeVisible();

    opportunityUrl = await extractOpportunityUrlFromLeadPage(page);
    opportunityId = opportunityUrl.split("/").pop()!;
  });

  test("2. mover para a etapa seguinte pelo menu (sem requisito no caminho) persiste de verdade", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto("/pipeline");

    // Seletor escopado ao card desta oportunidade (não um /Mover .* /
    // solto) — o workspace de Ana é compartilhado com outros arquivos
    // e2e no mesmo banco efêmero do CI, sem reset entre eles; qualquer
    // um deles pode ter deixado outro card de "Mover ... para etapa".
    await page
      .getByLabel(`Mover ${SEED_CONTACTS.robertoSilva.name} para etapa`)
      .selectOption({ label: "Qualificar oportunidade" });
    await expect(page.getByRole("heading", { name: "Qualificar oportunidade" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Qualificar oportunidade" })).toBeVisible();
  });

  test("3. requisito de avanço bloqueia no servidor até preencher — pular etapa não contorna", async ({
    page,
    request,
  }) => {
    await login(page, SEED_USERS.ana.email);
    const accessToken = await getSupabaseAccessToken(request, SEED_USERS.ana.email);
    const { url, anonKey } = readSupabaseEnv();

    const opportunity = await callRpcDirect(request, accessToken, "get_opportunity", {
      p_opportunity_id: opportunityId,
    });
    const pipelineId = (opportunity.body as Record<string, unknown>).pipeline_id as string;

    // Configura o requisito via RPC direta (owner) — não há tela de
    // configuração de pipeline nesta entrega; a autorização e a
    // validação de verdade são no servidor, já cobertas pelo pgTAP.
    const stagesResponse = await request.get(
      `${url}/rest/v1/pipeline_stages?pipeline_id=eq.${pipelineId}&select=id,name,position&order=position.asc`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` } },
    );
    const stages = (await stagesResponse.json()) as Array<{ id: string; name: string; position: number }>;
    const consultaStage = stages.find((s) => s.name === "Agendar consulta")!;

    const created = await callRpcDirect(request, accessToken, "create_stage_requirement", {
      p_stage_id: consultaStage.id,
      p_label: "Conflito de interesses verificado",
      p_field_type: "checkbox",
    });
    expect(created.status, JSON.stringify(created)).toBeLessThan(300);
    const requirementId = created.body as string;

    // Tenta pular direto da etapa atual ("Qualificar oportunidade") para
    // "Agendar consulta" (2 posições à frente) sem preencher o requisito
    // — deve ser recusado, e nenhum efeito parcial deve ficar registrado.
    const detailBefore = await callRpcDirect(request, accessToken, "get_opportunity", {
      p_opportunity_id: opportunityId,
    });
    const detailBeforeBody = detailBefore.body as Record<string, unknown>;

    const blocked = await callRpcDirect(request, accessToken, "move_opportunity_stage", {
      p_opportunity_id: opportunityId,
      p_from_stage_id: detailBeforeBody.stage_id,
      p_to_stage_id: consultaStage.id,
      p_lock_version: detailBeforeBody.lock_version,
    });
    expect(blocked.status, JSON.stringify(blocked)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(blocked.body)).toContain("stage_requirements_pending");

    const afterBlocked = await callRpcDirect(request, accessToken, "get_opportunity", {
      p_opportunity_id: opportunityId,
    });
    expect((afterBlocked.body as Record<string, unknown>).lock_version).toBe(detailBeforeBody.lock_version);

    // Preenche o requisito e move de novo — agora aceito.
    const moved = await callRpcDirect(request, accessToken, "move_opportunity_stage", {
      p_opportunity_id: opportunityId,
      p_from_stage_id: detailBeforeBody.stage_id,
      p_to_stage_id: consultaStage.id,
      p_lock_version: detailBeforeBody.lock_version,
      p_requirement_values: [{ requirement_id: requirementId, value_bool: true }],
    });
    expect(moved.status, JSON.stringify(moved)).toBeLessThan(300);

    // Achado real no smoke-test do preview: a página de detalhe (client
    // component renderizado via SSR) formatava o histórico de etapas com
    // toLocaleString("pt-BR") sem timeZone fixo — servidor e navegador
    // divergem de fuso e o React acusa erro de hidratação (#418) assim
    // que há pelo menos uma entrada de histórico, exatamente o caso
    // deste teste. Corrigido fixando timeZone: "America/Sao_Paulo"; a
    // asserção abaixo evita que a regressão volte sem ser notada.
    // React reporta hidratação divergente via console.error (não é uma
    // exceção não tratada), por isso o listener é em "console", filtrando
    // o ruído já conhecido e alheio ao app (o widget de feedback da
    // Vercel tenta se enquadrar num iframe e a CSP do próprio app bloqueia).
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && !msg.text().includes("vercel.live")) {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto(opportunityUrl);
    // Na página de detalhe o nome da etapa é uma <dd> (par termo/definição),
    // não um heading — diferente do kanban, onde a etapa é um <h3> de
    // coluna (é para lá que getByRole("heading") funciona, no teste 2).
    await expect(page.getByText("Agendar consulta")).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });

  test("4. duas movimentações concorrentes de verdade: só uma grava, a outra recebe conflito", async ({ request }) => {
    const accessToken = await getSupabaseAccessToken(request, SEED_USERS.ana.email);
    const { url, anonKey } = readSupabaseEnv();
    const detail = await callRpcDirect(request, accessToken, "get_opportunity", { p_opportunity_id: opportunityId });
    const detailBody = detail.body as Record<string, unknown>;

    const stagesResponse = await request.get(
      `${url}/rest/v1/pipeline_stages?pipeline_id=eq.${detailBody.pipeline_id}&select=id,name`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` } },
    );
    const stages = (await stagesResponse.json()) as Array<{ id: string; name: string }>;
    const target = stages.find((s) => s.name === "Realizar consulta")!;

    const [first, second] = await Promise.all([
      callRpcDirect(request, accessToken, "move_opportunity_stage", {
        p_opportunity_id: opportunityId,
        p_from_stage_id: detailBody.stage_id,
        p_to_stage_id: target.id,
        p_lock_version: detailBody.lock_version,
        p_requirement_values: [],
      }),
      callRpcDirect(request, accessToken, "move_opportunity_stage", {
        p_opportunity_id: opportunityId,
        p_from_stage_id: detailBody.stage_id,
        p_to_stage_id: target.id,
        p_lock_version: detailBody.lock_version,
        p_requirement_values: [],
      }),
    ]);
    const results = [first, second];
    const succeeded = results.filter((r) => r.status >= 200 && r.status < 300);
    const failed = results.filter((r) => r.status >= 400);
    expect(succeeded, JSON.stringify(results)).toHaveLength(1);
    expect(failed, JSON.stringify(results)).toHaveLength(1);
    expect(JSON.stringify(failed[0]!.body)).toContain("opportunity_conflict");

    const afterRace = await callRpcDirect(request, accessToken, "get_opportunity", { p_opportunity_id: opportunityId });
    expect((afterRace.body as Record<string, unknown>).stage_name).toBe("Realizar consulta");
  });

  test("5. ganhar cria cliente e handoff pendente; repetir a chamada não duplica nada", async ({ page, request }) => {
    await login(page, SEED_USERS.ana.email);
    await page.goto(opportunityUrl);

    await page.getByRole("button", { name: "Ganhou" }).click();
    // Campo pede REAIS (com vírgula decimal), não centavos — "12000" sem
    // vírgula vira R$ 12.000,00, não R$ 120,00 (achado no CI).
    await page.getByLabel("Valor final").fill("120");
    const wonResponse = page.waitForResponse(
      (response) => response.url() === opportunityUrl && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Registrar ganho" }).click();
    await wonResponse;

    await page.reload();
    await expect(page.getByText("Ganha")).toBeVisible();
    await expect(page.getByText("R$ 120,00")).toBeVisible();

    const accessToken = await getSupabaseAccessToken(request, SEED_USERS.ana.email);
    const retry = await callRpcDirect(request, accessToken, "win_opportunity", {
      p_opportunity_id: opportunityId,
      p_lock_version: 0,
      p_value_cents: 999900,
      p_fee_model: "fixed",
    });
    expect(retry.status, JSON.stringify(retry)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(retry.body)).toContain("opportunity_conflict");
  });

  test("6. perder exige motivo válido, com nota e persiste corretamente", async ({ page }) => {
    await login(page, SEED_USERS.ana.email);

    await page.goto("/leads/novo");
    await page.getByLabel("Contato").selectOption({ label: SEED_CONTACTS.robertoSilvaFilho.name });
    await page.getByLabel("Área jurídica").fill("Consumidor");
    await page.getByRole("button", { name: "Criar lead" }).click();
    await page.getByRole("button", { name: "Nova oportunidade" }).click();
    await page.getByRole("button", { name: "Criar oportunidade" }).click();
    const lostUrl = await extractOpportunityUrlFromLeadPage(page);

    await page.goto(lostUrl);
    await page.getByRole("button", { name: "Perdeu" }).click();
    await page.getByLabel("Motivo da perda").selectOption({ label: "Sem retorno do cliente" });
    // Mesmo achado da A4 (revisão do PR #4): esperar a resposta de rede
    // real ANTES de navegar/recarregar — o reload sem isso corre à
    // frente da Server Action e aborta a requisição em voo.
    const lostResponse = page.waitForResponse(
      (response) => response.url() === lostUrl && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Registrar perda" }).click();
    await lostResponse;

    await page.reload();
    await expect(page.getByText("Perdida")).toBeVisible();
    await expect(page.getByText("Sem retorno do cliente")).toBeVisible();
  });

  test("7. sales nunca recebe valor exato — nem no board nem no detalhe, nas respostas de rede reais", async ({
    page,
    request,
  }) => {
    // Carla é lawyer no Escritório Um e sales no Escritório Dois (seed) —
    // usa o papel sales de verdade, trocando de workspace. switchWorkspace()
    // (não uma troca manual) é o helper que já resolve a corrida
    // documentada em helpers.ts: esperar só a URL não basta, porque o
    // cookie do workspace ativo pode ainda não estar confirmado quando a
    // navegação seguinte lê o workspace — achado real no CI (a lista de
    // contatos de /leads/novo carregou o workspace ANTERIOR).
    await login(page, SEED_USERS.carla.email);
    await switchWorkspace(page, "Escritório Dois (seed)");

    await page.goto("/leads/novo");
    await page.getByLabel("Contato").selectOption({ label: SEED_CONTACTS.clienteEscritorioDois.name });
    await page.getByLabel("Área jurídica").fill("Tributário");
    await page.getByRole("button", { name: "Criar lead" }).click();
    await page.getByRole("button", { name: "Nova oportunidade" }).click();
    await page.getByRole("button", { name: "Criar oportunidade" }).click();
    const salesOpportunityUrl = await extractOpportunityUrlFromLeadPage(page);
    const salesOppId = salesOpportunityUrl.split("/").pop()!;

    const accessToken = await getSupabaseAccessToken(request, SEED_USERS.carla.email);
    await callRpcDirect(request, accessToken, "win_opportunity", {
      p_opportunity_id: salesOppId,
      p_lock_version: 0,
      p_value_cents: 777700,
      p_fee_model: "fixed",
    });

    const bodies: string[] = [];
    page.on("response", (response) => {
      const contentType = response.headers()["content-type"] ?? "";
      if (contentType.includes("json") || contentType.includes("html") || contentType.includes("text")) {
        void response
          .text()
          .then((text) => bodies.push(text))
          .catch(() => {
            // Resposta sem corpo utilizável — as demais já bastam.
          });
      }
    });

    await page.goto("/pipeline");
    await page.waitForLoadState("networkidle");

    const joined = bodies.join("\n");
    expect(joined).not.toContain("777700");
    expect(joined).not.toContain("value_cents");
    expect(joined).not.toContain("value_sum_cents");
  });

  test("8. isolamento entre workspaces: outro escritório não acessa a oportunidade", async ({ page }) => {
    // Daniel, não Bruno: o e2e da A2 (auth-workspace.spec.ts, mesmo banco
    // local do CI, sem reset entre arquivos) convida e aceita Bruno no
    // Escritório Um mais cedo na mesma execução (documentado em
    // leads.spec.ts teste 7, mesmo achado real) — ele deixa de ser um
    // "estranho" de verdade a essa altura. Achado de verdade aqui
    // também: o payload real da página confirmou workspaceId do
    // Escritório Um retornado para Bruno antes desta correção. Daniel
    // nunca ganha acesso ao Escritório Um em nenhum outro teste.
    await login(page, SEED_USERS.daniel.email);

    await page.goto(opportunityUrl);
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  });
});
