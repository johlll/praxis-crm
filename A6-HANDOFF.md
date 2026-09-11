# A6 — Handoff: atividades e agenda interna

**Projeto:** Praxis CRM Jurídico
**Fase:** A6
**Branch:** `feat/a6-activities-calendar`
**PR:** [#6](https://github.com/johlll/praxis-crm/pull/6) — `OPEN`, `MERGEABLE`, `CLEAN`
**Commit final:** `e883f6d`
**Data:** 10–11/09/2026

**Status:** implementada, **CI 100% verde** (13ª rodada, ver §6 para o histórico completo e honesto das 12 rodadas anteriores — cada uma corrigindo uma causa raiz real, nenhuma repetição às cegas). Resultado final: testes unitários 118/118, pgTAP 325/325 (11 arquivos, `11_a6_activities.test.sql` sozinho com 72), isolamento entre workspaces 26/26, build ok, e2e 41/41 (37 da A5 preservados + 4 novos desta fase). **PR aberto, mergeável, sem conflito. Merge NÃO realizado — aguardando autorização explícita, por instrução do usuário. A7 não foi iniciada.**

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

**PR:** [#6 — feat: A6 — atividades e agenda interna](https://github.com/johlll/praxis-crm/pull/6), aberto contra `main`.
**Branch:** `feat/a6-activities-calendar`, commit final `e883f6d`.
**Estado do PR:** `OPEN`, `mergeable: MERGEABLE`, `mergeStateStatus: CLEAN`.
**Merge:** **não realizado.** Aguardando autorização explícita do usuário.

---

## 7. Limitações conhecidas, honestamente registradas

- **Sem navegação de semana na Agenda** — sempre mostra a semana atual; ver `docs/decisoes/a6-atividades.md` §11.
- **Seletor de lead simples na Central** — `<select>` nativo, sem busca; ver `docs/decisoes/a6-atividades.md` §12.
- **Sem tipos de atividade configuráveis** — enum fechado de 5 valores; ver `docs/decisoes/a6-atividades.md` §9.
- **Sem Google Agenda, notificações externas, WhatsApp, IA ou recorrência** — fora do escopo desta entrega, conforme instruído.
- **`AssignLeadForm` (A4)** continua com o padrão de `<select>` não controlado observado em revisões anteriores — não tocado nesta fase.

---

## 8. Confirmações explícitas

- **Nenhuma fase além da A6 foi iniciada** — A7 não implementada.
- **Nenhum arquivo de referência visual foi alterado.**
- **Sem merge em `main`, sem commit direto em `main`.** PR aberto contra `main` a partir de `feat/a6-activities-calendar`.
- **`praxis-crm-dev`:** só migrations aditivas aplicadas (todas as 8 desta fase, `db push` real, sem dry-run apenas — Docker local indisponível, mesma limitação já registrada). Nenhum dado apagado.
- **Nenhuma dependência de fase futura instalada** — nenhum pacote novo entrou no `package.json` nesta fase (nenhuma biblioteca de calendário/data foi necessária; `<input type="date">`/`<input type="time">` nativos bastaram, mesmo padrão já usado pela A5).
- **Design system preservado** — nenhum componente novo de UI genérico foi introduzido fora do padrão já existente (tabelas manuais, diálogos com `key={instanceKey}`, `<select>` nativo, Tailwind com os tokens já definidos).
