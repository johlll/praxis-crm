# A7 — Conversas + simulador de WhatsApp: decisões

Registrado antes da implementação, conforme convenção das fases anteriores
(a3-duplicidades.md, a3-criptografia.md, a5-pipeline.md, a6-atividades.md).

## 1. Formato dos eventos — fonte oficial consultada

Formato confirmado em
`https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples`
(consultado nesta fase). Estrutura real da Cloud API, resumida ao que o
simulador reproduz:

```
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "<waba_id>",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "...", "phone_number_id": "..." },
        "contacts": [{ "profile": { "name": "..." }, "wa_id": "..." }],
        "messages": [{ "from": "...", "id": "wamid...", "timestamp": "...", "type": "text", "text": { "body": "..." } }],
        // OU, em evento de status:
        "statuses": [{ "id": "wamid...", "status": "sent|delivered|read|failed", "timestamp": "...", "recipient_id": "...", "errors": [...] }]
      }
    }]
  }]
}
```

`src/server/whatsapp/types.ts` reproduz só esses campos (não o envelope
completo do Graph API, que carrega muito além do que qualquer processamento
desta fase lê). `src/server/whatsapp/normalize-event.ts` extrai um formato
normalizado, plano — é essa função (não o simulador) que o adaptador real da
Meta (marco B3) vai reaproveitar: o simulador e o webhook real só diferem em
COMO o JSON bruto chega até `normalizeInboundEvent`/`normalizeStatusEvent`,
nunca no que acontece depois.

## 2. Resolução de workspace — nunca por campo do evento

`metadata.phone_number_id` é o único campo usado para resolver o workspace —
via `whatsapp_channels` (canal cadastrado, associado a um workspace no
servidor). Nenhum `workspace_id` explícito no evento é aceito, mesmo que o
simulador pudesse enviá-lo — a função `simulate_inbound_whatsapp_message()`
nem recebe esse parâmetro. Mesma lógica de "o cliente pode solicitar, o
servidor verifica" do fluxo de workspace ativo (plano §6.8), aplicada aqui ao
remetente do evento em vez de ao usuário logado.

## 3. Acesso ao simulador — administrativo, autenticado, sem entrada anônima

`simulate_inbound_whatsapp_message()` e `apply_message_status_event()`
(entradas do simulador) exigem `auth.uid()` não nulo E papel
owner/admin no workspace do canal — checado DENTRO da função SQL, não só na
tela. Mais restrito que "administrativo" nas outras fases (que geralmente
inclui manager, ex. `pipeline.configure`/`activity.configure`): o simulador
cria dado (contato/lead/oportunidade/atividade) e não existe hoje nenhuma
tela que só um manager deveria acessar para isso — decisão conservadora,
documentada aqui para revisão se o escritório precisar de acesso mais amplo.
Não existe rota HTTP pública nenhuma para isto nesta fase (sem
`src/app/api/webhooks/*` ainda — a conexão real é B3); o único caminho é uma
Server Action que já passa por `requirePermission()` antes de chamar a RPC,
que por sua vez confere de novo (nunca confia só na camada de aplicação).

## 4. Reutilização de conversa — sempre pelo par (canal, wa_id)

Uma conversa é o par `(channel_id, wa_id)` — `unique (workspace_id,
channel_id, wa_id)`. Isso NUNCA muda, independente de qual contato/lead ela
termina vinculada a: é o equivalente ao "thread" real do WhatsApp (mesmo
número, mesmo canal = mesma conversa), decidido antes e independentemente da
resolução de identidade abaixo.

## 5. Resolução de contato — identidade confiável primeiro, telefone depois, nunca um palpite

Ordem de resolução, dentro de `simulate_inbound_whatsapp_message()`:

1. `contact_identifiers (provider='whatsapp', external_id=<wa_id cru>)` —
   único caminho 100% determinístico (unique por workspace+provider+
   external_id, mesma tabela já desenhada na A3 exatamente para isto: "entra
   quando a integração real existir" — esta é essa integração, simulada).
2. Sem identificador: correspondência por `contact_phones.value_normalized`
   dentro do workspace.
   - Exatamente 1 contato → reaproveita ("número conhecido"). Grava também
     um `contact_identifiers` para esse contato+wa_id, para que a PRÓXIMA
     mensagem do mesmo número já ache o passo 1 direto (upgrade de sinal
     fraco para forte, justificado por uma mensagem real ter chegado desse
     número — decisão de produto, documentada aqui).
   - 0 contatos → contato novo (ver §6).
   - 2+ contatos → AMBÍGUO. Não escolhe, não mescla, não cria um terceiro.
     `conversations.contact_id` fica nulo, `needs_link_review = true`,
     candidatos gravados em `link_candidate_contact_ids`. A mensagem É
     gravada mesmo assim (nunca se perde) — só o vínculo de identidade fica
     pendente de resolução humana pela tela.

## 6. Primeiro contato — cria contato+lead+oportunidade+atividade, só quando é MESMO novo

Critério de aceite do plano ("mensagem de número desconhecido cria contato,
lead, oportunidade e atividade — uma única vez, mesmo repetida") é
implementado literalmente só para o caso "0 contatos encontrados" acima.
Para contato JÁ conhecido sem nenhum lead ativo (`status='ativo'`), a
conversa fica vinculada ao contato, mas **não** cria lead/oportunidade nova
automaticamente — critério de aceite não pede isso, e criar uma
oportunidade nova a cada mensagem de um contato antigo (ex.: cliente já
encerrado mandando "oi") seria exatamente o "escolher arbitrariamente" que a
seção 3 do pedido proíbe na direção oposta. `needs_link_review = true` nesse
caso — fica visível na tela como "vincular a um lead" (existente ou novo,
via `/leads/novo?contactId=`, reaproveitando o formulário já existente).

## 7. Reutilização de lead/oportunidade — mesma regra, nunca escolhe entre vários

Contato resolvido (novo ou conhecido) com:
- exatamente 1 lead `ativo` → reaproveita o lead.
  - Desse lead, exatamente 1 oportunidade `open` → reaproveita também
    (`needs_link_review = false`, totalmente resolvido).
  - 0 oportunidades open → só o lead é vinculado; sem oportunidade não há
    "outra oportunidade a cada mensagem" para evitar (nada a decidir).
  - 2+ oportunidades open → lead vinculado, oportunidade fica pendente de
    escolha humana (`needs_link_review = true`).
- 2+ leads ativos → nem o lead é escolhido (`needs_link_review = true`,
  candidatos em `link_candidate_lead_ids`).
- 0 leads ativos → ver §6 (novo: sempre cria; conhecido: fica pendente).

## 8. Idempotência — três camadas, cada uma resolvendo um cenário do pedido

1. **Evento repetido (mesmo `wa_message_id`)**: primeira coisa que
   `simulate_inbound_whatsapp_message()` confere, ANTES de tocar em
   contato/lead/oportunidade/atividade — se já existe `messages` com esse
   `(channel_id, wa_message_id)`, devolve o resultado já existente sem
   recriar nada. Cobre repetição sequencial E o "matar no meio e reenviar"
   (nada parcial fica para trás: tudo roda numa função `plpgsql`, que é uma
   única transação — ou tudo é gravado, ou nada é).
2. **Duas entregas simultâneas do mesmo evento**: a corrida acontece DEPOIS
   da checagem acima (duas transações concorrentes podem passar pela
   checagem antes de qualquer uma commitar) — resolvida pelo índice único
   `(channel_id, wa_message_id)` em `messages`: a segunda transação a
   commitar recebe violação de unicidade, tratada como "eu perdi a corrida,
   devolve o que a outra gravou" (mesmo padrão de retry-on-conflict, não
   erro para o usuário).
3. **Duas mensagens DIFERENTES simultâneas do mesmo número novo**: o
   contato é resolvido/criado dentro da MESMA transação de cada mensagem —
   sem lock explícito, as duas transações concorrentes podem ambas concluir
   "0 contatos encontrados" e tentar criar um contato cada uma. Resolvido
   com `pg_advisory_xact_lock(hashtext(workspace_id || channel_id || wa_id))`
   logo no início da função, antes de qualquer SELECT de resolução de
   identidade — serializa as duas mensagens do MESMO número (nunca de
   números diferentes, o hash inclui o wa_id), sem lock de tabela nenhum.
   Testado explicitamente no pgTAP com duas transações concorrentes reais.

Envio (saída) usa uma quarta camada, independente: `client_dedupe_key`
gerado no NAVEGADOR (não no servidor) antes do primeiro envio de uma
composição — persistido no componente até a Server Action confirmar sucesso
— para que reenviar a MESMA submissão (ex.: usuário clica de novo após uma
falha de rede) nunca duplique a mensagem já aceita, mesmo que o `wa_id` de
destino e o texto sejam idênticos.

**Revisão pré-merge — chave imutável, não só "idempotente":** a versão
original só conferia se a `client_dedupe_key` já existia; se existisse,
devolvia a mensagem já gravada sem comparar o texto. Isso permitia um falso
sucesso: reenviar a MESMA chave com um texto DIFERENTE (ex.: usuário editou
a mensagem entre duas tentativas, sem perceber que a primeira já tinha
saído) devolvia "sucesso", e a interface mostrava o texto novo como se
tivesse sido enviado — quando na verdade o servidor nunca gravou esse texto.
`send_message()` agora compara `body_text` com o que já está persistido sob
a mesma chave: texto igual → mesmo comportamento de antes (idempotente,
devolve o registro existente); texto diferente → `content_conflict: true`,
devolvendo o registro REALMENTE persistido (texto, status, tudo) em vez de
gravar o texto novo. A interface (`sendMessageAction`/`ConversationThread`)
trata isso como erro tratado, reconcilia a bolha da conversa com o que veio
do servidor (nunca com o texto local do composer) e descarta a chave antiga
— ela já está permanentemente associada ao conteúdo original, então a
próxima tentativa (do texto editado) precisa de uma chave nova.

## 9. Estados de mensagem — nunca regride, evento ≠ mensagem

`messages.status` é PROJEÇÃO (o estado atual); `message_status_events` é o
LOG bruto de cada evento recebido (inclui os que não mudaram nada — campo
`applied` diz se mudou). Ordem: `queued`(0) < `sent`(1) < `delivered`(2) <
`read`(3); `failed` só é aplicado a partir de `queued`/`sent` (uma falha
tardia depois de já entregue/lida é contraditória — ignorada, registrada no
log com `applied=false`). Nenhum evento de status nunca apaga ou sobrescreve
o texto/id da mensagem original — só `status`/`status_updated_at`/
`error_reason` mudam.

## 10. Consentimento — verificado no servidor, nunca inventado, nunca contornável

`send_message()` (único caminho de envio ativo, usado pelo simulador E que
a conexão real vai reaproveitar sem modificação) exige, antes de gravar
qualquer coisa: `contact_consents` com `channel='whatsapp'`,
`granted_at is not null`, `revoked_at is null`, **e finalidade técnica
`purpose_code = 'whatsapp_atendimento'`** (revisado — ver abaixo), para o
contato da conversa. Ausência de registro = sem consentimento (nunca
presumido). Criar contato a partir de mensagem recebida (§6) NUNCA grava
`contact_consents` — receber não é autorização para enviar.

**Revisão pré-merge — finalidade passa a ser verificada, não só documentada
(20260911150000_a7_review_hardening.sql):** a decisão original ("`purpose`
é texto livre, o gate só olha canal+vigência") não foi aprovada — o pedido
original já dizia "verificando finalidade, canal e situação vigente", e a
implementação inicial só cobria as duas últimas. Correção: `contact_consents`
ganhou `purpose_code`, um vocabulário FECHADO
(`public.consent_purpose`: `'whatsapp_atendimento' | 'whatsapp_marketing'`)
separado do texto livre `purpose` (que continua existindo, inalterado —
evidência/auditoria de qual finalidade foi descrita ao contato, nunca usado
para decidir acesso). O gate (`private.contact_has_active_consent`) agora
exige `purpose_code = 'whatsapp_atendimento'` — a única finalidade com um
fluxo de envio ativo nesta fase. `'whatsapp_marketing'` existe no vocabulário
sem tela própria (nenhuma campanha para autorizar ainda); serve para que
"finalidade incompatível" seja um cenário real e testável (RPC direto,
`register_contact_consent(..., p_purpose_code => 'whatsapp_marketing')`) —
um contato pode legitimamente ter consentido para atendimento e não para
campanha, e o gate precisa distinguir isso de verdade, não só documentar a
distinção.

**Sem conversão automática de consentimentos antigos**, conforme pedido
explicitamente: `purpose_code` nasce `NULL` para todo registro anterior a
esta migration (e para qualquer canal sem gate de envio ainda) — nunca
inferido do texto livre de `purpose`. Um `NULL` nunca bate com a igualdade
exigida pelo gate, então um consentimento "antigo" (mesmo que vigente pelos
critérios de canal+data) passa a bloquear envio até alguém registrar um
consentimento novo já com a finalidade técnica certa. É o comportamento
correto e pedido, mesmo custando a reautorização de consentimentos
pré-existentes.

## 11. Paginação do histórico — cursor incremental, nunca "carregar tudo"

Diferente do problema corrigido na A6 (Agenda pedia a SEMANA inteira de uma
vez), o histórico de uma conversa é naturalmente incremental: a tela carrega
a página mais recente e paginação "carregar mais antigas" busca por cursor.
Nunca finge que uma falha de carregamento é "conversa vazia", nem que uma
página que falhou é "não há mais mensagens" — erro de rede em qualquer
página mostra estado de erro tratado com nova tentativa, preservando o que
já carregou.

**Revisão pré-merge — cursor composto `(created_at, id)`:** a versão
original usava só `created_at` como cursor e critério de desempate.
`created_at` sozinho não garante ordem total — duas mensagens podem ter o
MESMO timestamp de verdade (ex.: duas linhas na mesma transação, ou
colisão no milissegundo), e nesse caso o corte `created_at < cursor` tanto
podia pular uma mensagem quanto repeti-la entre duas páginas, dependendo de
qual lado do empate cada uma caía. Corrigido: o cursor (e a ordenação, e o
corte de página) usam o par `(created_at, id)` como uma comparação de linha
— `id` (uuid) desempata de forma determinística e única qualquer
`created_at` repetido. `list_conversation_messages()` exige os dois juntos
(`p_before` + `p_before_id`); um sozinho é rejeitado (`invalid_cursor`)
antes de produzir um resultado incoerente. `ConversationThread`/
`loadOlderMessagesAction` sempre repassam o par vindo da mensagem mais
antiga já carregada — nunca só o timestamp.

## 12. Erro de carregamento da Central de Conversas — revisão pré-merge

`listConversations()` tratava erro de consulta (RPC falhou) e "workspace sem
nenhuma conversa de verdade" como a MESMA coisa — os dois casos devolviam
`{items: [], total: 0}`, e a tela mostrava "nenhuma conversa ainda" mesmo
quando a busca tinha falhado. Corrigido com o mesmo padrão já usado em
`ActivitiesLoadError` (A6) e `ConversationMessagesLoadError` (A7 original):
`listConversations()` agora joga `ConversationsLoadError` quando `error` vem
preenchido, e `src/app/(app)/conversas/error.tsx` (novo) mostra erro tratado
com "tentar novamente" — nunca mais uma falha de rede disfarçada de "sem
conversas".
