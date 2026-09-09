# A5 — Handoff: pipeline e oportunidades

**Projeto:** Praxis CRM Jurídico
**Fase:** A5
**Branch:** `feat/a5-pipeline`
**PR:** (aberto nesta sessão — ver seção 6)
**Data:** 10/09/2026

**Status:** implementada, validada localmente (typecheck/lint/build/
testes unitários limpos, smoke-test manual completo contra o banco
hospedado), aguardando CI e validação no preview antes de qualquer
merge. **A5 não foi mergeada. A6/A8 não foram iniciadas.**

---

## 1. Escopo entregue

- **Schema:** `pipelines`, `pipeline_stages`, `stage_requirements`,
  `opportunity_requirement_values`, `lost_reasons`, `opportunities`,
  `stage_transitions`, e a fundação mínima `clients`/`client_handoffs`
  (antecipação aprovada da A8, só o necessário para o aceite de ganho).
- **Funções de negócio:** `create_opportunity`, `move_opportunity_stage`
  (com bloqueio de requisitos, concorrência atômica e histórico na
  mesma transação), `win_opportunity`, `lose_opportunity`, e as de
  leitura `get_opportunity`, `get_stage_requirements_status`,
  `list_opportunities`, `get_pipeline_board` — todas com projeção
  financeira por papel e alcance por registro herdado do lead pai.
- **Configuração de pipeline (servidor, sem tela ainda):**
  `create_pipeline_stage`, `update_pipeline_stage`,
  `reorder_pipeline_stages`, `delete_pipeline_stage`,
  `create_stage_requirement`, `delete_stage_requirement`,
  `create_lost_reason`, `deactivate_lost_reason`.
- **Interface:** `/pipeline` (kanban com dnd-kit + visão tabela, toggle
  por query param), `/oportunidades/[id]` (detalhe, histórico, ganhar/
  perder), seção "Oportunidades" na página do lead (criar oportunidade).
- **Testes:** pgTAP (`10_a5_pipeline.test.sql`, 55 asserções) e e2e
  (`pipeline.spec.ts`, 8 testes) — detalhe na seção 5.

Decisões completas em `docs/decisoes/a5-pipeline.md`.

---

## 2. Achados corrigidos durante a implementação

Nenhum encontrado pelo CI ainda (aguardando a primeira rodada) — estes
foram encontrados e corrigidos durante o desenvolvimento local, contra
o banco hospedado `praxis-crm-dev`, antes do primeiro push ao CI:

1. **FK composta sem constraint única correspondente.** `pipeline_stages`
   só tinha `UNIQUE(pipeline_id, id)`; `stage_requirements` referencia
   por `(workspace_id, stage_id)`, exigindo também
   `UNIQUE(workspace_id, id)` em `pipeline_stages`. O mesmo faltava em
   `lost_reasons`, `opportunities`, `stage_requirements` e `clients`.
   Erro real do Postgres (`there is no unique constraint matching given
   keys`) no primeiro `db push` — corrigido antes de qualquer commit.
2. **GRANT de tabela faltante.** Desde a correção da A3
   (`20260908050700`), toda tabela nova já nasce sem nenhum privilégio
   padrão para `anon`/`authenticated`. As 4 tabelas de configuração com
   RLS aberta (`pipelines`, `pipeline_stages`, `stage_requirements`,
   `lost_reasons`) tinham a *policy* de SELECT, mas faltava o `GRANT
   SELECT` na tabela em si — sem ele, o Postgres nem chega a avaliar a
   RLS (`permission denied for table`, 42501). Achado no smoke-test
   manual (tela "Nenhum pipeline configurado" mesmo com o pipeline
   existindo) — migration de correção `20260910120600`.
3. **`sum(bigint)` retorna `numeric`, não `bigint`.**
   `get_pipeline_board()` somava `o.value_cents` (bigint) e passava o
   resultado para `private.opportunity_column_sum_projection()`, que só
   aceita `bigint` — Postgres soma bigint como `numeric` por padrão,
   causando `function ... does not exist` (a chamada nem casava com
   nenhuma sobrecarga). Achado ao testar o kanban com uma oportunidade
   de valor definido (o board simplesmente não mostrava nenhum card,
   sem erro visível na tela — o erro real só apareceu simulando a
   chamada RPC direto via SQL). Corrigido com cast explícito
   (`::bigint`) — migration `20260910120700`.

Todas as três foram corrigidas **antes** do primeiro commit desta fase
(rascunho local, nunca chegou a um push/CI com o bug) — por isso as
migrations de correção (`120500`–`120700`) coexistem com os arquivos
originais já corrigidos: quando a mudança era de corpo de função
(`CREATE OR REPLACE`), o arquivo original já está no estado final;
quando era mudança de assinatura (`list_opportunities` ganhando
`p_lead_id`) ou GRANT novo, a correção ficou isolada em sua própria
migration, no mesmo espírito das correções da A4 — nenhuma migration já
aplicada foi reescrita depois de aplicada.

---

## 3. Smoke-test manual contra `praxis-crm-dev` (antes do CI)

`playwright-cli` contra `next dev` local, mesmo `.env.local` que aponta
para o projeto hospedado — sem depender do preview da Vercel. Conta QA
`joaoniero2+praxisqaa3@gmail.com` (Proprietário, "Escritorio QA Praxis
A3").

| Fluxo | Resultado |
|---|---|
| Criar oportunidade a partir de um lead | OK — nasce na primeira etapa do pipeline padrão |
| Mover etapa pelo menu (sem arrastar) | OK — persistido, confirmado com `page.reload()` real |
| Ganhar (modal, valor R$ 5.500,00) | OK — status `won`, cliente criado (`ativo`), handoff criado (`pendente`) — confirmado por consulta direta ao banco |
| Perder (modal, motivo obrigatório) | OK — status `lost`, motivo persistido |
| Visão tabela | OK — mostra status, valor formatado, etapa |
| Detalhe da oportunidade | OK — valor, histórico de etapas |

Dados fictícios deixados no ambiente de demonstração (não removidos,
mesmo espírito das fases anteriores): duas oportunidades de teste
(`e3ff1bfb…` ganha, e outra perdida) vinculadas a leads já existentes de
smoke-tests anteriores.

---

## 4. Limitações conhecidas, honestamente registradas

- **Sem tela de configuração de pipeline.** As etapas, requisitos e
  motivos de perda do funil padrão vêm prontos (backfill/criação
  automática); criar um segundo pipeline, reordenar etapas, ou
  adicionar/remover requisitos e motivos só é possível via RPC direta
  hoje. As funções existem, têm autorização no servidor e são testadas
  no pgTAP — só falta a tela em `/configuracoes`.
- **Sem "parada há N dias" com destaque visual nem indicador de
  atrasada.** O board mostra tempo médio na etapa (`avg_seconds_in_stage`,
  dado real), mas não há filtro/destaque de "parada há mais de N dias"
  como no protótipo — nenhuma contagem de atividade atrasada foi
  implementada, conforme instruído (não existe fonte de atividades
  antes da A6).
- **Sem paginação horizontal do kanban** ("Etapas 3–6 de 8" do
  protótipo) — as 8 colunas rolam horizontalmente sem esse controle.
- **`AssignLeadForm` (A4)** continua com o padrão de `<select>` não
  controlado observado na revisão anterior — não tocado nesta fase.

---

## 5. Testes

### 5.1 pgTAP (`10_a5_pipeline.test.sql`, 55 asserções)

Pipeline padrão nasce com as 8 etapas certas; vínculos e integridade
(lead de outro workspace recusado, etapa de outro pipeline recusada
mesmo no mesmo workspace); alcance de leitura e escrita do advogado
herdado do lead pai (com preservação de dado nas tentativas fora do
alcance); requisitos de avanço bloqueando pular etapa, com verificação
de que nenhum lock_version muda numa tentativa recusada; concorrência
(lock_version incorreto, etapa de origem incorreta, ambos com mensagem
específica); ganho e perda idempotentes (cliente reaproveitado numa
segunda oportunidade do mesmo contato, handoff nunca duplicado);
projeção financeira por papel em detalhe e board, incluindo a ausência
total de indicador financeiro para `viewer` e a ausência de soma de
coluna para `sales`; integração com merge/undo de contato da A3 (a
oportunidade segue o contato vencedor via o lead, e volta ao desfazer);
RLS forçada e grants exatos (incluindo a confirmação de que
`pipelines` tem SELECT mas não INSERT direto para `authenticated`).

### 5.2 e2e (`pipeline.spec.ts`, 8 testes)

Criação de oportunidade via UI; mover etapa pelo menu com persistência
real; requisito de avanço bloqueando pular etapa (RPC direta, já que
não há tela de configuração — autorização e regra testadas no
servidor, não na UI); **duas movimentações concorrentes de verdade**
(`Promise.all`, duas chamadas HTTP reais); ganhar (UI) com idempotência
confirmada por uma segunda chamada RPC direta; perder (UI) com motivo
obrigatório; **sales nunca recebe valor exato — respostas de rede reais
inspecionadas** (não só o DOM), nem no board nem na soma de coluna;
isolamento entre workspaces (404, não 403).

### 5.3 Validação local antes do push

`npm run typecheck`/`lint`/`test` (112) e `npm run build` limpos, a
cada rodada de correção. `supabase db push --dry-run` antes de cada
push real ao banco hospedado.

---

## 6. CI e PR

*(preenchido depois da primeira rodada de CI — placeholder até lá.)*

---

## 7. Confirmações explícitas

- **Nenhuma fase além da A5 foi iniciada** — A6/A8 não implementadas.
- **Nenhum arquivo de referência visual foi alterado.**
- **Sem merge em `main`.** PR aberto (link na seção 6), aguardando CI
  verde e validação no preview antes de qualquer aprovação.
- **`praxis-crm-dev`:** só migrations aditivas aplicadas (dry-run
  conferido antes de cada uma). Nenhum dado apagado — a linha residual
  de `lead_values` da A4 segue intacta, sem uso pelo contrato ativo.
- **Nenhuma dependência de fase futura instalada** — `@dnd-kit/core` é
  desta fase (A5, conforme o plano), nada de A6/A7/A8 antecipado além
  do que foi explicitamente aprovado (`clients`/`client_handoffs`
  mínimos).
