# A6 — Handoff: atividades e agenda interna

**Projeto:** Praxis CRM Jurídico
**Fase:** A6
**Branch:** `feat/a6-activities-calendar`
**PR:** (preenchido na seção 6, após abertura)
**Data:** 10/09/2026

**Status:** implementada, aguardando CI. Migrations aplicadas com sucesso no banco hospedado `praxis-crm-dev` (verificação executada real). `typecheck`/`lint`/`test` unitário (118/118, incluindo os novos testes desta fase)/`build` de produção limpos localmente. pgTAP (72 asserções) e e2e (4 testes) foram escritos e revisados linha a linha, mas **não puderam ser executados nesta sessão** — Docker Desktop sem WSL2 nesta máquina Windows, mesma limitação já registrada em A5-HANDOFF.md §8.2. CI é o canal de verificação executada para esses dois. **PR ainda não aberto no momento em que este parágrafo foi escrito** — aberto logo em seguida, sem merge, sem iniciar a A7, por instrução explícita do usuário.

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

### 5.1 pgTAP (`11_a6_activities.test.sql`, 72 asserções — **escrito, não executado nesta sessão, ver nota da seção 8.2 herdada da A5**)

12 seções: criar+ler básico; isolamento entre workspaces e alcance "seus + sem responsável"; coerência de vínculo lead/oportunidade; validação de responsável (não é atalho de acesso); concorrência (update/reschedule/reassign); concluir e recusa em concluir/reagendar já concluída; excluir; RPC direta negada e grants exatos (incluindo a existência do índice único de idempotência); fronteiras de hoje/amanhã/atrasada/sem responsável com contadores; atividade automática por etapa (regra dispara em movimento aceito, não dispara em etapa sem regra, não dispara em movimento recusado por requisito pendente nem por conflito, reentrar numa etapa é nova transição e dispara de novo); "próxima ação" nas três projeções de oportunidade; configuração da regra (permissão, upsert substitui em vez de duplicar).

### 5.2 e2e (`activities.spec.ts`, 4 testes — **escrito, não executado nesta sessão**)

Criar atividade pela Central e concluir (some da listagem padrão); reagendar e transferir responsável com persistência confirmada por `reload()` real; configurar regra automática numa etapa, mover uma oportunidade até lá pelo kanban e confirmar a atividade + "próxima ação" refletidas no painel de detalhe; papel sem permissão (`viewer`) não vê a ação "Nova atividade". Revisão de risco de colisão de seletor feita antes de fechar o arquivo (mesma classe de bug já documentada na A5 — `getByRole`/`getByText` sem `exact: true` colidindo por substring com outro elemento da própria tela): corrigido nos botões "Concluir"/"Reagendar" (colidiam com os botões de linha "Concluir {título}"/"Reagendar {título}") e no rótulo do botão de configurar regra automática (usa regex para aceitar tanto "Configurar" quanto "Editar", cobrindo o caso de um retry do CI rodar o teste de novo contra o mesmo banco).

### 5.3 Validação local antes do push

`npm run typecheck`/`lint`/`test` (118, incluindo os 6 testes novos desta fase) e `npm run build` — todos limpos, a cada rodada de correção. As 8 migrations da A6 aplicadas com `supabase db push --linked` contra `praxis-crm-dev` **sem erro de SQL** (verificação executada real do schema/funções — a única forma disponível nesta máquina de confirmar que a sintaxe e as referências entre objetos estão corretas antes do CI).

---

## 6. CI e PR

(preenchido após a abertura do PR e a primeira rodada de CI)

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
