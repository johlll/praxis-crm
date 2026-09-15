# A9 — Perfil 360º do lead — Handoff

**Status: PR aberta, NÃO mesclada.** Branch `feat/a9-perfil-360`,
[PR #13](https://github.com/johlll/praxis-crm/pull/13). CI verde e fluxo
principal (incluindo os 5 ajustes do review pós-CI) validado no preview
com dados fictícios (§§6–7). **Merge não solicitado nem autorizado** —
aguardando instrução. O commit final é o topo atual da branch no momento
da leitura — ver `git log -1 feat/a9-perfil-360` em vez de um hash fixo
aqui (um handoff que aponta pro PRÓPRIO commit que o edita vira
referência circular a cada ajuste seguinte; preferível deixar o Git ser a
fonte de verdade do "topo atual").

## 1. Escopo

Entregue nesta fase, conforme o pedido (raciocínio completo em
[`docs/decisoes/a9-perfil-360.md`](docs/decisoes/a9-perfil-360.md)):

- `/leads/[id]` enriquecida com as 6 abas do protótipo aprovado (Visão
  geral, Conversas, Atividades, Arquivos, Propostas, Histórico) — não é
  uma rota nova.
- Composer (Anotação/Mensagem/Anexo) — Anotação funciona de ponta a
  ponta; Mensagem só quando já existe conversa vinculada ao lead; Anexo
  desabilitado (upload é B4). "Atividade" não é um botão do composer — a
  `ActivitiesSection` completa (com reagendar/transferir/concluir por
  linha) já fica visível na "Visão geral" com seu próprio "Nova
  atividade"; um segundo gatilho duplicaria o botão. A linha do tempo
  mostra o mesmo evento sem repetir o título sozinho (`"{título} —
  agendada/concluída"`, nunca só `"{título}"`), para nunca colidir por
  igualdade exata com o texto da lista (achado do e2e, ver §3 do
  documento de decisões).
- Timeline unificada (`get_lead_timeline`) cruzando anotações, atividades,
  mensagens, transições de etapa, propostas e verificação de conflito —
  cursor composto `(occurred_at, id)`, paginação sem furo nem repetição em
  timestamps empatados.
- `proposals` — metadados apenas (número, valor, modelo, status, canais,
  datas), ciclo de vida rascunho → enviada → aceita/recusada, projeção
  financeira por papel. **Sem PDF/`document_path`** — exclusivo da B1.
- `conflict_checks` — registro manual único por lead (status, nota, quem e
  quando verificou), escrita restrita a owner/admin/manager/lawyer.
- Reaproveitamento total da A5/A6 para ganho/perda/etapa/próxima ação:
  `OpportunityDetailPanel`, `WonDialog`, `LostDialog`,
  `moveOpportunityStageAction` — nenhuma lógica de negócio duplicada. Novo
  o componente visual `StageProgressBar` e, ao lado dele, `StageMoveControl`
  (mudar de etapa sem sair do Perfil 360, mesma RPC/bloqueio por requisito
  do kanban).
- `list_conversations` ganha `p_lead_id` (parâmetro aditivo) para a aba
  Conversas.
- Bloco "Consulta" (`ConsultationCard`) — derivado da atividade `meeting`
  concluída mais recente da oportunidade ativa, sem tabela nova.

**Fora do escopo, por decisão registrada em §1 do documento de decisões:**
- Painel de atribuição de marketing/touchpoints — omitido inteiramente
  nesta fase (adiado para a A11, conforme já decidido na A8).
- Upload de arquivos — aba "Arquivos" mostra `EmptyState` honesto, sem
  lista fictícia (correção 14 do plano, igual à A8).
- Geração de PDF de proposta — exclusiva da B1 (emenda 2 do plano).
- Busca automática de conflito de interesse — o registro é manual, sem
  cruzamento de dados (decisão explícita, não existia schema nem pedido
  para isso no plano original).

## 2. Schema novo

`supabase/migrations/20260913100000_a9_schema.sql`:

- `proposals` — `lead_id` + `opportunity_id` (mesmo padrão de
  `activities`: pendurado no LEAD para o alcance por registro ser
  idêntico), `number` único por workspace, `value_cents`, `fee_model`,
  `status`, `sent_channels`, `sent_at`, `decided_at`, `decision_note`,
  `lock_version`.
- `conflict_checks` — 1 por lead (`unique (lead_id)`), `status`, `note`,
  `checked_by`, `checked_at`, `lock_version`.
- `lead_notes` — append-only, `lead_id`, `body`, `created_by`.

Todas com RLS habilitada e forçada, policies de negação total
(select/insert/update/delete) para `authenticated` — mesmo padrão de
`activities`/`leads`, acesso só via função `SECURITY DEFINER`. Nenhum
GRANT explícito necessário: `alter default privileges` já vigente desde a
A3 nega tudo por padrão a tabela nova.

## 3. RPCs novas (`20260913100100_a9_business_functions.sql`,
`20260913100200_a9_read_functions.sql`)

- `create_lead_note(lead_id, body)`.
- `create_proposal`/`send_proposal`/`decide_proposal`/`get_proposal`/
  `list_proposals_for_lead` — `private.proposal_financial_projection`
  (nova, mesma política de `opportunity_financial_projection`: viewer
  nada, sales só a faixa, os demais o exato).
- `upsert_conflict_check`/`get_conflict_check` — leitura nunca 404 (estado
  "não verificado" é legítimo, não erro); escrita restrita por papel.
- `get_lead_timeline(lead_id, types?, before?, before_id?, limit?)` —
  agregador com cursor composto, mesmo padrão de
  `list_conversation_messages` (A7).
- `list_conversations` ganha `p_lead_id` (aditivo, default null).

Todas reaproveitam `private.has_workspace_role` e
`private.lead_accessible_to_role` sem nenhuma segunda implementação da
regra de alcance.

## 4. Frontend

- `src/modules/{proposals,conflict-checks,lead-notes,timeline}/` — schema
  Zod, queries, actions. `ProposalsLoadError`/`ConflictCheckLoadError`/
  `LeadTimelineLoadError` seguem o mesmo princípio de
  `ActivitiesLoadError`/`ConversationsLoadError`: falha operacional nunca
  vira estado vazio disfarçado.
- `src/components/leads/` — `LeadProfileTabs` (troca de aba client-side,
  sem navegação), `LeadTimeline` (filtro + "carregar mais", agora indo ao
  servidor a cada troca de filtro), `LeadComposer`, `ProposalsSection`,
  `ConflictCheckPanel`, `StageProgressBar`, `StageMoveControl`,
  `ConsultationCard`, `LeadActivitiesSection`/`LeadConversationsList`
  ("carregar mais" real nas duas abas).
- `src/lib/roles.ts` ganha `proposal.view/edit`, `conflict_check.view/edit`,
  `lead_note.edit` — mesma matriz documentada inline.
- `error.tsx`/`loading.tsx` de `/leads` já cobrem `/leads/[id]` (Next.js
  propaga para rotas filhas sem `error.tsx` próprio) — nenhum arquivo novo
  necessário.

## 5. Testes

- `supabase/tests/database/14_a9_perfil_360.test.sql` (34 asserções): RLS
  forçada nas 3 tabelas; alcance por registro em `create_lead_note`/
  `create_proposal`/`upsert_conflict_check` (advogado dentro/fora do
  alcance); projeção financeira de proposta por papel (viewer sem
  `value_cents`, sales com `value_band`, owner com valor exato); ciclo de
  vida de proposta e concorrência (`stale_version`,
  `proposal_already_sent`, `proposal_not_sent`); `conflict_checks` restrito
  a owner/admin/manager/lawyer na escrita, leitura ampla, nunca 404, nota
  mascarada para sales/viewer (advogado/dono leem o texto, os outros dois
  só status/data); paginação de `get_lead_timeline` sem furo/repetição com
  3 eventos de timestamp forçadamente empatado; `list_conversations(p_lead_id)`;
  isolamento entre workspaces (proposta e conflito de um lead de outro
  workspace).
- `tests/unit/a9-perfil-360-errors.test.ts` (6 casos): as 3
  `*LoadError` nunca viram estado vazio; `getConflictCheck` sem registro
  devolve "não verificado" (não é erro); payload de proposta não carrega
  `value_cents` quando o RPC não o devolveu (viewer/sales).
- `tests/e2e/a9-lead-profile.spec.ts` (novo, 3 testes): mudar de etapa sem
  sair do Perfil 360; registrar proposta com o texto honesto de envio
  manual e ver o evento aparecer na timeline ao trocar o filtro para
  "Propostas" (prova que o filtro vai ao servidor, não só à tela); nota de
  conflito visível ao advogado que a escreveu e ausente para o
  visualizador que abre o mesmo lead depois.
- Suíte completa local: `npm run typecheck && npm run lint && npm test` —
  154 testes unitários, 0 falhas.

## 6. CI

Ver o resultado do run mais recente da branch em
https://github.com/johlll/praxis-crm/actions?query=branch%3Afeat%2Fa9-perfil-360
— typecheck, lint, testes unitários (154), `db:types:check`, pgTAP (14
arquivos incluindo `14_a9_perfil_360.test.sql`, agora 34/34), isolamento,
concorrência A7, build, e2e completo (incluindo o arquivo novo da A9).

Duas rodadas de correção chegaram até aqui, todas encontradas por
verificação real (CI, preview ou uma segunda leitura de código), nunca
hipotéticas:

**Rodada 1 (CI/e2e/preview iniciais), 5 correções:**
1. `list_conversations` virou dois overloads em vez de substituir a
   assinatura antiga (`CREATE OR REPLACE` não troca aridade) —
   `db:types:check` acusou; corrigido com `DROP FUNCTION` explícito antes
   (mesmo achado já resolvido para `list_conversation_messages` na A7).
2. Teste de isolamento esperava o código de erro errado
   (`lead_not_found` em vez de `insufficient_permission`) para um ator
   que não é membro de workspace nenhum — pgTAP acusou.
3–5. Três duplicações de UI reais na página de lead, cada uma quebrando
   um e2e pré-existente (não escrito para a A9): link "Ver cliente"
   duplicado, botão "Nova atividade" duplicado, e o TÍTULO da mesma
   atividade aparecendo idêntico na lista e na linha do tempo. Todas
   corrigidas — detalhe em
   [`docs/decisoes/a9-perfil-360.md`](docs/decisoes/a9-perfil-360.md) §3.

**Rodada 2 (segunda revisão de código, pós-CI-verde), 5 correções + 2
entregas concluídas** — detalhe completo em
[`docs/decisoes/a9-perfil-360.md`](docs/decisoes/a9-perfil-360.md) §11:
1. Nota de conflito vazava para atendimento/visualizador — agora filtrada
   dentro da própria RPC.
2. `upsert_conflict_check` tinha janela de corrida real (`UPDATE` não
   filtrava por versão) — corrigido com o mesmo padrão de
   `send_proposal`/`decide_proposal`.
3. "Enviar proposta" prometia um envio que o CRM não faz — renomeado para
   "Registrar envio manual", com texto explícito.
4. Atividades/conversas do lead descartavam o resto em silêncio (sem
   `status: "all"`, sem paginação além da primeira página) — corrigido com
   "carregar mais" real nas duas abas.
5. O filtro da timeline só filtrava o que já estava carregado na tela, não
   ia ao servidor — corrigido.
6. Bloco "Consulta" (antes uma limitação registrada) — implementado.
7. Mudar de etapa sem sair do Perfil 360 (antes uma limitação registrada)
   — implementado, reaproveitando a RPC/bloqueio do kanban sem duplicar
   regra nenhuma.

Nenhuma das duas rodadas envolveu mudar uma regra de negócio — a primeira
foi só composição de UI; a segunda foram lacunas reais de proteção/UX e
duas entregas concluídas.

## 7. Validação em preview

**Primeira rodada** (antes das correções da rodada 2), aplicadas as 3
migrations em `praxis-crm-dev` e validado manualmente como advogado
(`QA A6 Advogado`) contra o deployment daquele commit:

- Criado lead + oportunidade fictícios ("Cliente A9 Preview QA").
- Criada proposta (R$ 5.000, modelo fixo) → número `PROP-2026-0001`
  gerado corretamente → enviada (WhatsApp) → aceita. Projeção financeira
  confirmada: valor exato visível para o advogado.
- Verificação de conflito registrada ("Sem conflito") e persistida.
- Anotação registrada pelo composer.
- Linha do tempo mostrando os 3 eventos acima em ordem cronológica
  correta, com valor/status projetados.
- Criada uma atividade ("Revisar contrato") — apareceu uma única vez na
  lista e uma vez na timeline com texto distinto.
- Um lead já convertido em cliente (de dados de preview da A8) mostrado
  para conferir que "Ver cliente" aparece uma única vez.
- Painel de atribuição de marketing confirmado AUSENTE (decisão da §1).

**Segunda rodada** (depois das correções da §11 dos decisões): as
migrations da conflict-check foram reaplicadas em `praxis-crm-dev`
(`CREATE OR REPLACE`/edição do `UPDATE`, mesmo arquivo, sem migration
nova) e o fluxo foi revalidado no novo deployment de preview —
`StageMoveControl` movendo etapa sem sair da página, `ConsultationCard`
aparecendo só depois de uma atividade `meeting` concluída, texto de
"Registrar envio manual" no lugar de "Enviar proposta", nota de conflito
some para o visualizador, e "carregar mais" funcionando nas abas
Atividades e Conversas.

## 8. Limitações reais

- `getOpportunity()`/`get_opportunity()` ainda não distinguem "não
  encontrado/sem acesso" de falha operacional (mesmo achado que a A8
  corrigiu em `get_client()`) — pré-existente da A5, fora do escopo desta
  fase; a página de lead herda essa limitação ao reaproveitar
  `OpportunityDetailPanel`.
- Numeração de proposta (`PROP-<ano>-<sequencial>`) é contagem simples, não
  uma sequência atômica do banco — colisão concorrente rara falha por
  unique constraint (nunca duplica silenciosamente), aceitável para uma
  ação manual de baixo volume.
- `listActivities()` (usada também pela carga inicial e pelo "carregar
  mais" das abas Atividades/Visão geral) engole falha de RPC devolvendo
  lista vazia, em vez de subir um erro distinto — comportamento herdado
  das fases anteriores (não introduzido pela A9), documentado aqui porque
  o "carregar mais" novo herda a mesma limitação: uma falha real de rede
  no meio da paginação pode parecer "não há mais atividades" em vez de um
  erro recuperável. `listConversations()`/`getLeadTimelinePage()` não têm
  esse problema (lançam exceção de verdade).
