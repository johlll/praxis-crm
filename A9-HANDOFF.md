# A9 — Perfil 360º do lead — Handoff

**Status: PR aberta, NÃO mesclada — merge suspenso** até a revisão final da
rodada de estabilização pós-A9 (§9). Branch `feat/a9-perfil-360`,
[PR #13](https://github.com/johlll/praxis-crm/pull/13). CI verde; fluxos
validados no preview com dados fictícios (§§6–7 e §9). A10 não iniciada.
O commit final é o topo atual da branch — ver `git log -1
feat/a9-perfil-360` em vez de um hash fixo aqui (um handoff que aponta
para o próprio commit que o edita vira referência circular).

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
- Bloco "Consulta" (`ConsultationCard`) — última atividade `meeting`
  concluída do lead, buscada direto pela RPC
  `get_last_completed_meeting` (sem tabela nova, sem depender da página de
  atividades já carregada).

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
`20260913100200_a9_read_functions.sql`, `20260915090000_a9_conflict_check_fixes.sql`)

- `create_lead_note(lead_id, body)`.
- `create_proposal`/`send_proposal`/`decide_proposal`/`get_proposal`/
  `list_proposals_for_lead` — `private.proposal_financial_projection`
  (nova, mesma política de `opportunity_financial_projection`: viewer
  nada, sales só a faixa, os demais o exato).
- `upsert_conflict_check`/`get_conflict_check` — leitura nunca 404 (estado
  "não verificado" é legítimo, não erro); escrita restrita por papel;
  nota mascarada para sales/viewer; concorrência protegida no `WHERE` do
  `UPDATE` — as duas últimas vieram na migration de correção
  `20260915090000`, depois de `20260913100100` já estar aplicada em
  `praxis-crm-dev` (§11 do documento de decisões).
- `get_lead_timeline(lead_id, types?, before?, before_id?, limit?)` —
  agregador com cursor composto, mesmo padrão de
  `list_conversation_messages` (A7).
- `list_conversations` ganha `p_lead_id` (aditivo, default null).
- `get_last_completed_meeting(lead_id)` (migration
  `20260915100000_a9_last_completed_meeting.sql`) — última reunião
  concluída do lead, ordem `completed_at desc, id desc`, `null` sem
  consulta; mesmo gate de papel e alcance de `list_activities`.

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

- `supabase/tests/database/14_a9_perfil_360.test.sql` (40 asserções): RLS
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
  `get_last_completed_meeting` achando a reunião fora das primeiras 50
  atividades, com desempate por id, alcance e isolamento; isolamento
  entre workspaces (proposta e conflito de um lead de outro workspace).
- `tests/unit/a9-lead-activities-load-more-action.test.ts` e
  `tests/unit/a9-perfil-360-review-fixes.test.tsx` (11 casos, §11.1 do
  documento de decisões): falha na segunda página de atividades mantém
  itens, erro e nova tentativa; última reunião vinda do RPC dedicado;
  filtro da timeline volta para "Todos" numa revalidação e não muda numa
  troca que falha.
- `tests/unit/a9-perfil-360-errors.test.ts` (6 casos): as 3
  `*LoadError` nunca viram estado vazio; `getConflictCheck` sem registro
  devolve "não verificado" (não é erro); payload de proposta não carrega
  `value_cents` quando o RPC não o devolveu (viewer/sales).
- `tests/e2e/a9-lead-profile.spec.ts` (novo, 4 testes): mudar de etapa sem
  sair do Perfil 360; registrar proposta com o texto honesto de envio
  manual e ver o evento aparecer na timeline ao trocar o filtro para
  "Propostas"; nota de conflito visível ao advogado que a escreveu e
  ausente da TELA do visualizador que abre o mesmo lead depois; cartão
  "Consulta" aparecendo depois de uma reunião concluída. Precisão: o e2e
  da nota verifica a ausência na tela — que a nota não viaja na resposta
  ao navegador está demonstrado pelo pgTAP, não por inspeção de rede.
- Suíte completa local: `npm run typecheck && npm run lint && npm test` —
  165 testes unitários, 0 falhas.

## 6. CI

Ver o resultado do run mais recente da branch em
https://github.com/johlll/praxis-crm/actions?query=branch%3Afeat%2Fa9-perfil-360
— typecheck, lint, testes unitários (154), `db:types:check`, pgTAP (14
arquivos incluindo `14_a9_perfil_360.test.sql`, agora 40/40), isolamento,
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

**Rodada 3 (revalidação em preview, achado ao vivo — não do CI):**
1. O cartão "Consulta" implementado na rodada 2 filtrava por
   `opportunityId === oportunidade ativa`, mas o único "Nova atividade"
   alcançável a partir do Perfil 360 nunca manda `opportunityId` — o
   cartão nunca aparecia na prática, mesmo com uma reunião de verdade
   concluída. Só apareceu porque testei criando e concluindo a atividade
   de verdade no preview, não só olhando o código; o CI não pega isso
   porque nenhum e2e anterior criava uma atividade `meeting`. Corrigido e
   revalidado no deployment seguinte.

**Rodada 4 (terceiro review), 3 ajustes pontuais** — detalhe em
[`docs/decisoes/a9-perfil-360.md`](docs/decisoes/a9-perfil-360.md) §11.1:
falha na segunda página de atividades não some mais com o "carregar
mais"; cartão "Consulta" vindo de uma RPC dedicada em vez da página de 50
já carregada; filtro da timeline coerente com os eventos depois de uma
revalidação ou de uma troca que falhou. Cobertos por testes direcionados
(unitários + pgTAP), sem repetir a validação manual inteira. A migration
`20260915100000_a9_last_completed_meeting.sql` foi aplicada em
`praxis-crm-dev` com autorização (dry-run antes: só ela, sem alteração de
dados); a página do lead no preview voltou a carregar com o cartão
Consulta.

Nenhuma das três rodadas envolveu mudar uma regra de negócio — a primeira
foi só composição de UI; a segunda foram lacunas reais de proteção/UX e
duas entregas concluídas; a terceira foi um bug real na entrega da própria
rodada 2, só visível testando o fluxo de ponta a ponta.

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

**Segunda rodada** (depois das correções da §11 dos decisões, com um lead
fictício novo — "Cliente A9 Revalidação"): a correção de `conflict_checks`
entrou numa migration nova, `20260915090000_a9_conflict_check_fixes.sql`
(`20260913100100` já estava aplicada em `praxis-crm-dev` — editar uma
migration já aplicada quebraria o forward-only do plano §15, mesmo em
ambiente de dev; `create or replace` nas duas funções, aridade sem
mudança). Aplicada com `db:push:dry-run` primeiro (só essa migration,
nenhuma exclusão) e depois `db:push` de verdade, autorização explícita do
usuário. Confirmado ao vivo:

- `StageMoveControl` movendo a oportunidade de "Fazer primeiro contato"
  para "Qualificar oportunidade" sem sair da página, evento aparecendo na
  timeline.
- Proposta criada, "Registrar envio manual" (não mais "Enviar proposta")
  com o texto explicando que o CRM não despacha a mensagem, aceita, e o
  evento aparecendo na timeline ao trocar o filtro para "Propostas" (prova
  ao vivo de que o filtro vai ao servidor).
- Verificação de conflito registrada com nota confidencial, texto visível
  para quem a escreveu (advogado/owner).
- **Achado real nesta rodada, não coberto pelo CI**: o cartão "Consulta"
  não aparecia depois de criar e concluir uma reunião de verdade — corrigido
  e revalidado (deployment seguinte já mostrou o cartão com "Realizada" e
  os dados corretos). Detalhe em
  [`docs/decisoes/a9-perfil-360.md`](docs/decisoes/a9-perfil-360.md) §11.

**Limitação desta validação**: a máscara da nota de conflito para
sales/viewer (achado 1 da §11) foi confirmada pelo pgTAP (RPC real contra
Postgres real, 3 papéis testados — é ele que prova que a nota não sai na
resposta) e pelo e2e novo rodando no CI (usuário `elisa`, seed do CI —
esse só prova a ausência na tela) — mas **não** foi reconfirmada ao vivo neste ambiente
hospedado (`praxis-crm-dev`) por falta de uma segunda credencial de teste
(viewer/sales) nesse projeto; só a credencial de owner estava disponível.
Quem quiser essa confirmação específica no ambiente hospedado precisa
fornecer uma credencial de papel restrito desse projeto.

## 8. Limitações reais

As três limitações registradas antes (`getOpportunity()` sem distinguir
falha de "não encontrado", numeração de proposta por contagem simples e
`listActivities()` engolindo erro nas telas antigas) foram **resolvidas** na
rodada de estabilização (§9), com teste que falhava antes e validação no
ambiente hospedado quando aplicável.

Continua em aberto: nada desta rodada. As pendências herdadas de Auth
(Site URL/Redirect URLs e provedor de e-mail) foram encerradas — ver §9.

## 9. Rodada de estabilização pós-A9

Pedida antes do merge: encerrar os defeitos conhecidos das fases já
implementadas. Inventário único, cenários, testes e evidências em
[`docs/decisoes/estabilizacao-pos-a9.md`](docs/decisoes/estabilizacao-pos-a9.md).
Resumo:

- **Contrato único de erro (`DataLoadError`)** em todas as consultas: ausência
  legítima continua `null`, lista vazia continua vazia, falha operacional
  lança e chega à tela com "Tentar novamente". Inclui `getOpportunity`,
  `listActivities`, requisitos de avanço/ganho (falha não vira "nenhum
  pendente"), leads, conversas, contatos, equipe, workspace, membership e
  sessão (falha de rede não manda para login/onboarding).
- **`requirePermissionSafe` único** (eram 9 cópias) e **actions de equipe e
  contatos com canal de erro** (A3-HANDOFF §9).
- **`error.tsx` com `retry`** (o `reset` não refazia a busca) e limites de
  erro para as rotas e o layout que não tinham.
- **Listas completas** onde a primeira página era usada como lista inteira
  (seletor de leads, oportunidades do lead e da conversa, pendentes da
  oportunidade, contatos acima de 1.000) e tabela do pipeline paginada.
- **Numeração de proposta atômica** (migration `20260915110000`): contador
  por workspace e ano, inicializado pelos números já emitidos, sem truncar
  acima de 9999. Concorrência real e atualização a partir da versão
  anterior validadas no CI; aplicada em `praxis-crm-dev` após dry-run.
- **Formulários de edição** que voltavam ao valor anterior depois de salvar
  (risco registrado desde a A4, reproduzido no hospedado nesta rodada).
- **Login** (`bd3adb5`): falha do serviço de autenticação deixou de virar
  "E-mail ou senha incorretos"; decisão pelo código oficial do auth-js, sem
  revelar se a conta existe. Conferido no hospedado.
- **Confirmação de e-mail** (`057fcf9`): o link real do Supabase volta como
  `/auth/confirm?code=` (fluxo PKCE) e a rota só aceitava `token_hash` — a
  confirmação terminava no login sem sessão e sem aviso. Validado no
  hospedado com cadastro e link reais (§7.2 do inventário).
- **Site URL / Redirect URLs** (A2-HANDOFF §7.5): já corrigidos no painel;
  reconferidos sem credencial pelo redirecionamento do próprio GoTrue, e
  depois pela API de gerência. Nenhum ajuste manual pendente.
- **E-mail transacional próprio** (autorizado nesta rodada, antecipando o
  que estava no marco B): Resend com o domínio `mail.collios.cloud`
  (DKIM/SPF/MX/DMARC no DNS da Vercel), SMTP no `praxis-crm-dev`, limite de
  envio de 2 para 30 por hora e modelo de confirmação apontando direto para
  `/auth/confirm` com `token_hash`, preservando o ambiente de origem do
  cadastro. Confirmação validada em outro navegador, no navegador original,
  com link reutilizado, e seguida de login e aceite de convite.
- **Mensagens da confirmação**: link inválido, estado da conta e abertura
  da sessão viraram três casos distintos, e o caminho oferecido é o que
  existe na tela (reenvio pelo próprio "Criar conta", preservando conta e
  senha).
