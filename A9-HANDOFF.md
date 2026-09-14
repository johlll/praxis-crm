# A9 — Perfil 360º do lead — Handoff

**Status: PR aberta, NÃO mesclada.** Branch `feat/a9-perfil-360`. CI e
validação em preview em andamento — este documento é atualizado com o
resultado final antes do pedido de merge.

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
  apenas o componente visual `StageProgressBar`.
- `list_conversations` ganha `p_lead_id` (parâmetro aditivo) para a aba
  Conversas.

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
  sem navegação), `LeadTimeline` (filtro + "carregar mais"),
  `LeadComposer`, `ProposalsSection`, `ConflictCheckPanel`,
  `StageProgressBar`.
- `src/lib/roles.ts` ganha `proposal.view/edit`, `conflict_check.view/edit`,
  `lead_note.edit` — mesma matriz documentada inline.
- `error.tsx`/`loading.tsx` de `/leads` já cobrem `/leads/[id]` (Next.js
  propaga para rotas filhas sem `error.tsx` próprio) — nenhum arquivo novo
  necessário.

## 5. Testes

- `supabase/tests/database/14_a9_perfil_360.test.sql` (30 asserções): RLS
  forçada nas 3 tabelas; alcance por registro em `create_lead_note`/
  `create_proposal`/`upsert_conflict_check` (advogado dentro/fora do
  alcance); projeção financeira de proposta por papel (viewer sem
  `value_cents`, sales com `value_band`, owner com valor exato); ciclo de
  vida de proposta e concorrência (`stale_version`,
  `proposal_already_sent`, `proposal_not_sent`); `conflict_checks` restrito
  a owner/admin/manager/lawyer na escrita, leitura ampla, nunca 404;
  paginação de `get_lead_timeline` sem furo/repetição com 3 eventos de
  timestamp forçadamente empatado; `list_conversations(p_lead_id)`;
  isolamento entre workspaces (proposta e conflito de um lead de outro
  workspace).
- `tests/unit/a9-perfil-360-errors.test.ts` (6 casos): as 3
  `*LoadError` nunca viram estado vazio; `getConflictCheck` sem registro
  devolve "não verificado" (não é erro); payload de proposta não carrega
  `value_cents` quando o RPC não o devolveu (viewer/sales).
- Suíte completa local: `npm run typecheck && npm run lint && npm test` —
  154 testes unitários, 0 falhas.

## 6. CI

_A preencher após a execução._

## 7. Validação em preview

_A preencher após a validação manual com dados fictícios._

## 8. Limitações reais

- `getOpportunity()`/`get_opportunity()` ainda não distinguem "não
  encontrado/sem acesso" de falha operacional (mesmo achado que a A8
  corrigiu em `get_client()`) — pré-existente da A5, fora do escopo desta
  fase; a página de lead herda essa limitação ao reaproveitar
  `OpportunityDetailPanel`.
- "Consulta" (bloco do protótipo) é derivada de atividades concluídas do
  tipo `meeting` — duração e modalidade não são campos estruturados hoje;
  a tela não inventa esses dados.
- `StageProgressBar` é só leitura; avançar/voltar etapa continua exigindo
  ir à tela de Pipeline (a A9 não duplicou o drag-and-drop nem o `<select>`
  de mover etapa do kanban dentro do Perfil 360).
- Numeração de proposta (`PROP-<ano>-<sequencial>`) é contagem simples, não
  uma sequência atômica do banco — colisão concorrente rara falha por
  unique constraint (nunca duplica silenciosamente), aceitável para uma
  ação manual de baixo volume.
