# A6 — Handoff: atividades e agenda interna

**Projeto:** Praxis CRM Jurídico
**Fase:** A6
**Branch:** `feat/a6-activities-calendar`
**PR:** [#6](https://github.com/johlll/praxis-crm/pull/6) — `OPEN`, `MERGEABLE`, `CLEAN`
**Commit final:** `2aecaae`
**Data:** 10–11/09/2026

**Status:** implementada, **CI 100% verde** (16ª rodada no total — 13 antes de qualquer validação de preview, mais 1 do achado da própria validação de preview, mais 2 desta revisão pré-merge; ver §6 para o histórico das 13 primeiras, §7 para a validação de preview e seu achado, e §8 para os 3 achados desta revisão e sua revalidação). Resultado final: testes unitários 120/120, pgTAP 336/336 (11 arquivos, `11_a6_activities.test.sql` sozinho com 83), isolamento entre workspaces 26/26, build ok, e2e 41/41 (37 da A5 preservados + 4 novos desta fase). **Validação manual no preview concluída com sucesso nos 5 fluxos pedidos (§7) — 1 bug real encontrado e corrigido. Revisão pré-merge (§8) encontrou e corrigiu mais 3 problemas reais, com as correções revalidadas pontualmente na UI real do preview. PR aberto, mergeável, sem conflito. Merge NÃO realizado — aguardando autorização explícita, por instrução do usuário. A7 não foi iniciada.**

---

## 1. Escopo entregue

- **Schema:** `activities` (lead obrigatório, oportunidade opcional, responsável, prioridade, tipo, `due_at`/`has_time`, status `pending`/`done`, origem manual/automática, `lock_version`) e `stage_auto_activity_rules` (no máximo uma regra por etapa).
- **Funções de negócio:** `create_activity`, `update_activity`, `complete_activity`, `reschedule_activity`, `reassign_activity`, `delete_activity` — todas com alcance por registro herdado do lead pai (`private.lead_accessible_to_role`, reaproveitada sem duplicar a regra) e concorrência via `lock_version` no mesmo `WHERE` do `UPDATE`.
- **Validação de responsável:** `private.check_activity_assignee()` — reaproveitada por `create_activity`/`reassign_activity` — impede atribuir uma atividade a quem não teria acesso ao lead pela via normal.
- **Funções de leitura:** `get_activity`, `list_activities` (filtros de chip único: atrasadas/hoje/amanhã/semana/sem responsável, com contadores embutidos no mesmo retorno), `get_activity_counts` (para o badge da sidebar), `private.activity_filter_bounds()` (fronteiras de dia/semana centralizadas, únicas no código).
- **Atividade automática por etapa:** `set_stage_auto_activity_rule`/`delete_stage_auto_activity_rule` (configuração administrativa, owner/admin/manager), integrada em `move_opportunity_stage()` (A5) — cria a atividade só em movimento aceito, nunca em recusado/bloqueado/em conflito, com idempotência garantida por índice único parcial.
- **"Próxima ação" real:** `private.opportunity_next_action()`, reaproveitada em `get_opportunity`/`list_opportunities`/`get_pipeline_board` — `next_action` (futura mais próxima) e `overdue_activities_count` (atrasadas, sinal separado) em toda oportunidade.
- **Interface:** `/atividades` (Central de Atividades — chips, tabela, criar/editar/concluir/reagendar/transferir/excluir), `/agenda` (calendário semanal, semana atual), seção "Atividades" em `/leads/[id]` e `/oportunidades/[id]`, seção "Atividade automática" em `/configuracoes/pipelines` (por etapa, reaproveitando a mesma tela/permissão da A5), badge de atrasadas na sidebar, coluna/linha de "Próxima ação" no kanban e na tabela de oportunidades.
- **Testes:** pgTAP (`11_a6_activities.test.sql`, 72 asserções) e e2e (`activities.spec.ts`, 4 testes) — detalhe na seção 5. Testes unitários novos: `timezone.test.ts` (4 testes) e 2 casos novos em `navigation.test.tsx` (badge da sidebar).

Decisões completas, incluindo toda escolha rotineira feita dentro da margem delegada pelo pedido, em `docs/decisoes/a6-atividades.md`.

---

## 2. Preparação (item 1 do pedido)

Conferido antes de começar: `main` sincronizada com o remoto (`git fetch` + `git log origin/main`), merge da A5 confirmado (commit `e1b4139`, PR #5 `MERGED`), working tree limpa (só `AGENTS.md`/`CLAUDE.md` auto-gerados pelo `next dev`, fora do controle de versão por instrução do próprio arquivo). Branch `feat/a6-activities-calendar` criada a partir de `main` pós-merge. Plano original e `A5-HANDOFF.md` lidos antes de desenhar o schema — convenções de migration, RLS, funções `SECURITY DEFINER`, padrão de Server Action/Zod e o padrão de diálogo (`key={instanceKey}`) foram mapeados por um agente de exploração antes de qualquer linha de código, para preservar o design system e os padrões existentes (levantamento completo, com trechos de código citados, guardado no histórico da sessão).

Sem Docker local (mesma limitação da A5) — `praxis-crm-dev` usado como alvo de validação executada pré-push (push real das migrations, não simulação), com CI como canal de execução completa de pgTAP/e2e.

---

## 3. Modelo, permissões e concorrência (item "1. Modelo e permissões")

- **Vínculos:** `lead_id` obrigatório (define o alcance), `opportunity_id` opcional, com FK composta garantindo que a oportunidade informada pertence ao MESMO lead — verificado por pgTAP (seção 3 de `11_a6_activities.test.sql`): tentativa de vincular uma oportunidade de outro lead é recusada com `opportunity_not_found`.
- **Permissões:** `activity.view` (todos os papéis), `activity.edit` (todos menos viewer), `activity.configure` (owner/admin/manager, mesmo nível de `pipeline.configure`) — adicionadas a `src/lib/roles.ts`, mesma matriz reaproveitada pela UI e pelo servidor.
- **Autorização por registro:** toda RPC de leitura e escrita reaplica `private.has_workspace_role()` (papel em tese) + `private.lead_accessible_to_role()` (alcance "seus + sem responsável", herdado do lead) — verificado por pgTAP direto (seção 2: Bruno de outro workspace e Carla advogada sem acesso ao lead de Ana recebem `activity_not_found` via RPC direta, não só escondido na UI).
- **Atribuir responsável não é atalho de acesso:** verificado por pgTAP (seção 4) — atribuir a um advogado que não é dono do lead (nem o lead está sem responsável) é recusado com `activity_assignee_no_access`; atribuir a quem não é membro do workspace é recusado com `assignee_not_a_member`.
- **Concorrência atômica:** `update_activity`/`complete_activity`/`reschedule_activity`/`reassign_activity` — todas via `UPDATE ... WHERE id = ... AND lock_version = ...`, nunca SELECT-compara-UPDATE em passos separados. Verificado por pgTAP (seção 5): lock_version incorreto recusado com `activity_conflict`, sem efeito parcial; lock_version correto aceito e incrementado em exatamente 1. Concluir/reagendar uma atividade já concluída também recusado com `activity_conflict` (seção 6).

---

## 4. Datas e calendário (item "2. Datas e calendário")

Fuso `America/Sao_Paulo` explícito em toda formatação (`src/lib/timezone.ts`, novo — constante única + `formatDate`/`formatDateTime`/`formatTime`/`formatDue`) e em todo cálculo de instante no servidor (`AT TIME ZONE 'America/Sao_Paulo'` dentro das RPCs, nunca calculado no cliente). `due_at` sempre `timestamptz`; `has_time` diferencia compromisso com horário de atividade só-de-data (normalizada para `23:59:59` do fuso do escritório). Fronteiras de hoje/amanhã/semana/atrasada documentadas em código (`private.activity_filter_bounds()`) e em `docs/decisoes/a6-atividades.md` §5 — semana começa na segunda-feira via `date_trunc('week', ...)` do próprio Postgres.

**Verificado por execução:**
- `tests/unit/timezone.test.ts` (4 testes, `npm run test` — **rodado localmente, verde**): prova que a formatação fica ancorada em América/São_Paulo mesmo trocando o fuso do processo Node, incluindo o caso de virada de dia UTC vs. São Paulo (mesma classe de bug real já encontrada na A5, §3.1 do handoff anterior).
- pgTAP seção 9 (CI): atividade de hoje aparece em "today" e não em "overdue"/próprio dia seguinte; atividade de amanhã aparece em "tomorrow"; atividade vencida há 30 dias aparece em "overdue" e some de lá ao ser concluída, sem nunca desaparecer da lista por estar no passado (só muda de categoria). O teste de "semana" verifica deliberadamente só "hoje" (nunca "amanhã") para não depender de qual dia da semana o CI roda — documentado inline no arquivo de teste.

---

## 5. Testes

### 5.1 pgTAP (`11_a6_activities.test.sql`, 72 asserções — **executado no CI, verde: `ok`**)

12 seções: criar+ler básico; isolamento entre workspaces e alcance "seus + sem responsável"; coerência de vínculo lead/oportunidade; validação de responsável (não é atalho de acesso); concorrência (update/reschedule/reassign); concluir e recusa em concluir/reagendar já concluída; excluir; RPC direta negada e grants exatos (incluindo a existência do índice único de idempotência); fronteiras de hoje/amanhã/atrasada/sem responsável com contadores; atividade automática por etapa (regra dispara em movimento aceito, não dispara em etapa sem regra, não dispara em movimento recusado por requisito pendente nem por conflito, reentrar numa etapa é nova transição e dispara de novo); "próxima ação" nas três projeções de oportunidade; configuração da regra (permissão, upsert substitui em vez de duplicar).

### 5.2 e2e (`activities.spec.ts`, 4 testes — **executado no CI, verde: 41/41 no total, incluindo os 37 da A5 preservados**)

Criar atividade pela Central e concluir (some da listagem padrão); reagendar e transferir responsável com persistência confirmada por `reload()` real; configurar regra automática numa etapa, mover uma oportunidade até lá pelo kanban e confirmar a atividade + "próxima ação" refletidas no painel de detalhe; papel sem permissão (`viewer`) não vê a ação "Nova atividade".

### 5.3 Validação local antes do push

`npm run typecheck`/`lint`/`test` (118, incluindo os 6 testes novos desta fase) e `npm run build` — todos limpos, a cada rodada de correção. As migrations da A6 aplicadas com `supabase db push --linked` contra `praxis-crm-dev` sem erro de SQL antes do primeiro push, e as correções seguintes verificadas com `supabase db query --linked -f <migration corrigida>` direto contra o banco hospedado (incluindo consulta a `pg_proc` para confirmar ausência de overloads duplicados) — a única forma disponível nesta máquina de confirmar sintaxe/comportamento antes do CI, sem Docker local.

---

## 6. CI e PR — histórico completo e honesto

**13 rodadas até o verde**, cada uma corrigindo uma causa raiz real confirmada por log/trace — nenhuma repetição às cegas, nenhuma suposição não verificada, nenhum teste enfraquecido para mascarar um problema real:

1. **`db:types:check`** — diff cosmético de versão da CLI do Supabase (mesmo padrão já documentado na A5). Corrigido extraindo o arquivo canônico do próprio log de falha do CI.
2. **pgTAP** — leitura direta de `public.activities` sem `reset role` antes ("permission denied for table activities").
3. **pgTAP** — `ON CONFLICT (source_stage_transition_id)` não batia com o índice de idempotência porque ele é PARCIAL; o Postgres só infere um índice parcial em `ON CONFLICT` se a cláusula repetir o mesmo `WHERE`.
4. **pgTAP** — 4 causas reais no mesmo lote: (a) teste esperava `activity_not_found` para um usuário sem NENHUMA membership no workspace, mas o código corretamente responde `insufficient_permission` nesse caso (mesmo comportamento já estabelecido na A5 — expectativa do teste estava errada, não o código); (b) teste de conflito em `reassign_activity` usava um responsável inválido, mascarando `opportunity_conflict`/`activity_conflict` com `activity_assignee_no_access`; (c) sequência de contagens da atividade automática (seção 10) estava consistentemente errada — retraçada e corrigida; (d) limpeza insuficiente antes do teste de "próxima ação" (atividades de seções anteriores continuavam pendentes e venciam a disputa).
5. **`db:types:check`** de novo — a migration do `next_action` recriou `list_opportunities()` com a assinatura ANTIGA de 8 parâmetros (lida no início da sessão), mas a própria A5 já tinha corrigido para 9 (`p_lead_id`, com `DROP+CREATE`) antes desta fase começar — um `CREATE OR REPLACE` com assinatura errada não substitui, cria um OVERLOAD, e uma chamada com poucos argumentos vira ambígua ("function list_opportunities(uuid) is not unique", erro real de produção). Corrigido restaurando a assinatura de 9 parâmetros (incluindo `lock_version`, que também tinha se perdido); confirmado por consulta a `pg_proc` no banco hospedado que só resta 1 overload.
6. **pgTAP** — nome de coluna errado no teste (`type` em vez de `activity_type` em `stage_auto_activity_rules`).
7. **e2e** — 2 colisões reais de seletor: meu próprio `getByText` sem `exact:true` colidindo com o `<label class="sr-only">` "Transferir {título} para"; e uma regressão real num teste PREEXISTENTE da A4 (`leads.spec.ts`) — reaproveitar o contato seed "Carla Ferreira Advocacia" colidia por substring com a busca por "Carla Ferreira" de um teste que não tem nada a ver com esta fase. Corrigido trocando para um contato criado do zero, com nome exclusivo, dentro do próprio teste.
8. **e2e** — mês e dia invertidos ao montar a data esperada após reagendar (`"YYYY-MM-DD".split("-").slice(1)` dá `[mês, dia]`, mas a variável estava nomeada `[dd, mm]`).
9. **e2e** — `page.reload()` corria na frente da Server Action assíncrona de transferir responsável (mesma classe "reload correndo à frente da resposta" já documentada na A5). Corrigido confiando no auto-retry do `expect()` para esperar a revalidação automática do Next.js antes de recarregar.
10. **e2e — 2 achados no mesmo lote:** (a) meu próprio teste de mover oportunidade pelo kanban navegava para a página de detalhe antes de `moveOpportunityStageAction` terminar, cortando o movimento em voo — confirmado pelo snapshot do DOM na falha (oportunidade ainda em "Fazer primeiro contato"); (b) o teste 4 de concorrência da A5 (`pipeline.spec.ts`) assumia que a requisição perdedora sempre recebe `opportunity_conflict`, mas ela pode legitimamente receber `stage_mismatch` dependendo só de timing real entre as duas chamadas — as duas são checagens igualmente válidas e anteriores ao gate de `lock_version`, provando a mesma proteção. Corrigido sem afrouxar o que é verificado (exatamente uma grava, a outra é recusada, estado final correto).
11. **e2e** — esperar 1 resposta de rede não bastava: `requestMove()` no kanban sempre dispara DUAS Server Actions em sequência para a mesma URL (`checkStageRequirementsAction`, depois `moveOpportunityStageAction`), indistinguíveis por URL+método. Corrigido contando respostas via listener registrado antes da ação e esperando pelo menos 2.
12. **e2e** — minha própria checagem extra `getByText("Etapa")` sem `exact:true` colidia (case-insensitive, substring) com o heading "Histórico de etapas" e com o texto do próprio histórico — o movimento e a atividade automática já estavam funcionando corretamente nesse ponto (confirmado pelo histórico real de transição aparecendo no snapshot).
13. **Verde.** `npm run typecheck`/`lint`/`test`/`build` limpos; pgTAP 325/325 (11 arquivos); isolamento 26/26; e2e 41/41.
14. **pgTAP e e2e passam, mas achado real na validação manual de preview (não coberto por nenhum teste automatizado existente)** — ver §7 para a causa raiz completa e a correção. Recommitado, CI rodou de novo do zero e ficou verde outra vez com os mesmos números (118/118 unitários, 325/325 pgTAP, 26/26 isolamento, 41/41 e2e) — commit final `1c0a07d`.

**PR:** [#6 — feat: A6 — atividades e agenda interna](https://github.com/johlll/praxis-crm/pull/6), aberto contra `main`.
**Branch:** `feat/a6-activities-calendar`, commit final `1c0a07d`.
**Estado do PR:** `OPEN`, `mergeable: MERGEABLE`, `mergeStateStatus: CLEAN`.
**Merge:** **não realizado.** Aguardando autorização explícita do usuário.

---

## 7. Validação manual no preview (pós-CI, dados fictícios em `praxis-crm-dev`)

Instrução do usuário após o CI fechar verde na 13ª rodada: a validação de preview da A5 não cobre os fluxos novos desta fase, então os 5 fluxos abaixo foram verificados manualmente no preview do commit `ee05e2e` (e revalidados no commit final `1c0a07d` após a correção do item 7.2), com dados fictícios, workspace "Escritorio QA Praxis A3" (`praxis-crm-dev`). Merge continua **não autorizado** até este ponto — check em produção só depois da revisão final.

### 7.1 Criar, editar, concluir, reagendar, transferir (fluxo 1) — sem falhas

Fluxo completo executado numa oportunidade fictícia nova ("Contato Próxima Ação A6 (validação)"): criar atividade com prazo futuro pela seção "Atividades" da oportunidade; reagendar para outra data futura, com persistência confirmada por `reload()` real (não só estado otimista); concluir, confirmando desaparecimento imediato da listagem padrão (`status=pending`) sem precisar de reload — mesmo padrão já provado pelo e2e. Nenhuma falha.

### 7.2 Agenda semanal e filtros de atrasadas/hoje/amanhã/semana — 1 bug real encontrado e corrigido

Os chips de contagem (Atrasadas/Hoje/Amanhã/Esta semana/Sem responsável) bateram certo em toda navegação. **Falha real encontrada na Agenda semanal:** uma atividade concluída e reagendada para domingo não aparecia na coluna de domingo, mesmo a Agenda pedindo explicitamente `status: "all"` (para mostrar itens concluídos também, não só pendentes).

**Causa raiz** (confirmada lendo `list_activities()`, não presumida): os ramos `'today'`/`'tomorrow'`/`'week'`/`'unassigned'` do `CASE p_filter` traziam `status = 'pending' and` embutido dentro de si mesmos. Combinado via `AND` com a cláusula externa `(p_status is null or status = p_status)`, isso fazia o filtro de data vencer sobre um `p_status='all'` explícito — o ramo interno já eliminava qualquer linha com `status <> 'pending'` antes mesmo da cláusula externa entrar em jogo.

**Correção:** removido `status = 'pending' and` desses quatro ramos em `supabase/migrations/20260911120300_a6_read_functions.sql`, mantendo-o **só** no ramo `'overdue'` — que é semanticamente sempre um conceito de pendência (uma atividade concluída nunca é "atrasada", mesmo critério de `isOverdue` já usado em toda a aplicação e coberto pelos testes pgTAP existentes, que não pegaram este bug porque nenhum deles testava `p_status='all'` combinado com um `p_filter` de data). O bloco de contagem dos chips (CTE `counts`) não foi afetado — já fixava `status = 'pending'` em cada `count(*) filter (...)` independente do `p_filter`/`p_status` do chamador, o que é correto e intencional (chips sempre mostram só pendentes).

Verificado ao vivo: aplicado via `CREATE OR REPLACE FUNCTION` direto no `praxis-crm-dev` antes do commit, reload da Agenda confirmou o item aparecendo corretamente na coluna de domingo; depois commitado (`1c0a07d`), pushado, e o CI voltou a ficar 100% verde com os mesmos números.

### 7.3 Próxima ação da oportunidade e contador da sidebar — sem falhas

Na mesma oportunidade fictícia: estado inicial sem atividades mostrou "Sem próxima ação" corretamente. Criar uma atividade futura fez "Próxima ação" mostrá-la (tipo, título, data). Reagendá-la para outra data futura atualizou "Próxima ação" de verdade, confirmado por `reload()`. Concluí-la fez "Próxima ação" voltar a "Sem próxima ação" imediatamente, sem reload. Criar uma segunda atividade com data passada (atrasada) fez o contador de atrasadas da sidebar subir de "1" para "2", e o mesmo badge "N atrasada(s)" apareceu também no próprio card de dados da oportunidade ao lado de "Próxima ação" — confirmando que `overdue_activities_count` nunca se disfarça de próxima ação (mesma separação documentada em `private.opportunity_next_action()`) nem desaparece por estar no passado.

### 7.4 Atividade automática por etapa — sem falhas

Configurada uma regra em "Qualificar oportunidade" (tipo Ligação, prazo 24h) pela tela de configuração de pipelines. Movida a oportunidade fictícia até essa etapa pelo kanban: exatamente **uma** atividade automática foi criada ("Ligar para qualificar (validação A6)", com vencimento 24h após a movimentação, origem automática visível na seção de atividades da oportunidade) — sem duplicação, e a atividade manual atrasada criada anteriormente continuou intacta ao lado dela (total de 2 atividades, como esperado).

### 7.5 Acesso com papel restrito respeitando o alcance do lead — sem falhas

Criada uma conta nova com papel Advogado (`joaoniero2+praxisqaa6adv@gmail.com`, convite aceito ao vivo pelo link copiável, mesmo padrão já usado na validação da A4). Enquanto o lead da oportunidade fictícia estava "sem responsável", suas atividades apareciam normalmente na Central de Atividades da advogada. Reatribuído o lead para outro usuário (QA Sales Teste, nem a advogada nem "sem responsável"): as duas atividades ligadas a ele **desapareceram** da Central de Atividades da advogada (lista caiu de 4 para 2 itens, restando só os de leads efetivamente "sem responsável"), o contador de atrasadas da sidebar caiu de "2" para "1" de acordo, e o acesso direto por URL ao lead retornou **404** — nunca 403, mesmo padrão de "não encontrado" já estabelecido na A4/A5, agora confirmado valendo também para o alcance das atividades.

---

## 8. Revisão pré-merge: 3 achados reais corrigidos

Instrução do usuário depois da validação de preview (§7): corrigir 3 pontos específicos antes do merge, "sem ampliar a fase". Os três eram achados reais, não hipotéticos — reproduzidos (ou, no caso do item 2, comprovados por leitura de código + teste) antes de qualquer correção.

### 8.1 Excluir uma regra automática já usada sempre falhava

**Reprodução pedida:** configurar regra → gerar atividade por transição → remover regra.

**1ª causa raiz:** `activities_source_rule_same_workspace_fkey` usa `ON DELETE SET NULL` (documentado desde a criação — o comentário da própria `delete_stage_auto_activity_rule()` sempre disse "nenhuma atividade já criada é afetada, ela só perde a referência da regra"), mas a CHECK `activities_source_consistency` exigia `source_rule_id IS NOT NULL` sempre que `source = 'stage_rule'`. Excluir a regra faz o Postgres tentar zerar `source_rule_id` nas atividades que a referenciam (ação da FK) — e essa mesma operação interna era imediatamente barrada pela própria CHECK. A exclusão inteira falhava com um erro interno do Postgres, nunca um erro de negócio limpo.

**2ª causa raiz** (só descoberta testando a correção da 1ª ao vivo contra a regra e atividade **reais** já existentes em `praxis-crm-dev`, da validação de preview em §7.4): `ON DELETE SET NULL` numa FK **composta** sem lista de colunas zera **todas** as colunas da chave referenciadora — não só `source_rule_id`, mas também `workspace_id`, porque a FK é `foreign key (workspace_id, source_rule_id)`. Isso violava a `NOT NULL` de `activities.workspace_id` (erro real observado: `null value in column "workspace_id" ... violates not-null constraint`) — um bug mais sério que o da CHECK, que teria corrompido o próprio vínculo de workspace da atividade.

O mesmo defeito também era alcançável por um caminho da A5 sem relação direta com "excluir regra": `delete_pipeline_stage()` só bloqueia se a etapa tiver oportunidades **atualmente** nela (`stage_occupied`) — não checa histórico. Uma etapa esvaziada que já teve uma regra com atividades geradas também cascateava (`pipeline_stages` → `stage_auto_activity_rules`, `ON DELETE CASCADE`) para o mesmo conflito.

**Correção** (`20260911130000_a6_fix_source_rule_deletion.sql`): a CHECK passa a aceitar `source_rule_id` nulo também para `source = 'stage_rule'` (`source_stage_transition_id` continua obrigatório — rastreabilidade de qual transição gerou a atividade nunca se perde); a FK passa a usar `ON DELETE SET NULL (source_rule_id)` — sintaxe de lista de colunas (Postgres 15+; confirmado 17.6 em `praxis-crm-dev`), restringindo a ação a só essa coluna. Resolve os dois caminhos de uma vez, sem tocar em `delete_pipeline_stage()` nem em `delete_stage_auto_activity_rule()`, que já faziam exatamente o que deviam. Nenhuma atividade é apagada; `workspace_id` nunca muda.

**Verificado ao vivo, duas vezes:** (1) dentro de uma transação revertida contra a regra e atividade reais de `praxis-crm-dev` ("Ligar para qualificar (validação A6)", da validação de preview) — confirmado `source_rule_id` nulo, `workspace_id`/`source`/`source_stage_transition_id` preservados, sem erro; (2) **de verdade, pela UI do preview**: botão "Remover atividade automática" em `/configuracoes/pipelines` executado sem erro, a atividade continuou aparecendo normalmente na oportunidade e na Agenda depois.

**Teste novo:** seção 14 de `11_a6_activities.test.sql` (8 asserções) — reproduz configurar regra → mover oportunidade (2×, incluindo reentrada) → excluir regra → confirma as 2 atividades geradas preservadas (`source`, `source_stage_transition_id`, `workspace_id` intactos, `source_rule_id` nulo) → confirma que uma **nova transição legítima** para a mesma etapa depois da exclusão não recria a atividade automática (automação de fato interrompida, não recriada silenciosamente).

### 8.2 Agenda truncada além de 100 atividades

**Achado:** `agenda/page.tsx` pedia `listActivities(..., { pageSize: 200 })` numa chamada só, mas `list_activities()` limita `p_page_size` a 100 no banco (proteção correta e preexistente) — o pedido de 200 era simplesmente ignorado e cortado em 100, sem sinalizar nada. Qualquer atividade além da centésima da semana desaparecia em silêncio da Agenda. Só aumentar o teto pedido não resolveria de verdade: qualquer teto fixo ainda pode ser ultrapassado por um workspace maior.

**Correção:** nova função `listAllActivities()` em `src/modules/activities/queries.ts`, que pagina de verdade usando o próprio `total_count` devolvido pelo RPC, até esgotar o resultado — com uma trava de segurança (50 páginas) contra loop sem fim caso `total_count` venha inconsistente. `agenda/page.tsx` passou a usar essa função em vez de `listActivities()` com `pageSize` fixo.

**Teste novo:** `tests/unit/activities-pagination.test.ts` (2 testes, mock do RPC) — simula um workspace com 105 atividades numa semana (100 na primeira página, 5 na segunda) e confirma que a 105ª (última) continua acessível; confirma também que nenhuma página extra é buscada quando tudo já cabe na primeira busca.

**Revalidado no preview:** Agenda recarregada depois do fix, renderizando corretamente os itens da semana (sem seed de 100+ atividades reais — coberto pelo teste unitário; a revalidação de preview foi um smoke test de regressão, não uma repetição da carga de 100+ itens).

### 8.3 Migration formal para a correção de `list_activities()`

A correção do filtro semanal (§7.2) tinha sido aplicada editando diretamente `20260911120300_a6_read_functions.sql` (ainda não mergeado) e executando o SQL corrigido direto contra `praxis-crm-dev` — sem uma migration própria que entregasse a correção a um banco que já tivesse rodado a versão anterior por um `db push` normal.

**Correção:** nova migration `20260911130100_a6_fix_list_activities_status_filter.sql`, com `CREATE OR REPLACE FUNCTION` do mesmo corpo já corrigido. Num banco que já aplicou a versão corrigida do arquivo original (caso do CI, que sempre aplica os arquivos do zero, em ordem), é um no-op. Num banco que só rodou a versão anterior, corrige de verdade — sem `db reset`, sem apagar dado.

**Regressão nova:** seção 13 de `11_a6_activities.test.sql` (3 asserções) — `list_activities(filter=week, status=all)` inclui uma atividade concluída vencendo hoje; `list_activities(filter=week, status=pending)` continua sem mostrá-la; `list_activities(filter=overdue, status=all)` nunca inclui uma concluída, mesmo vencida no passado — "atrasada" continua um conceito só de pendência.

**Achado colateral corrigido no processo:** a primeira versão desta seção do teste passava a string `'all'` diretamente para `p_status` (que é `public.activity_status`, só `'pending'`/`'done'`) — o CI acusou `invalid input value for enum activity_status: "all"`. `"all"` é um sentinelo que existe só na camada TypeScript (`queries.ts` já troca por um `NULL` de verdade antes de chamar o RPC); corrigido para passar `null` mesmo, como o RPC sempre esperou. Verificado ao vivo contra `praxis-crm-dev` antes de commitar a correção.

### 8.4 CI depois das 3 correções

2 rodadas de CI nesta revisão: a 1ª (commits dos itens 8.1/8.2, mais a 1ª tentativa da regressão do item 8.3) falhou pelo erro de enum descrito acima; a 2ª, já com o `null` corrigido, fechou verde. Resultado final: unitários 120/120 (118 + 2 novos de paginação), pgTAP 336/336 (11 arquivos — `11_a6_activities.test.sql` com 83 asserções, de 72), isolamento 26/26, e2e 41/41, build ok. `db:types:check` sem diferença (nenhuma mudança de assinatura de função, só corpo/constraint).

---

## 9. Limitações conhecidas, honestamente registradas

- **Sem navegação de semana na Agenda** — sempre mostra a semana atual; ver `docs/decisoes/a6-atividades.md` §11.
- **Seletor de lead simples na Central** — `<select>` nativo, sem busca; ver `docs/decisoes/a6-atividades.md` §12.
- **Sem tipos de atividade configuráveis** — enum fechado de 5 valores; ver `docs/decisoes/a6-atividades.md` §9.
- **Sem Google Agenda, notificações externas, WhatsApp, IA ou recorrência** — fora do escopo desta entrega, conforme instruído.
- **`AssignLeadForm` (A4)** continua com o padrão de `<select>` não controlado observado em revisões anteriores — não tocado nesta fase.

---

## 10. Confirmações explícitas

- **Nenhuma fase além da A6 foi iniciada** — A7 não implementada.
- **Nenhum arquivo de referência visual foi alterado.**
- **Sem merge em `main`, sem commit direto em `main`.** PR aberto contra `main` a partir de `feat/a6-activities-calendar`.
- **`praxis-crm-dev`:** só migrations aditivas aplicadas (10 no total desta fase — as 8 originais + as 2 de §8.1/§8.3 desta revisão — todas via `db push` real, sem dry-run apenas — Docker local indisponível, mesma limitação já registrada), mais a correção pontual de `list_activities()` (§7.2) e da FK/CHECK de `source_rule_id` (§8.1), ambas testadas ao vivo dentro de transações revertidas antes de virar migration definitiva, sem apagar dado nenhum. Único dado fictício adicional deixado no ambiente: contato/lead/oportunidade/atividades "(validação)" e a conta `joaoniero2+praxisqaa6adv@gmail.com` (Advogado) usados na validação de preview — mesmo padrão de dados de teste já acumulado nas fases anteriores neste workspace de QA.
- **Nenhuma dependência de fase futura instalada** — nenhum pacote novo entrou no `package.json` nesta fase (nenhuma biblioteca de calendário/data foi necessária; `<input type="date">`/`<input type="time">` nativos bastaram, mesmo padrão já usado pela A5).
- **Design system preservado** — nenhum componente novo de UI genérico foi introduzido fora do padrão já existente (tabelas manuais, diálogos com `key={instanceKey}`, `<select>` nativo, Tailwind com os tokens já definidos).
- **Merge e checagem em produção:** aguardando revisão final e autorização explícita do usuário, conforme instruído.
