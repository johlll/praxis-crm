# A7 — Conversas + simulador de WhatsApp — Handoff

**Status: implementada, CI verde.** Branch `feat/a7-conversations-simulator`,
[PR #8](https://github.com/johlll/praxis-crm/pull/8). **Não mesclada** —
aguardando autorização explícita, conforme instruído.

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

**Decisão de produto sem correspondência exata no pedido**, sinalizada
explicitamente aqui (não é lacuna, é escolha documentada — ver §10 do
documento de decisões): o gate de consentimento verifica canal (`whatsapp`)
+ vigência (concedido, não revogado); `purpose` é texto livre gravado para
auditoria/LGPD, mas não filtra tecnicamente o envio — o schema da A3 nunca
definiu um vocabulário fechado de finalidades, e inventar um aqui seria
decisão de negócio fora do meu alçada. Revisável quando o escritório
definir a taxonomia real.

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

**Unitários** (`npm test`, 132/132 passando):
- `whatsapp-normalize-event.test.ts` — normalizador contra o formato real
  documentado da Cloud API (não só contra o que o simulador produz),
  incluindo batch de várias mensagens/status num único payload.
- `conversation-messages-pagination.test.ts` — histórico paginado por
  cursor nunca vira "conversa vazia" numa falha (`ConversationMessagesLoadError`),
  distinto de uma conversa genuinamente sem mensagens.

**pgTAP** (`supabase/tests/database/12_a7_conversations.test.sql`, 55
asserções, roda no CI via `npm run test:db`): isolamento entre workspaces;
acesso negado via SELECT direto nas tabelas deny-all; simulador exige
owner/admin; primeiro contato cria contato+lead+oportunidade+atividade uma
única vez (sequencial); contato conhecido com lead+oportunidade ativa
auto-vincula sem duplicar; telefone ambíguo não escolhe e preserva a
mensagem; `resolve_conversation_link()`; consentimento bloqueia/libera/
revoga/bloqueia de novo; reenvio de saída idempotente; estados de mensagem
nunca regridem (delivered tardio depois de read, failed depois de read);
alcance por papel (`get_conversation()` nulo para quem não deveria ver);
paginação do histórico com cursor.

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
- `purpose` do consentimento é texto livre (ver §2) — sem taxonomia fechada.
- Sem upload de mídia (só texto) — Cloud API real suporta mais tipos;
  fora do pedido desta fase.

## 10. Confirmações explícitas

- Nenhuma conexão real com Meta/números reais/IA/serviço de envio.
- A8 não foi iniciada.
- Nenhuma migration já aplicada por outro ambiente foi editada — todas as
  7 migrations da A7 são novas.
- Nenhum merge foi feito; nenhum commit direto em `main`.
