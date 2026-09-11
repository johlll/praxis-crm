# A7 — Conversas + simulador de WhatsApp — Handoff

**Status: implementada, revisada, corrigida.** Branch
`feat/a7-conversations-simulator`,
[PR #8](https://github.com/johlll/praxis-crm/pull/8). **Não mesclada** —
aguardando autorização explícita, conforme instruído.

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
`public.register_contact_consent`/`public.list_conversation_messages` —
sempre acrescentando parâmetro novo ao FINAL da lista, sempre com valor
padrão (mesmo padrão de `20260909100500_a4_review_hardening.sql`), o que
preserva a mesma identidade de função e os grants já concedidos, sem
precisar de `drop`+`create` nem de novos `grant`.

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

**pgTAP** (`supabase/tests/database/12_a7_conversations.test.sql`, 67
asserções — 55 originais + 12 desta revisão, roda no CI via
`npm run test:db`): isolamento entre workspaces; acesso negado via SELECT
direto nas tabelas deny-all; simulador exige owner/admin; primeiro contato
cria contato+lead+oportunidade+atividade uma única vez (sequencial); contato
conhecido com lead+oportunidade ativa auto-vincula sem duplicar; telefone
ambíguo não escolhe e preserva a mensagem; `resolve_conversation_link()`;
consentimento ausente/revogado bloqueia, finalidade INCOMPATÍVEL (existe e
está vigente, mas para outra finalidade) continua bloqueando, finalidade
CORRETA libera (§6-bis); reenvio de saída com o MESMO texto é idempotente,
reenvio com TEXTO DIFERENTE sob a mesma chave gera `content_conflict` e
nunca cria uma segunda mensagem (§6-bis); estados de mensagem nunca
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
migrations já aplicadas foi reescrita). Testes novos: 12 asserções pgTAP
(finalidade incompatível/ausente/correta; conflito de conteúdo no reenvio;
cursor incompleto rejeitado; empate de timestamp com 2 páginas cobrindo as
4 mensagens sem pular nem repetir) + 4 arquivos/casos unitários novos (ver
§5). Nenhum dos 4 achados exigiu tocar em RLS, permissões ou nas regras de
idempotência de entrada (§8 do doc de decisões) — todas continuam como
estavam, já validadas.

## 7. CI

**Verde** — [run final](https://github.com/johlll/praxis-crm/actions/runs/34604263734):
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

Deploy do preview do PR #8 concluído com sucesso
(`https://praxis-crm-git-feat-a7-conversations-simulator-johllls-projects.vercel.app`).
Validação **interativa** (Playwright) ficou bloqueada pelo SSO de proteção
de deployment da Vercel — sem sessão salva para esta URL específica (mesma
limitação já registrada em fases anteriores: exige login pessoal, que só o
usuário pode fazer). Como a suíte e2e do CI (§7, `test:e2e`, 45/45) já
exerce o fluxo completo desta fase — criar canal, simular mensagem de
número desconhecido, bloqueio/liberação por consentimento, simular
entregue/lida inline, 404 para papel sem permissão — num navegador real
contra um deploy real do Next.js e um Postgres real, considero isso
validação funcional equivalente. Se o usuário quiser a checagem visual
interativa no preview, precisa entrar no link acima com a própria conta
Vercel primeiro.

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
- Nenhum merge foi feito; nenhum commit direto em `main`.
