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
`granted_at is not null`, `revoked_at is null`, para o contato da conversa.
Ausência de registro = sem consentimento (nunca presumido). Criar contato a
partir de mensagem recebida (§6) NUNCA grava `contact_consents` — receber
não é autorização para enviar.

**Decisão de produto sem correspondência exata no plano** (`purpose` é texto
livre no schema da A3, sem vocabulário fechado): o gate técnico verifica
canal + vigência, não um texto de finalidade específico — `purpose` é
gravado e exibido para fins de auditoria/LGPD (qual foi a finalidade
autorizada), mas não further restringe quais envios são permitidos nesta
fase. Uma taxonomia fechada de finalidades fica para quando o escritório
definir isso de verdade (marco B/C) — sinalizado no handoff como decisão
tomada, não como lacuna do código.

## 11. Paginação do histórico — cursor incremental, nunca "carregar tudo"

Diferente do problema corrigido na A6 (Agenda pedia a SEMANA inteira de uma
vez), o histórico de uma conversa é naturalmente incremental: a tela carrega
a página mais recente e paginação "carregar mais antigas" busca por cursor
(`created_at` da mensagem mais antiga já carregada). Nunca finge que uma
falha de carregamento é "conversa vazia", nem que uma página que falhou é
"não há mais mensagens" — erro de rede em qualquer página mostra estado de
erro tratado com nova tentativa, preservando o que já carregou.
