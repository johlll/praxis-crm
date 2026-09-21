# A11 — Ingestão pública e atribuição multitoque: contrato

Registrado **antes** da implementação, como nas fases anteriores
(`a3-criptografia.md`, `a5-pipeline.md`, `a7-conversas.md`,
`a10-dashboard.md`). Este documento é a especificação que o código
implementa; qualquer mudança aqui muda o código junto.

APIs externas conferidas na documentação oficial antes de escrever
qualquer linha (não de memória):

| Dependência | Versão | O que foi conferido |
|---|---|---|
| `inngest` 4.20.0 | `latest` no registry | `new Inngest({ id })`, `send({ id, name, data })` com `id` como chave de deduplicação (24 h), `serve({ client, functions })` de `inngest/next` exportando `GET/POST/PUT`, `createFunction(config, handler)` com `triggers` na configuração |
| `@upstash/ratelimit` 2.1.0 + `@upstash/redis` 1.39.0 | `latest` | `new Ratelimit({ redis, limiter, prefix })`, `Ratelimit.slidingWindow(n, "60 s")`, retorno `{ success, limit, remaining, reset, pending }` |
| Turnstile siteverify | — | `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`, parâmetros `secret`/`response`/`remoteip`/`idempotency_key`, resposta com `success`, `error-codes`, `challenge_ts`, **`hostname`** e **`action`** |

## 1. Fronteira pública: o que a rota devolve

`POST /api/forms/[endpointKey]` é a **única** entrada pública. Ela nunca
revela estado interno. Toda resposta de aceitação — evento novo, repetição
legítima, evento já processado, evento purgado, evento expirado sem
processamento — é **exatamente a mesma**:

```
202 Accepted
{ "protocol": "<valor opaco>", "status": "received" }
```

Sem `200` para "já processado", sem corpo diferente, sem cabeçalho
revelador. Nunca devolve `event_id` interno, `contact_id`, `lead_id`,
`opportunity_id`, se o contato já existia, se havia demanda anterior,
resultado de deduplicação ou estado do worker. O `protocol` é um valor
aleatório opaco gerado no recebimento (`webhook_events.public_protocol`),
estável para a mesma chave idempotente — serve para o visitante referenciar
o envio, não para inferir nada.

A **única** resposta de aceitação diferente é `409 idempotency_payload_conflict`:
mesma chave idempotente com hash de conteúdo diferente. Também sanitizada,
sem detalhe interno.

Demais recusas (endpoint desconhecido/desabilitado/chave revogada, Turnstile
inválido, honeypot, corpo grande demais, schema inválido, rate limit,
configuração ausente) devolvem erro público **genérico** com código
simbólico curto, sem distinguir "endpoint não existe" de "endpoint
desabilitado" — as duas coisas são `form_endpoint_unavailable`, para não
permitir enumeração de endpoints nem de workspaces.

### Enumeração

Nenhuma resposta pública permite descobrir se um contato, telefone ou
e-mail já existe: o caminho de aceitação é idêntico para visitante novo e
para visitante recorrente.

## 2. `source_event_id` e a chave idempotente

O navegador gera `source_event_id` com `crypto.randomUUID()` **uma vez por
submissão**, guarda em memória e `sessionStorage`, e reutiliza o mesmo UUID
em timeout, perda de conexão e retry da mesma submissão. Renovar o token do
Turnstile **não** troca o UUID. Depois da confirmação definitiva o UUID é
removido; alterar materialmente o conteúdo ou iniciar uma submissão nova
gera um UUID novo. O servidor exige um UUID válido (v4, formato
canônico) — sem ele, recusa antes de qualquer gravação.

Chave idempotente:

```
(workspace_id, form_endpoint_id, source_event_id)
```

`unique` no banco, preservada **mesmo depois da limpeza de retenção** (a
tombstone mantém a linha; só o conteúdo pessoal é eliminado).

### Hash canônico do conteúdo

`content_hash` = SHA-256 sobre a representação canônica **do conteúdo de
negócio**:

- chaves ordenadas lexicograficamente, recursivamente;
- strings com `trim` + `NFC` + colapso de espaços internos em um só;
- e-mail em minúsculas; telefone reduzido a dígitos com prefixo `+`;
- `null`, `undefined`, string vazia e array vazio são omitidos (ausência ≡
  vazio, para que retry com o mesmo conteúdo não vire conflito);
- serialização JSON sem espaços, com números em forma canônica.

**Fora do hash** (variam entre tentativas legítimas da mesma submissão):
token do Turnstile, IP, cabeçalhos, `User-Agent`, timestamps do servidor,
`source_event_id` (já é a chave), honeypot.

Comportamento:

| Caso | Resultado |
|---|---|
| Chave nova | cria evento + outbox, `202` |
| Mesma chave, mesmo hash | reutiliza evento e protocolo, `202` (nada novo é criado) |
| Mesma chave, hash diferente | `409 idempotency_payload_conflict`, nada gravado |
| UUID novo | interação nova (evento novo), `202` |
| Duas requisições simultâneas idênticas | um evento e **uma** outbox (unicidade no banco resolve a corrida) |

## 3. Datas

Quatro campos, nunca confundidos:

| Campo | Significado |
|---|---|
| `occurred_at` | data **declarada** pelo cliente (pode ser mentira) |
| `received_at` | atribuída pelo **banco** no recebimento (`default now()`) |
| `created_at` | persistência da linha |
| `normalized_occurred_at` | a data usada em **toda ordenação e atribuição** |

Normalização para formulário público, calculada no servidor:

| Situação | `normalized_occurred_at` | Código registrado |
|---|---|---|
| Até 5 min no futuro | `occurred_at` | `ok` |
| Mais de 5 min no futuro | `received_at` | `future_clamped` |
| Mais de 24 h no passado | `received_at` | `stale_clamped` |
| Data inválida / ausente | **rejeita antes da ingestão** | `invalid_occurred_at` |

Só o **código** é registrado em claro; o valor declarado original fica
apenas dentro do payload cifrado, sujeito à retenção.

### Crédito de atribuição e ganho

Um touchpoint só pode receber crédito numa oportunidade ganha se

```sql
received_at <= won_at and normalized_occurred_at <= won_at
```

Evento **recebido** depois do ganho nunca recebe crédito, mesmo declarando
data anterior — é exatamente o cenário que a data declarada permitiria
forjar.

## 4. Ciclo de vida do endpoint e falha fechada

`form_endpoints` tem ciclo de vida **próprio**, independente de pipelines e
etapas (que não têm `is_active` no schema — e a A11 **não** inventa esse
estado):

- `status` (`active` | `disabled`) e `disabled_at`;
- a chave pública opaca vive em `form_endpoint_keys` (tabela própria, não
  coluna do endpoint): rotação exige HISTÓRICO, porque a chave anterior
  precisa continuar existindo, marcada com `revoked_at`, para que uma
  página antiga receba a recusa genérica em vez de cair num endpoint
  válido. Índice parcial único garante **uma** chave ativa por endpoint;
- auditoria de criação, alteração, desativação e rotação (`audit_logs`).

Endpoint desabilitado, chave revogada ou configuração incompleta →
`form_endpoint_unavailable` genérico, sem informar workspace nem motivo.
**Desativar um endpoint não remove nem altera eventos já recebidos.**

### Validação da configuração (na criação e a cada processamento)

- pipeline pertence ao workspace;
- etapa pertence ao **mesmo pipeline**;
- etapa com `is_won = false` e `is_lost = false`.

`pipelines.is_default` pode **pré-selecionar** na interface, mas o endpoint
persiste IDs explícitos. O prazo de 60 minutos corridos aparece **apenas no
seed fictício**; nenhum formulário real herda esse valor automaticamente
(o campo é obrigatório na criação).

### Falha fechada sem infraestrutura

Em **produção e preview**, a ausência de configuração obrigatória de
Turnstile, rate limit, Inngest ou cifra causa **falha fechada e
sanitizada** (`service_unavailable`). Nenhuma proteção é desligada em
silêncio porque uma variável faltou. Somente:

- **testes** usam adaptadores/fakes injetados explicitamente;
- **desenvolvimento local** pode usar configuração marcada como de teste
  (`A11_INGEST_MODE=test-adapters`, recusada quando `VERCEL_ENV` é
  `production` ou `preview`).

Ausência ou versão desconhecida da chave de cifra **impede a ingestão antes
de qualquer gravação** — o payload nunca chega ao banco em claro.

## 5. Turnstile, IP e rate limit

Além de `success`, a verificação confere:

- `hostname` ∈ lista de hostnames esperados do endpoint;
- `action` = a action esperada do endpoint.

IP:

- **nunca** aceito do corpo da requisição;
- derivado só dos cabeçalhos confiáveis da Vercel (`x-vercel-forwarded-for`,
  com `x-forwarded-for` como fallback **apenas** fora de produção),
  normalizado;
- usado no rate limit e no `remoteip` do siteverify apenas como
  **HMAC-SHA256 com chave própria** (`A11_IP_HMAC_KEY`) — o IP completo
  nunca vai para Upstash, logs, auditoria, diagnóstico ou
  `webhook_events`.

Rate limit: janela deslizante por `(endpoint, HMAC do IP)` e por
`(endpoint)`, ambos obrigatórios em produção/preview.

## 6. Criptografia do payload bruto

Chave **exclusiva da A11**, separada das chaves de contatos, blind index e
cookie:

```
A11_PAYLOAD_ACTIVE_KEY_VERSION=1
A11_PAYLOAD_KEY_VERSIONS={"1":{"cipher":"<base64 32B>"}}
```

Mesmo algoritmo já validado na A3 — AES-256-GCM, IV de 12 bytes aleatório
por operação, auth tag de 16 bytes — mas com colunas **separadas** em
`webhook_events` (`payload_ciphertext`, `payload_iv`, `payload_auth_tag`,
`payload_algorithm`, `payload_key_version`), como pedido, em vez do formato
concatenado da A3.

O endpoint cifra **antes** de persistir. O worker:

1. roda só no servidor, com o cliente administrativo restrito por lint a
   `src/app/api/webhooks/**` e `src/app/api/cron/**`;
2. lê ciphertext, seleciona a chave pela versão, decifra **em memória**;
3. valida de novo com Zod (nunca confia no que foi gravado);
4. normaliza;
5. envia à RPC transacional **apenas os campos necessários**;
6. nunca persiste plaintext temporário, nunca manda plaintext para log,
   auditoria, erro ou Sentry.

`payload_sanitized` (diagnóstico) contém apenas: contagem de campos,
comprimentos, códigos de normalização, domínio do e-mail, DDD do telefone e
flags booleanas. **Nunca** telefone completo, e-mail completo, CPF,
respostas livres ou conteúdo de mensagem.

Rotação: documentada aqui (mesmo procedimento da A3, com script próprio),
**não executada** nesta fase.

## 7. Ingestão, outbox, Inngest e worker

### Transação de ingestão (uma só)

1. reserva/confere a chave idempotente;
2. compara o hash;
3. insere **ou recupera** o evento;
4. gera/preserva o protocolo público;
5. insere outbox **somente para evento novo**.

Depois do commit, tenta publicar no Inngest. Falha de publicação **não**
desfaz a ingestão — o outbox já está gravado.

### Publicação

`webhook_event_id` é o identificador estável enviado ao Inngest (`id` do
evento). Se o envio der certo e a resposta se perder, o cron pode
republicar o mesmo id sem duplicar efeito.

### Cron (reconciliador)

Encontra outbox `pending`/`publishing` vencida, usa locking seguro
(`for update skip locked` + `next_attempt_at`), republica no Inngest,
registra tentativa. **Nunca executa efeito comercial** — só republica.

### Worker

Chama **uma** RPC transacional que bloqueia o evento
(`select ... for update`) e, numa única transação:

verifica se já foi processado → resolve/cria contato → registra candidato a
duplicidade → resolve/cria demanda → resolve/cria oportunidade → cria
touchpoint → cria vínculo determinístico quando necessário → registra
evidência de consentimento → cria atividade **somente para demanda nova** →
salva referências resultantes → marca o evento como processado.

Falha em qualquer etapa desfaz tudo. Worker concorrente encontra o evento
processado ou bloqueado e não repete efeito. A garantia é **at-least-once
com efeitos idempotentes**, nunca exactly-once.

## 8. Identidade, demanda e oportunidade

Ordem segura de resolução:

1. **referência de continuidade válida** (token opaco, guardado só por
   hash, com workspace/contato/lead/oportunidade/finalidade/validade/
   revogação);
2. **identidade externa confiável** do mesmo workspace e provedor
   (`contact_identifiers`);
3. sem identidade confiável.

Telefone e e-mail **normalizam**, **levantam candidato a duplicidade** e
**nunca reutilizam o contato automaticamente** — a mesma regra da A3.
Telefone e e-mail **não são** referências de continuidade.

Se a identidade confiável resolve apenas a **pessoa**:

- nova captação explícita → **nova demanda**;
- continuidade precisa apontar lead/oportunidade explicitamente;
- nunca escolher "lead mais recente" nem "oportunidade aberta mais recente".

Sem identidade confiável: cria contato, registra candidato quando houver
sinais, cria a nova demanda.

Continuidade confiável apontando para oportunidade **encerrada**:

- cria touchpoint e mantém o vínculo com a oportunidade encerrada;
- **não** reabre, **não** cria oportunidade nova, **não** cria atividade.

Nova demanda nasce **apenas** quando o evento é nova captação explícita ou
não existe continuidade confiável. A atividade inicial nasce **somente**
junto com a demanda nova. Eventos de nova captação da A11 gravam o
touchpoint **diretamente com a oportunidade criada** (`opportunity_id`
preenchido na origem).

## 9. Atribuição sem cruzar oportunidades

A A5 permite um lead com várias oportunidades. **O mesmo `lead_id` nunca é
suficiente.** Para a oportunidade `O` são elegíveis apenas:

- touchpoint originalmente ligado **diretamente** a `O`, sujeito à cadeia
  vigente; **ou**
- touchpoint cujo **vínculo vigente** em `touchpoint_demand_links` aponta
  para `O`.

Nunca elegíveis automaticamente: touchpoint só do contato, só do lead, ou
de outra oportunidade do mesmo lead.

### Primeiro toque

```
normalized_occurred_at ASC, received_at ASC, id ASC
```

### Último toque

Último elegível **antes do ganho**:

```
normalized_occurred_at DESC, received_at DESC, id DESC
```

### Conversão (regra mais restrita, sem opção configurável nesta fase)

Exige que o touchpoint tenha sido **originalmente criado** com
`opportunity_id = O.id`. O vínculo vigente sempre prevalece:

| Original | Vínculo vigente | Conversão de O? |
|---|---|---|
| em O | nenhum override | ✅ elegível |
| em O | `unassign` | ❌ |
| em O | transferido para outra | ❌ |
| em O | continua apontando para O | ✅ |
| sem O | corrigido para O | ❌ (participa de 1º/último toque, não da conversão) |
| em outra | transferido para O | ❌ |

Sem touchpoint elegível → **"Não atribuído"**.

## 10. Vínculo versionado (`touchpoint_demand_links`)

Append-only. Cada linha: touchpoint, oportunidade (nullable),
`action` (`assign` | `unassign`), `supersedes_id`, motivo, ator,
timestamps.

Invariantes garantidas no banco:

- uma única **raiz** por touchpoint (`supersedes_id is null`);
- `supersedes_id` usado **no máximo uma vez** (unique parcial);
- predecessor do **mesmo touchpoint e workspace**;
- ausência de ciclos (uma linha nunca sucede a si mesma; a cadeia é
  garantida acíclica pelas duas regras acima somadas à raiz única);
- uma única **ponta vigente** (a folha da cadeia);
- correção **exclusivamente** por RPC transacional;
- concorrência: duas correções da mesma versão — uma vence, a outra recebe
  `link_version_conflict`.

Precedência: sem cadeia, vale o vínculo original; com cadeia, só a ponta
vigente; `unassign` vigente torna o touchpoint não atribuído; correção para
outra oportunidade substitui a anterior; **histórico nunca é apagado**.

## 11. Consentimento

`contact_consents` permanece **exatamente** como está (contrato da A7
preservado, incluindo `purpose_code` e o gate de envio). A A11 acrescenta
`consent_evidence`, append-only e versionada:

concessão ou recusa, `purpose_code`, base legal, canal, versão e hash do
texto aceito, instante, endpoint/formulário, evento, evidência mínima e —
**apenas se a política permitir** — HMAC do IP.

Consentimento do formulário e `whatsapp_atendimento` são **finalidades
separadas**: uma nunca é derivada da outra. Receber um formulário não
autoriza envio ativo por WhatsApp.

## 12. Retenção e evento não processado

```
expires_at = received_at + 30 dias
```

A função de limpeza, o endpoint protegido e os testes pertencem à A11; só
a **ativação do cron definitivo** depende de infraestrutura externa.

### Antes do vencimento

Evento fora do tempo operacional esperado (`received_at` + `stuck_after`,
padrão 60 min, sem `processed_at`) é marcado como **travado**
(`is_stuck`), gera alerta estruturado e auditoria **sem PII**. A regra não
depende de Sentry. Há alerta antecipado antes dos 30 dias
(`expires_at` − 7 dias).

### No vencimento — evento terminal já processado

Elimina ciphertext, IV, auth tag, payload sanitizado e diagnóstico
temporário. **Preserva a tombstone**: chave idempotente, hash, protocolo,
status final, referências resultantes, timestamps mínimos e códigos não
sensíveis.

### No vencimento — evento ainda não processado

**Nunca apagado em silêncio.** Na mesma operação transacional:

1. marca `expired_unprocessed`;
2. grava auditoria sem PII;
3. produz alerta estruturado;
4. torna o evento **inelegível** para novo processamento;
5. elimina ciphertext e diagnóstico temporário;
6. preserva a tombstone idempotente.

Depois disso: replay idêntico continua devolvendo `202` com o **mesmo
protocolo**, não cria evento novo, não cria efeito comercial; mesma chave
com hash diferente continua devolvendo `409`.

A função opera **em lotes**, é idempotente e segura sob duas execuções
concorrentes (`for update skip locked`).

## 13. Mesclagem e desfazer

`merge_contacts()`/`unmerge_contact()` são estendidas em **migration nova**
(nunca editando a anterior) para reparentar, além do que já tratam:
`touchpoints`, `touchpoint_demand_links`, `continuity_references` e
`consent_evidence`. Snapshot mínimo, detecção de alteração posterior,
reversibilidade e isolamento preservados; nada do que já era tratado
regride.

## 14. Segurança e permissões

- Workspace **sempre** derivado do endpoint no servidor; nunca aceito do
  navegador.
- `service_role` restrita a webhooks/jobs pela regra de lint já existente.
- Funções `SECURITY DEFINER` com `search_path` fixo e `EXECUTE` mínimo.
- RLS **habilitada e forçada** em todas as tabelas novas.
- Sem CRUD direto desnecessário para `authenticated`/`anon`.
- Recurso de outro workspace responde como **não encontrado**.
- Campos proibidos por papel não chegam ao navegador.
- Configuração de endpoint restrita a **owner/admin**.
- Correção de vínculo segue a matriz de ação sensível já vigente e gera
  auditoria.

## 15. Fora desta fase

Automações (C1), mensagens automáticas, Google Agenda (B2), WhatsApp real
(B3), propostas/PDF (B1), documentos (B4), IA, importação em massa, campos
personalizados, calendário comercial/horas úteis, alteração da
landing/quiz, estado ativo/inativo de pipelines e separação física de
ambientes.

## 16. Decisões tomadas durante a implementação

Três pontos que o contrato acima não podia antecipar e que o código real
obrigou a decidir. Ficam registrados aqui, não escondidos no diff.

### 16.1 O bloco de origem do painel é função separada

`get_dashboard_attribution` não foi acrescentada a `get_dashboard` (A10).
Motivo: a **unidade** é diferente. O painel da A10 conta **leads**; a
atribuição conta **oportunidades**. Um lead pode ter várias oportunidades
com origens diferentes — filtrar "leads recebidos" por origem trocaria a
unidade no meio do caminho e produziria um número que ninguém consegue
explicar. O bloco declara a unidade no próprio payload (`unit`), e o
filtro de origem vale só dentro dele.

Consequência aceita: filtrar por origem **não** muda os cartões de
"Leads recebidos", "Consultas" etc. A interface diz isso.

### 16.2 Telefone brasileiro sem código de país

Achado por teste, não por leitura: prefixar `+` num número digitado como
`11988887777` produzia `+11988887777` — E.164 sintaticamente válido, mas
com código de país **1** (Estados Unidos). Passaria no `CHECK` do banco e
ficaria errado para sempre.

`toE164BR()` só assume Brasil quando o formato é inequívoco (DDD de 11 a
99 + 8 ou 9 dígitos, ou já com `55`). Qualquer outra coisa vira `null`:
**melhor não gravar telefone do que gravar um número que não existe.** O
hash de conteúdo continua usando a forma só-dígitos, que é estável entre
tentativas.

### 16.3 Cliente do Inngest inerte na construção

Achado pelo build: exigir a configuração dentro de `inngestClient()`
fazia o Next falhar ao coletar os dados de `/api/inngest` em tempo de
**build** — derrubando o aplicativo inteiro num ambiente que ainda não
tem as variáveis. `new Inngest({ id })` passou a ser inerte, e a falha
fechada mudou para onde ela pertence: a **publicação** e o atendimento da
rota, por requisição. O build funciona sem nenhuma variável da A11; só as
rotas de ingestão e de jobs respondem `503` sanitizado.

### 16.4 Limite conhecido: `touchpoints.position` depois de uma mesclagem

`position` é a ordem de chegada **dentro de um contato**. Depois de
mesclar dois contatos, duas sequências convivem no mesmo contato e as
posições podem repetir. Nada depende disso: toda ordenação e toda
atribuição usam `(normalized_occurred_at, received_at, id)`.
