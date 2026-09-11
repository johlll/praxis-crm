# A7 — Conversas + simulador de WhatsApp — Handoff

**Status: MERGEADA e em produção.** Branch `feat/a7-conversations-simulator`,
[PR #8](https://github.com/johlll/praxis-crm/pull/8), mesclado em `main`
via merge commit `6068cac0`. Deploy de produção confirmado e checagem
breve (login/Conversas/histórico/envio simulado) sem falhas — ver §11.
**A8 não foi iniciada.**

Esta revisão (segunda rodada, pré-merge) corrigiu 4 achados apontados na
revisão de código: gate de consentimento sem finalidade técnica, paginação
do histórico sem desempate único, reenvio sem checagem de conteúdo
imutável, e erro de consulta da Central de Conversas disfarçado de lista
vazia. Detalhes em §6-bis abaixo; o restante deste documento (§1-5, §9-10)
foi atualizado in-line para refletir o estado final.

## 1. Escopo

Entregue nesta fase, conforme o pedido:

- `conversations`, `messages`, `message_status_events`, `whatsapp_channels`.
- Central de Conversas (`/conversas`) e `ConversationView` (`/conversas/[id]`).
- Simulador interno (`/configuracoes/simulador-whatsapp`, owner/admin) —
  mensagem recebida, status de entrega/leitura/falha inline por mensagem.
- Estados de mensagem (queued/sent/delivered/read/failed), nunca regride.
- Vínculo com contato/lead/oportunidade — automático quando inequívoco,
  pendente de resolução humana quando ambíguo (nunca escolhido a esmo).
- Consentimento (`contact_consents`, schema da A3, escrita nova nesta fase)
  verificado no servidor antes de qualquer envio ativo — painel de
  registro/revogação na própria conversa.
- Criação automática de contato+lead+oportunidade+atividade a partir de
  mensagem de número desconhecido — uma única vez, idempotente (sequencial
  e concorrente).

**Fora do escopo, como pedido:** conexão real com a Meta, números reais, IA,
serviços de envio de verdade, A8 (clientes/handoff).

## 2. Decisões de design

Todo o raciocínio (formato dos eventos, resolução de workspace/contato/
lead/oportunidade, idempotência em três camadas, ordem dos estados de
mensagem, regra de gate de consentimento) está em
[`docs/decisoes/a7-conversas.md`](docs/decisoes/a7-conversas.md) — escrito
ANTES da implementação, igual às fases anteriores.

**Revisado (§6-bis):** a decisão original de que o gate de consentimento
verificava só canal+vigência (sem finalidade técnica) não foi aprovada.
Corrigida — o gate agora exige também `purpose_code = 'whatsapp_atendimento'`
(vocabulário fechado, novo), além de canal e vigência. `purpose` continua
existindo como texto livre (evidência/auditoria, inalterado). Ver §10 do
documento de decisões para o raciocínio completo.

## 3. Modelo de dados

- `whatsapp_channels` — canal (sempre simulador nesta fase), resolve
  workspace pelo `phone_number_id` — nunca por um campo do payload.
- `conversations` — uma por `(channel_id, wa_id)`, sempre. `contact_id`,
  `lead_id`, `opportunity_id` opcionais — nulos enquanto o vínculo for
  ambíguo (`needs_link_review`), com candidatos preservados em
  `link_candidate_contact_ids`/`link_candidate_lead_ids`.
- `messages` — idempotente por `(channel_id, wa_message_id)` [entrada] e
  por `(conversation_id, client_dedupe_key)` [reenvio de saída, gerado no
  navegador].
- `message_status_events` — log bruto de cada evento de status, distinto
  da projeção em `messages.status` (nunca regride — rank
  queued<sent≈failed<delivered<read).
- `activities.source_conversation_message_id` — nova coluna de
  rastreabilidade (mesmo padrão de `source_stage_transition_id`/
  `source_rule_id` da A6), com FK composta `ON DELETE SET NULL` restrita à
  própria coluna (lição da A6 aplicada desde o desenho, não como correção
  depois).
- `register_contact_consent()`/`revoke_contact_consent()` — completam o
  caminho de escrita de `contact_consents` que a A3 desenhou (schema+RLS)
  mas não expôs ainda.
- `contact_consents.purpose_code` (novo, §6-bis) — vocabulário fechado
  (`public.consent_purpose`: `whatsapp_atendimento`/`whatsapp_marketing`),
  nasce `NULL` em todo registro anterior à migration (sem conversão
  automática); o gate de envio exige `whatsapp_atendimento` explicitamente.

**Migration desta revisão:** `20260911150000_a7_review_hardening.sql` (nova
— nenhuma das 7 anteriores foi reescrita), com `create or replace function`
em `private.contact_has_active_consent`/`public.send_message`/
`public.register_contact_consent`/`public.list_conversation_messages`.
`send_message` manteve a assinatura (só o corpo mudou) — `create or
replace` preserva a mesma função e os grants já concedidos, sem qualquer
alteração extra. As outras três ganharam um parâmetro novo (sempre ao
FINAL, sempre com default) — achado real de CI (§7, item novo abaixo):
`create or replace function` NÃO reaproveita a mesma função quando a lista
de tipos de argumento muda, mesmo só um parâmetro a mais com default; sem
um `drop function` explícito da assinatura antiga antes de recriar, as
DUAS versões ficam registradas como sobrecargas (overloads) coexistindo
— `supabase gen types` expôs isso como um tipo UNIÃO de duas formas de
`Args` em vez de um único objeto com o campo novo opcional. Corrigido com
`drop function if exists <assinatura antiga>` antes de cada `create`, e
`grant`/`revoke` novos para as duas funções `public.*` (objetos de
catálogo genuinamente novos após o drop).

## 4. Permissões

Novas entradas em `src/lib/roles.ts`:

| Permissão | Quem |
|---|---|
| `conversation.view` | todos os papéis (alcance real por registro, na RPC) |
| `conversation.send` | owner/admin/manager/lawyer/sales (igual "Enviar mensagens" do plano) |
| `conversation.link` | owner/admin/manager (mesmo nível de `contact.merge`) |
| `conversation.simulate` | **só owner/admin** — mais restrito que o "administrativo" das outras fases, decisão documentada (§3 do doc de decisões) |
| `contact.consent_manage` | owner/admin/manager/lawyer/sales (igual `contact.edit`) |

Alcance por registro: `private.conversation_accessible_to_role()` — owner/
admin/manager veem tudo; conversa ainda sem lead vinculado só é visível a
essas três; com lead, mesmo alcance "seus + sem responsável" do advogado já
usado em atividades/oportunidades (`private.lead_accessible_to_role`, A4).

## 5. Testes

**Unitários** (`npm test`, 139/139 passando — 132 originais + 7 desta revisão):
- `whatsapp-normalize-event.test.ts` — normalizador contra o formato real
  documentado da Cloud API (não só contra o que o simulador produz),
  incluindo batch de várias mensagens/status num único payload.
- `conversation-messages-pagination.test.ts` — histórico paginado por
  cursor nunca vira "conversa vazia" numa falha (`ConversationMessagesLoadError`),
  distinto de uma conversa genuinamente sem mensagens; (revisão) cursor
  composto `(created_at, id)` sempre repassado junto, nunca incompleto.
- `conversations-list-error.test.ts` (novo, §6-bis) —
  `listConversations()` joga `ConversationsLoadError` numa falha de
  consulta, distinto de "workspace genuinamente sem conversas".
- `send-message-result-mapping.test.ts` (novo, §6-bis) —
  `mapSendMessageResult()` nunca fabrica texto/status: reenvio idêntico
  devolve o registro persistido (inclusive se o status avançou entre as
  duas tentativas); reenvio com conteúdo diferente sinaliza
  `content_conflict` e devolve o texto REALMENTE persistido.

**pgTAP** (`supabase/tests/database/12_a7_conversations.test.sql`, 71
asserções — 55 originais + 16 desta revisão, roda no CI via
`npm run test:db`): isolamento entre workspaces; acesso negado via SELECT
direto nas tabelas deny-all; simulador exige owner/admin; primeiro contato
cria contato+lead+oportunidade+atividade uma única vez (sequencial); contato
conhecido com lead+oportunidade ativa auto-vincula sem duplicar; telefone
ambíguo não escolhe e preserva a mensagem; `resolve_conversation_link()`;
consentimento ausente/revogado bloqueia, finalidade INCOMPATÍVEL (existe e
está vigente, mas para outra finalidade) continua bloqueando, finalidade
CORRETA libera (§6-bis); reenvio de saída com o MESMO texto é idempotente,
reenvio com TEXTO DIFERENTE sob a mesma chave gera `content_conflict` e
nunca cria uma segunda mensagem, reenvio com a MESMA chave depois de uma
tentativa que FALHOU sem gravar nada (ex.: `consent_required`) grava
normalmente assim que a causa da falha é corrigida (§6-bis, achado do e2e
— ver abaixo); estados de mensagem nunca
regridem (delivered tardio depois de read, failed depois de read); alcance
por papel (`get_conversation()` nulo para quem não deveria ver); paginação
do histórico com cursor incompleto rejeitado (`invalid_cursor`) e mensagens
com timestamp EMPATADO aparecendo cada uma exatamente uma vez entre duas
páginas (§6-bis).

**Concorrência real** (`scripts/a7-concurrency-check.mjs`, passo próprio do
CI, depois do pgTAP): pgTAP roda numa única conexão por arquivo — não prova
concorrência de verdade. Este script dispara DUAS requisições HTTP
concorrentes de verdade (`Promise.all`) contra o Supabase local do CI,
cobrindo exatamente os dois cenários pedidos — (1) o MESMO evento entregue
duas vezes ao mesmo tempo e (2) duas mensagens DIFERENTES do MESMO número
novo ao mesmo tempo — e confirma que nenhum dos dois duplica cadastro nem
mensagem.

**E2E** (`tests/e2e/conversations.spec.ts`): criar canal → simular mensagem
de número desconhecido → conversa já resolvida → envio bloqueado sem
consentimento (erro tratado do servidor, não escondido pela interface) →
registrar consentimento → enviar → simular entregue/lida inline → papel sem
`conversation.simulate` recebe 404 na tela do simulador.

## 6. Validado ao vivo contra o hospedado (praxis-crm-dev) antes de escrever a UI

Dois achados reais corrigidos durante a validação ao vivo (rollback,
nada ficou gravado):

1. **`send_message()`**: `on conflict (conversation_id, client_dedupe_key)`
   falhava em runtime ("no unique or exclusion constraint matching") — o
   índice de idempotência é PARCIAL (`where client_dedupe_key is not
   null`), e o Postgres só infere um índice parcial para `ON CONFLICT` se a
   cláusula repetir o MESMO predicado (mesmo achado já documentado na A6).
   Corrigido antes de qualquer commit.
2. **`simulate_inbound_whatsapp_message()`**: a checagem de "evento
   repetido" originalmente rodava ANTES do `pg_advisory_xact_lock` —
   corrigida a raciocinar sobre duas entregas simultâneas do mesmo evento
   (a checagem "não existe ainda" das duas chamadas passaria antes de
   qualquer commit, e a segunda bateria na constraint única em vez de
   devolver o resultado já existente). O lock foi movido para ANTES da
   checagem — nunca chegou a manifestar como bug observável (achado por
   raciocínio, não por erro em runtime), mas corrigido do mesmo jeito antes
   do primeiro commit.

Depois das correções: sequência completa (contato novo → evento repetido →
segunda mensagem diferente do mesmo número → contato conhecido com
lead/oportunidade ativa → telefone ambíguo → `resolve_conversation_link` →
consentimento bloqueia/libera → reenvio idempotente → status nunca
regride) validada com sucesso contra dado real do workspace de QA
("Escritório QA Praxis"), sempre dentro de transações revertidas.

## 6-bis. Revisão pré-merge — 4 achados corrigidos

Revisão de código no PR #8 apontou 4 pontos antes de autorizar o merge.
Raciocínio completo de cada um em `docs/decisoes/a7-conversas.md`
(§8/§10/§11/§12, marcados "revisão pré-merge"); resumo do que mudou:

1. **Consentimento sem finalidade técnica.** O gate original
   (`private.contact_has_active_consent`) só verificava canal+vigência —
   o pedido original já pedia "verificando finalidade, canal e situação
   vigente", e a finalidade tinha ficado de fora. Corrigido:
   `contact_consents.purpose_code` (vocabulário fechado, novo — ver §3)
   passa a ser exigido pelo gate (`= 'whatsapp_atendimento'`), sem
   conversão automática de registros antigos (nascem `NULL`, nunca contam
   como vigentes). `purpose` (texto livre) continua existindo, inalterado,
   como evidência/auditoria.
2. **Paginação sem desempate único.** `list_conversation_messages()` usava
   só `created_at` como cursor — mensagens com o MESMO timestamp podiam
   ser puladas ou repetidas entre páginas. Corrigido: cursor composto
   `(created_at, id)`, `p_before`/`p_before_id` sempre exigidos juntos
   (`invalid_cursor` se só um vier).
3. **Reenvio sem checagem de conteúdo.** `send_message()` tratava
   `client_dedupe_key` como puramente idempotente — reenviar a MESMA chave
   com um TEXTO DIFERENTE do já persistido devolvia "sucesso" sem
   comparar. Corrigido: a chave agora é imutável — texto igual continua
   idempotente; texto diferente devolve `content_conflict: true` com o
   registro REALMENTE persistido (nunca cria uma segunda mensagem, nunca
   finge que o texto novo foi enviado). `ConversationThread`/`Composer`
   reconciliam a bolha da conversa com o que o servidor devolve (nunca
   fabricam a partir do texto local do textarea) e descartam a
   `client_dedupe_key` antiga após um conflito.
4. **Erro da Central de Conversas virava lista vazia.** `listConversations()`
   devolvia `{items: [], total: 0}` tanto numa falha de consulta quanto num
   workspace genuinamente sem conversas. Corrigido com o mesmo padrão de
   `ActivitiesLoadError`/`ConversationMessagesLoadError`: joga
   `ConversationsLoadError`, capturado pelo novo
   `src/app/(app)/conversas/error.tsx` (erro tratado com "tentar
   novamente").

Migration nova: `20260911150000_a7_review_hardening.sql` (nenhuma das 7
migrations já aplicadas foi reescrita). Testes novos: 16 asserções pgTAP
(finalidade incompatível/ausente/correta; conflito de conteúdo no reenvio;
reenvio com a mesma chave após uma falha que não gravou nada; cursor
incompleto rejeitado; empate de timestamp com 2 páginas cobrindo as 4
mensagens sem pular nem repetir) + 3 arquivos/7 casos unitários novos (ver
§5). Nenhum dos 4 achados exigiu tocar em RLS, permissões ou nas regras de
idempotência de entrada (§8 do doc de decisões) — todas continuam como
estavam, já validadas.

**Achado extra, só apareceu no e2e do CI (não no pgTAP nem localmente):**
`create or replace function` com um parâmetro novo no fim da lista NÃO
substitui a function antiga quando a lista de tipos de argumento muda —
mesmo só acrescentando um, mesmo com default. A identidade de uma function
no catálogo do Postgres é nome+tipos dos argumentos; "OR REPLACE" sem
correspondência exata cai para um CREATE comum, e as duas versões (antiga
e nova) ficam coexistindo como sobrecargas. `supabase gen types` expôs
isso primeiro (união de duas formas de `Args` em vez de um campo opcional)
— corrigido com `drop function if exists <assinatura antiga>` antes de
cada `create`, em `private.contact_has_active_consent`/
`public.register_contact_consent`/`public.list_conversation_messages`
(as três que ganharam parâmetro novo; `send_message` manteve a assinatura
e não precisou disso).

Depois disso, um segundo achado — desta vez só no e2e, nunca reproduzido
localmente nem no pgTAP original: o teste "envio sem consentimento é
bloqueado; registrar consentimento libera" **passava com falso positivo**.
Sua asserção final (`getByText("Oi! Recebemos sua mensagem.")`, sem
escopo) batia tanto numa bolha de mensagem real quanto no texto que
simplesmente sobra no `<textarea>` depois de uma tentativa que falhou —
exatamente o mesmo padrão já documentado no CI original desta fase (achado
9/10 da primeira rodada), só que desta vez na asserção de SUCESSO, não na
de falha. O relatório do Playwright (screenshot anexado à falha do
próximo teste, que dependia da mensagem existir) confirmou: a mensagem
nunca foi gravada. Investigado com um teste pgTAP novo, específico —
reenviar a MESMA `client_dedupe_key` depois de uma tentativa que falhou
por `consent_required` (nunca chegou a gravar nada, diferente do teste de
conflito de conteúdo que reenvia uma chave que JÁ gravou algo) — que
**passou**, confirmando que a camada SQL sempre esteve correta; o problema
era só a asserção do teste, sem escopo. Corrigida para
`getByRole("listitem").filter({hasText: ...})`, mesma disciplina do resto
do arquivo.

## 7. CI

**Verde no commit final desta revisão** —
[run](https://github.com/johlll/praxis-crm/actions/runs/34639175517) (commit
`209c770`, runner Docker do CI — local ao workflow, não é o preview
hospedado; ver diferenciação no §8): typecheck, lint, 139 testes
unitários, `db:types:check`, pgTAP (71/71 — 407 no total somando as 12
suítes do repositório), isolamento entre workspaces (26/26), teste de
concorrência real (`a7-concurrency-check.mjs`), build, e2e (45/45,
incluindo os 4 cenários de `conversations.spec.ts`).

Esta revisão levou 3 rounds de CI até fechar (contra os 10 da entrega
original da A7): 1) `db:types:check` (tipos gerados contra o Docker local
do CI divergiam do `database.ts` commitado, mesma classe de achado do
round 1 original); 2) `create or replace function` não substituindo uma
function quando o parâmetro novo muda a lista de tipos de argumento
(achado explicado em detalhe no §6-bis); 3) asserção de e2e sem escopo
mascarando uma mensagem que nunca foi gravada (também detalhado no
§6-bis). Todos os 3 foram achados reais — o segundo e o terceiro só
apareceram porque o cenário exato (parâmetro novo numa function existente;
reenvio com a mesma chave depois de uma falha SEM gravação) nunca tinha
sido exercitado antes desta revisão.

Run anterior (implementação original da A7, antes desta revisão) —
[run](https://github.com/johlll/praxis-crm/actions/runs/34604263734):
typecheck, lint, 132 testes unitários, `db:types:check`, pgTAP (55/55),
isolamento entre workspaces, teste de concorrência real
(`a7-concurrency-check.mjs`), build, e2e (45/45, incluindo os 4 cenários de
`conversations.spec.ts`).

Levou 10 rounds de correção até fechar — cada achado real, listado aqui
porque nenhum foi encontrado localmente (sem Docker nesta máquina, o CI foi
o primeiro ambiente a rodar pgTAP/isolamento/concorrência/e2e de verdade):

1. `database.ts` gerado contra o hospedado (`--linked`) divergia do gerado
   contra o Docker local do CI (`--local`) — boilerplate diferente
   (`__InternalSupabase`, formatação de genéricos) mesmo na mesma versão da
   CLI. Substituído pelo conteúdo exato que o CI gerou.
2. pgTAP fazia SELECT direto em `leads`/`opportunities`/`activities`/
   `contact_identifiers`/`messages`/`message_status_events` (deny-all, só
   RPC) sob o papel `authenticated` — `reset role` antes de cada
   verificação direta, restaurado depois.
3. `assign_lead()` (A4) sempre exige `p_expected_updated_at` — o teste de
   alcance por papel nunca passava esse parâmetro; reescrito para buscar o
   valor atual antes de cada chamada e para testar o cenário real de
   negação (lead atribuído a OUTRA pessoa, não "sem responsável").
4. Contagem errada de `message_status_events` (a asserção presumia
   deduplicação que a lógica nunca prometeu para timestamps diferentes).
5. Variável psql com snapshot pré-resolução (`ambiguo_r1.contact_id`
   continuava null depois de `resolve_conversation_link()` mudar a
   conversa no banco — a variável já capturada não se atualiza sozinha).
6. psql nunca substitui `:'var'` dentro de um bloco `DO $$...$$` (tratado
   como string opaca) — trocado por um `SELECT` de nível superior com
   `generate_series()`.
7. `\gset` captura em VARIÁVEL psql, não em coluna — `select
   is(jsonb_array_length(items), ...)` sem os dois-pontos é "column items
   does not exist".
8. `now()` é estável por TRANSAÇÃO no Postgres — como o arquivo pgTAP
   inteiro roda numa única transação, 13 mensagens inseridas em sequência
   nasciam todas com o MESMO `created_at`, empatando o cursor de paginação
   (nunca acontece em produção real, onde cada envio é sua própria
   transação PostgREST). Espaçados manualmente só para o teste.
9. e2e: `getByText("Canal e2e")` também batia na `<option>` do select do
   formulário de simulação — escopado para a lista.
10. e2e: `getByText(...)` também batia no valor do `<textarea>` (que
    preserva o texto digitado depois de uma falha, de propósito) —
    escopado para `getByRole("listitem")` (bolha de mensagem de verdade).

Nenhum desses 10 achados apontou um problema real de PRODUTO — todos foram
erros de sintaxe/uso de psql ou de teste (variável obsoleta, expectativa
numérica errada, seletor ambíguo). A lógica de negócio em si (idempotência,
consentimento, alcance por papel, resolução de vínculo) já tinha sido
validada ao vivo (§6) antes do primeiro commit e não precisou de nenhuma
correção adicional durante este processo.

## 8. Validação em preview

**Diferença de ambiente entre o CI e o preview**, importante para o que
segue: o CI (§7) roda contra um Postgres **local, efêmero, dentro do
runner do GitHub Actions** (`supabase db reset --local`, Docker) — todas
as migrations aplicadas do zero a cada execução, seed próprio, descartado
ao final. O preview do Vercel roda o mesmo código, mas contra o Postgres
**hospedado e persistente** do projeto `praxis-crm-dev` — o MESMO banco
usado nas validações ao vivo pré-commit (§6) de fases anteriores, que só
recebe migrations quando alguém roda `supabase db push --linked` de
propósito. São dois bancos genuinamente diferentes; um passar não garante
o outro.

Desta vez a validação **interativa** foi feita de verdade (Playwright via
`playwright-cli`, autorizado nesta revisão), não só a suíte e2e do CI:

- Login com sessão persistente do Playwright: desta vez o SSO de proteção
  de deployment da Vercel **não bloqueou** (diferente das fases anteriores
  — a sessão persistente `-s=praxis` já tinha uma autenticação Vercel
  válida de uma verificação anterior deste mesmo projeto). Login no
  próprio Praxis feito com uma conta de QA (`Escritório QA Praxis A3`)
  fornecida pelo usuário.
- **Achado real, não presumido**: o primeiro registro de consentimento no
  preview falhou com a mensagem genérica de erro. Investigado (não
  descartado como "flakiness") — a causa era o preview apontar para o
  Postgres hospedado (`praxis-crm-dev`), que ainda não tinha recebido
  `20260911150000_a7_review_hardening.sql` (a migration desta revisão só
  existia no Postgres efêmero do CI e nas migrations do repositório).
  `register_contact_consent()` com o parâmetro novo `p_purpose_code` não
  existia ainda naquele banco — PostgREST devolve um erro de "função não
  encontrada", que não bate em nenhum código de negócio conhecido e cai no
  texto genérico de `toUserMessage()`. **Não é um bug de produto** — é
  esperado que o preview só funcione de verdade depois que a migration for
  aplicada no banco que ele usa. Confirmado com o usuário e aplicado via
  `supabase db push --linked` (autorizado explicitamente antes de rodar,
  por ser uma ação que muda um banco compartilhado).
- Depois disso, o fluxo completo pedido foi validado, de ponta a ponta, no
  navegador real, contra o preview real: **mensagem recebida** (simulador,
  número desconhecido) → **cadastro inicial** (contato+lead+oportunidade
  criados automaticamente, atividade "Responder mensagem de WhatsApp (novo
  contato)" visível no lead) → **conversa** (mensagem recebida exibida,
  sem "vínculo pendente" — já resolvida) → **consentimento** (bloqueado
  antes de registrar, com o aviso certo; registrado com sucesso; painel
  mostra "Vigente desde..."; volta a bloquear se revogado — não repetido
  aqui por já estar coberto no e2e/pgTAP) → **resposta simulada** (enviada,
  aparece na conversa com o texto certo) → **estados de entrega/leitura**
  (SIMULAR → Marcar entregue → Marcar lida, ícones mudam de ✓ para ✓✓, o
  botão SIMULAR desaparece depois de "lida", exatamente como esperado).
- **Resolução de vínculo ambíguo**, cenário adicional pedido: criados dois
  contatos com o MESMO telefone (`Ambíguo Preview A`/`B`), simulada uma
  mensagem desse número — a conversa mostrou "Vínculo pendente" com os
  dois nomes como opções, a mensagem preservada, consentimento continuando
  bloqueado (nunca inventado). Ao escolher "Ambíguo Preview A", o banner
  de pendência desapareceu e a conversa passou a mostrar aquele contato —
  `resolve_conversation_link()` funcionando pela interface de verdade.

Nenhum dado real de cliente foi usado — só registros fictícios criados
para este teste (`Cliente Novo Preview`, `Ambíguo Preview A`/`B`, canal
`Canal QA Preview`), no workspace de QA já dedicado a isso.

## 9. Limitações conhecidas

- Resolução de contato ambíguo oferece só os candidatos que o próprio banco
  já identificou (mesmo telefone) — não há busca livre por qualquer contato
  do workspace na tela (ficaria para quando isso for pedido de verdade).
- Ambiguidade de OPORTUNIDADE (lead com mais de uma oportunidade aberta)
  usa a lista de oportunidades abertas do lead, buscada na página — não há
  `link_candidate_opportunity_ids` persistido na conversa (diferente de
  contato/lead, que persistem candidatos). Documentado, não escondido.
- `purpose_code` (finalidade técnica, §6-bis) cobre hoje só `whatsapp`
  (único canal com fluxo de envio ativo nesta fase) — email/telefone/
  presencial continuam sem gate de finalidade, porque não têm envio ainda.
  `purpose` (texto livre) continua existindo ao lado, sem mudança.
- Sem upload de mídia (só texto) — Cloud API real suporta mais tipos;
  fora do pedido desta fase.

## 10. Confirmações explícitas

- Nenhuma conexão real com Meta/números reais/IA/serviço de envio.
- A8 não foi iniciada.
- Nenhuma migration já aplicada por outro ambiente foi editada — as 8
  migrations da A7 (7 originais + `20260911150000_a7_review_hardening.sql`
  desta revisão) são todas novas.
- Merge feito — ver §11. A partir do PR #8, toda mudança em `main`
  continua passando por PR; esta própria seção foi escrita por um PR
  exclusivo de documentação (`docs/a7-handoff-producao`), sem commit
  direto em `main`.

## 11. Merge e confirmação em produção

**Merge:** autorizado explicitamente pelo usuário, condicionado a CI verde
no commit final e ausência de conflitos — as duas condições já estavam
cumpridas (§7, commit `d58fce8`, CI verde; `mergeStateStatus: CLEAN`). PR
#8 mesclado em `main` via merge commit `6068cac0`
(`https://github.com/johlll/praxis-crm/commit/6068cac0`), mesmo método já
usado nos PRs #5/#6/#7 (`--merge`, sem squash/rebase). Nenhum commit direto
em `main` — toda mudança desta fase entrou por PR.

**Deploy de produção:** confirmado — `Vercel` reportou
`Deployment has completed` para o commit `6068cac0`
(checagem via `gh api repos/.../commits/6068cac0.../status`,
`state: success`), correspondendo exatamente ao commit mesclado.

**Checagem breve em produção** (`https://praxis-crm-eight.vercel.app`,
mesma conta QA já usada — `joaoniero2+praxisqaa3@gmail.com`, dado
100% fictício, nenhum cliente real):

| Fluxo | Resultado |
|---|---|
| Login | OK — sessão já ativa (mesmo perfil persistente do Playwright), `/visao-geral` renderizou com o workspace certo ("Escritorio QA Praxis A3"), confirmando sessão validada de verdade pelo middleware |
| Central de Conversas | OK — `/conversas` listou as duas conversas fictícias criadas na validação de preview (§8) — "Ambíguo Preview A" e "Cliente Novo Preview", com prévia da última mensagem e status "Lida" exibido corretamente |
| Abertura do histórico | OK — `/conversas/[id]` abriu a conversa "Cliente Novo Preview" com a mensagem recebida original e a resposta simulada anterior, ambas visíveis |
| Envio simulado com consentimento adequado | OK — consentimento (`purpose_code=whatsapp_atendimento`) continuava vigente para este contato; enviada uma mensagem nova de checagem ("Checagem de produção após o merge do PR #8 (A7) — dado fictício."), apareceu na conversa com status "enviada" (✓), tag "SIMULAÇÃO — sem conexão real com o WhatsApp" visível no topo da tela |

Nenhuma falha encontrada nesta checagem. Ambiente de produção usa o mesmo
projeto Supabase de QA (`praxis-crm-dev`) já usado em todas as fases
anteriores — é por isso que a migration desta revisão, aplicada nesse
projeto durante a validação de preview (§8), já estava disponível em
produção sem nenhum passo extra.

**Nenhuma conexão real com a Meta foi ativada — confirmado por inspeção,
não presumido:**
- `find src/app/api` não encontra nenhum diretório `api/` em
  `src/app/` — não existe rota de webhook nesta fase (a conexão real é
  B3, ainda não implementada).
- `grep` no código por chamadas de saída (`fetch(`, `axios`,
  `http.request`) dentro de `src/server/whatsapp/` e
  `src/modules/conversations/` não encontra nenhuma — o simulador só lê e
  grava no próprio Postgres, nunca faz uma requisição HTTP para fora.
- `grep` por qualquer referência a domínio/token da Meta
  (`graph.facebook`, `META_`, `WHATSAPP_TOKEN`, `WABA_`) no código-fonte
  não encontra nada.
- As variáveis de ambiente de produção da Vercel (`vercel env ls
  production`) contêm só chaves do Supabase, das chaves de cifra de
  contato (A3) e do segredo do cookie de workspace — nenhuma credencial
  relacionada a Meta/WhatsApp existe no ambiente.

**A partir daqui:** qualquer atualização a `main` continua passando por
PR — nenhum commit direto, por instrução explícita do usuário.

**A8 não foi iniciada.**
