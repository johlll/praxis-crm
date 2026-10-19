# B3 — WhatsApp real: levantamento técnico e plano

Status: **plano para revisão. Nenhuma implementação foi feita.** Este
documento não cria código, migration, variável nem configuração externa.
A implementação só começa depois da revisão e aprovação deste plano e das
decisões do §12.

Base: `main` no merge da PR #40 (`666a7eb`). Fontes oficiais da Meta e da
YCloud consultadas em 19/10/2026 (lista no §13). O que não foi confirmado
na documentação oficial está marcado como **a validar**.

Escopo: B3 do plano (conexão real do WhatsApp com o CRM). A B2 não é
reaberta. O chatbot externo da Vizentini é um projeto separado: não é
alterado, copiado nem incorporado aqui. Automações comerciais pertencem à
C1.

## 0. Resumo

- A A7 deixou pronta a parte que não depende do provedor: modelo de
  conversa, idempotência de entrada, estados que não regridem, gate de
  consentimento, reenvio idempotente, paginação, permissões e a tela. O
  que é simulado está concentrado no canal, no envio e nas duas funções de
  entrada do simulador.
- Há quatro lacunas estruturais que a coexistência e as mudanças recentes
  da Meta expõem:
  1. o telefone do cliente pode não vir no evento (identificador por
     conta, o BSUID);
  2. existem mensagens de saída que não nascem no CRM: as enviadas pelo
     celular do escritório e as enviadas pelo chatbot;
  3. não há janela de 24 horas, template, mídia nem envio assíncrono;
  4. a entrada do simulador exige um usuário logado, e o webhook real não
     tem usuário.
- **Recomendação:** YCloud com coexistência para o piloto, atrás de uma
  interface de provedor própria do CRM. A Meta direta fica como
  alternativa futura. O piloto começa com **número dedicado de teste**,
  nunca no número do chatbot, até existir um contrato de passagem entre o
  chatbot e o atendimento humano.

## 1. Estado atual da A7

### 1.1 O que existe

| Peça | Onde | Papel hoje |
|---|---|---|
| Tipos do payload | `src/server/whatsapp/types.ts` | Formato da Cloud API da Meta, só texto e 4 status |
| Normalizador | `src/server/whatsapp/normalize-event.ts` | Payload da Meta → eventos planos (`inbound_message`, `status_event`) |
| Simulador | `src/server/whatsapp/simulator.ts` | Fabrica payload no formato da Meta |
| Ações | `src/modules/conversations/actions.ts` | Canal, simulação, envio, vínculo, consentimento, paginação |
| Consultas | `src/modules/conversations/queries.ts` | Listas e histórico, com erros de carga distintos de "vazio" |
| Validação | `src/modules/conversations/schema.ts` | Zod de todas as entradas |
| Telas | `src/app/(app)/conversas/**`, `configuracoes/simulador-whatsapp` | Central, conversa, simulador |
| Componentes | `src/components/conversations/*`, `leads/lead-conversations-list.tsx` | Thread, composer, consentimento, vínculo pendente |
| Esquema | `supabase/migrations/20260911140000…150000_a7_*` | 4 tabelas, RLS, funções, endurecimento |
| Permissões | `src/lib/roles.ts` | `conversation.view/send/link/simulate`, `contact.consent_manage` |
| Testes | `whatsapp-normalize-event`, `conversation-messages-pagination`, `conversations-list-error`, `send-message-result-mapping`, pgTAP `12_a7_conversations`, `scripts/a7-concurrency-check.mjs`, e2e `conversations.spec.ts` | Normalização, paginação, erros, idempotência, concorrência real, fluxo de ponta a ponta |

Tabelas: `whatsapp_channels`, `conversations`, `messages`,
`message_status_events`, além de `contact_identifiers` e
`contact_consents` (A3, com `purpose_code` da A7) e
`activities.source_conversation_message_id`. `conversations`, `messages` e
`message_status_events` são deny-all: toda leitura e escrita passa por
função `SECURITY DEFINER`. `whatsapp_channels` tem SELECT direto por
workspace e mutação só por RPC de owner/admin.

### 1.2 Reaproveitável sem alteração

- **Resolução do workspace pelo canal cadastrado**, nunca por campo do
  payload (a7-conversas §2).
- **Resolução de identidade em camadas**: `contact_identifiers` primeiro,
  telefone depois, ambiguidade nunca escolhida (§5), com o vínculo pendente
  resolvido por `resolve_conversation_link()` e o banner da tela.
- **Idempotência de entrada** por `(channel_id, wa_message_id)` e o
  `pg_advisory_xact_lock` por remetente antes da checagem (§8).
- **Reenvio de saída** com `client_dedupe_key` imutável e
  `content_conflict` (§8, revisão).
- **Log bruto de status** separado da projeção (`message_status_events` ×
  `messages.status`).
- **Gate de consentimento** `private.contact_has_active_consent` com
  `purpose_code = 'whatsapp_atendimento'` e o painel de registro e
  revogação (§10).
- **Paginação** por cursor `(created_at, id)` e os erros de carga
  `ConversationsLoadError` / `ConversationMessagesLoadError`.
- **Alcance por papel** `private.conversation_accessible_to_role`.
- **Normalizador da Meta**: continua sendo a peça do adaptador Meta, se ele
  vier a existir.

### 1.3 Reaproveitável com ajuste

- `NormalizedInboundMessage` e `NormalizedStatusEvent`: o formato plano
  serve, mas precisa de identidade sem telefone (BSUID), mídia, origem da
  mensagem e o identificador de evento do provedor.
- `private.message_status_rank`: a regra "`failed` só a partir de
  `queued`/`sent`, e nada depois de `failed`" ignora um `delivered` que
  chega depois de um `failed`. A YCloud documenta que `delivered` pode vir
  depois de `failed` e vice-versa, e que podem chegar vários `delivered`
  para a mesma mensagem. A regra precisa deixar a prova de entrega
  (`delivered`/`read`) prevalecer sobre um `failed` anterior, sem nunca
  regredir de `delivered`/`read` para `failed`.
- `message_status`: falta um estado para "aceita pelo provedor, aguardando
  envio" e um para "resultado incerto". A Meta também tem `played`
  (primeira reprodução de áudio), que deve ir só para o log.
- Componentes da conversa: a thread e o composer servem; faltam a origem
  da mensagem (CRM, celular, automação externa), mídia, aviso de janela e
  envio de template.

### 1.4 Acoplado ao simulador ou ao payload da Meta

- `types.ts` aceita só `type: "text"` e os 4 status; o tipo assume
  `metadata.phone_number_id`, que é o campo da Meta. **A YCloud não manda
  `phone_number_id` nos exemplos de entrada**: manda `wabaId` e `to` (o
  número do escritório em E.164). A chave de roteamento precisa ser por
  provedor.
- `simulate_inbound_whatsapp_message()` e `apply_message_status_event()`
  exigem `auth.uid()` e papel owner/admin. O webhook real não tem usuário:
  precisa de funções próprias, executáveis só pelo papel de serviço.
- A auditoria grava `'simulated': true` fixo; a mensagem recebida nasce
  `delivered`.
- `send_message()` gera `wamid.sim.…`, grava `sent` na hora e não chama
  transporte nenhum; `is_simulator` nunca é consultado no envio.
- `conversations.wa_id` é `NOT NULL` com regex E.164: uma conversa sem
  telefone (só BSUID) é rejeitada pelo banco.
- `messages.body_text` é `NOT NULL` (1 a 4096): mídia sem legenda é
  rejeitada.
- `messages` exige `sent_by` e `client_dedupe_key` em toda saída: as
  mensagens do celular do escritório, do chatbot e do histórico importado
  não têm nem um nem outro.
- `whatsapp_channels.is_simulator` nasce `true`; não há provedor,
  ambiente, credencial nem estado de saúde do canal.
- A tela mostra "SIMULAÇÃO" e o botão de simular status.

### 1.5 O que falta

| Área | Falta |
|---|---|
| Rotas | Webhook público por provedor; rota de mídia autenticada; reconciliador agendado |
| Serviços | Interface de provedor, adaptador YCloud, provedor simulado novo, cliente de mídia |
| Tabelas | Caixa de entrada durável do webhook (cifrada), outbox de envio, credenciais cifradas do canal, mídia, eventos de saúde do canal, eventos de domínio para a C1 |
| Colunas | Identidade BSUID e telefone opcional na conversa; origem e id do provedor na mensagem; última mensagem do cliente (janela); ambiente do canal |
| Funções | Entrada e status via papel de serviço; envio em duas fases (reservar e confirmar); template; reconciliação |
| Permissões | Administrar o canal (conectar, pausar, desconectar); enviar template; ver mídia |
| Operação | Batimento do webhook, alerta de webhook parado, desligamento controlado, reautorização |

### 1.6 Decisões da A7 que continuam válidas

Todas as do `docs/decisoes/a7-conversas.md` continuam valendo, com os
ajustes já listados: §2 (workspace pelo canal, agora com chave de
roteamento por provedor), §4 (conversa por canal e identidade do
cliente), §5 e §7 (resolução sem palpite, agora com BSUID), §8
(idempotência em camadas), §9 (estados não regridem, com o ajuste do
`failed`), §10 (consentimento verificado no servidor), §11 e §12.

### 1.7 Hipóteses a rever na coexistência

| Hipótese da A7 | Realidade com o número em coexistência |
|---|---|
| Toda saída nasce no CRM | O escritório responde pelo celular (eco), o chatbot responde pela API e o histórico é importado |
| O CRM é o único que responde | O chatbot e o advogado também respondem pelo mesmo número |
| O telefone sempre vem no evento | Pode faltar quando o cliente usa nome de usuário (§2, BSUID) |
| Número desconhecido = cliente novo (§6) | Eventos de histórico, ecos do celular e contatos já atendidos pelo chatbot não podem criar lead nem atividade |
| Envio síncrono e garantido | O provedor aceita e confirma depois; o resultado pode ser incerto |
| Janela irrelevante | Texto livre só com a janela de 24 h aberta; mensagens do celular não abrem nem estendem a janela da API |
| `phone_number_id` roteia | Na YCloud, a chave é `wabaId` + número do escritório |

### 1.8 Padrões de outras fases reaproveitados

- **A11:** caixa de entrada cifrada (AES-256-GCM, colunas separadas, chave
  exclusiva), outbox com reconciliador `for update skip locked`, Inngest
  com `id` estável, falha fechada sem configuração, retenção com
  tombstone, `payload_sanitized` sem PII.
- **B2:** contrato de provedor com provedor simulado
  (`src/server/calendar/provider.ts`), assinatura de ambiente
  `X-Praxis-Env` (Preview e Production compartilham o Supabase), cifra de
  credenciais com chave por ambiente e AAD (`token-crypto.ts`), webhook
  que responde 404 quando o provedor não está configurado, agendador e
  alertas desligáveis.
- **B1:** bucket privado do Storage acessado só pelo servidor.
- **A1/A2:** cliente administrativo restrito por lint a
  `src/app/api/webhooks/**` e `src/app/api/cron/**`.

## 2. Comparação oficial Meta × YCloud

A. **Meta WhatsApp Cloud API diretamente.** B. **YCloud com WhatsApp
Business App Coexistence.** A YCloud é um provedor (BSP) que opera sobre a
mesma Cloud API da Meta: regras de janela, template, preço e BSUID são da
Meta nos dois casos.

| Critério | A. Meta direta | B. YCloud com coexistência |
|---|---|---|
| Continuar usando o WhatsApp Business no celular | Sim, pela coexistência. Mas o onboarding de coexistência é só para **Solution Partner ou Tech Provider** | Sim. É o produto padrão ("WhatsApp Business APP Coexistence") |
| Processo de conexão | Tornar-se Tech Provider: verificação da empresa, App Review com dois vídeos (envio e criação de template), Embedded Signup (v2 descontinuada em 15/10/2026; usar v4) com `featureType: whatsapp_business_app_onboarding` | Console da YCloud → criar canal de coexistência → número do app → QR code no celular → escolha do histórico → autorização Meta. Rota "Facebook" (portfólio próprio) ou "QR code"; as duas exigem verificação da empresa |
| Propriedade do número | O número continua da empresa e registrado no app | Igual. Na rota "Facebook", a conta WhatsApp fica no portfólio Meta da própria empresa. Na rota "QR code", o portfólio que detém a conta é **a validar** |
| Recebidas | Webhook `messages` | `whatsapp.inbound_message.received` |
| Enviadas pelo celular | `smb_message_echoes`, que a Meta manda exibir no histórico | `whatsapp.smb.message.echoes` |
| Enviadas pela API por outro sistema (chatbot) | Não geram eco. Só os status chegam a quem enviou | Endpoints da YCloud são por conta (até 20). `whatsapp.message.updated` traz o conteúdo da mensagem; se ele chega a todos os endpoints da conta, inclusive para mensagens de outra chave, é **a validar** |
| Status | `sent`, `delivered`, `read`, `failed`, `played`; `delivered` pode ser pulado quando lida | `accepted` (resposta do envio), depois `sent`, `delivered`, `read`, `failed`; ordem não garantida; `delivered` pode vir depois de `failed` e repetir |
| Assinatura | `X-Hub-Signature-256`: HMAC-SHA256 do corpo bruto com o segredo do app; verificação inicial com `hub.verify_token` e `hub.challenge`; mTLS opcional | `YCloud-Signature: t=…,s=…`: HMAC-SHA256 de `"{t}.{corpo bruto}"` com o segredo do endpoint; tolerância de tempo é política nossa (5 min no exemplo); rotação do segredo por API |
| Retries | Até 7 dias, com frequência decrescente; duplicatas possíveis; responder 200 | 7 retries (10 s, 30 s, 5 min, 30 min, 1 h, 2 h, 2 h); responder 2xx em menos de 6 s; endpoint pode ser suspenso ou ficar `pending` |
| Duplicação e ordem | Duplicatas documentadas; ordem não documentada | Deduplicar pelo `id` do evento; ordem explicitamente não garantida |
| Janela de 24 h | Aberta por mensagem ou ligação do cliente; renovada a cada mensagem dele; fora dela, só template | Igual (regra da Meta). Mensagens do celular e histórico importado **não** abrem nem estendem a janela da API |
| Texto livre e template | Texto livre só na janela; template aprovado fora dela | Igual; envio por fila (`POST /v2/whatsapp/messages`) ou síncrono (`sendDirectly`) |
| Texto, áudio, imagem, documento, vídeo | Todos. Imagem JPEG/PNG até 5 MB; áudio AAC/AMR/MP3/M4A/OGG-Opus até 16 MB; vídeo MP4/3GP até 16 MB; documento até 100 MB | Todos (mesma base); upload de mídia pela API da YCloud |
| Download de mídia | ID → URL temporária (**5 min**) → download com o token; IDs vindos do webhook valem **7 dias**; a Meta guarda a mídia 30 dias | `link` acessível direto por poucos minutos; com o cabeçalho `X-API-Key`, por **30 dias** |
| Ids das mensagens | `wamid` | `wamid` + `id` da YCloud + `externalId` (nosso, opcional) |
| Idempotência do envio | Não documentada no envio | **Não tem**: um POST repetido pode duplicar; usar `externalId` e reconciliar pelo webhook antes de repetir |
| Limites | Coexistência: 20 mps fixos | Coexistência: 5 mps documentados pela YCloud; API: 200 rps por número (fila) |
| Custo da Meta | Por mensagem entregue. **Desde 01/10/2026:** mensagens de atendimento acima de 1.000 por número por mês são cobradas; template utility dentro da janela passa a ser cobrado. Mensagens do celular continuam grátis | O mesmo custo da Meta, repassado pela YCloud, que declara "zero mark-up" |
| Custo do intermediário | Nenhum. No Brasil, a cobrança direta da Meta deve migrar para BRL até 30/06/2027 | Plano Free US$ 0 (inclui API, 2 canais); Growth US$ 39, Pro US$ 89, Enterprise US$ 399 por mês; canal extra US$ 5/mês; usuário extra US$ 10/mês. A página fala em cobrança mínima após 30 dias se houver suporte, sem valor |
| Dependência do fornecedor | Só da Meta. Custo alto de entrada (Tech Provider) e de manutenção (App Review, mudanças da plataforma) | Da YCloud para webhook, envio, mídia e chave de API. As regras continuam da Meta |
| Portabilidade | Número e conta da empresa | Sair da coexistência é feito no celular (Configurações > Conta > Plataforma comercial). Trocar de parceiro exige novo onboarding; o histórico só pode ser sincronizado uma vez por onboarding, em 24 h |
| Compatibilidade com a A7 | O normalizador atual já lê o formato da Meta | Exige um parser próprio para o mesmo formato normalizado |
| Compatibilidade com o chatbot | O chatbot usa a YCloud; o mesmo número com dois parceiros ao mesmo tempo é **a validar** e pode exigir desconectar a YCloud | O CRM entra na mesma conta YCloud do número, com endpoint próprio, sem tocar no projeto do chatbot. Chave de API separada para o CRM é **a validar** |
| Risco de dois sistemas responderem | Igual | Igual. A YCloud recomenda decidir quem responde e pausar a automação quando uma pessoa assume |

Outros fatos oficiais que afetam a B3:

- **BSUID (identificador por conta empresarial).** Desde abril de 2026
  vem nos webhooks (`user_id`, `from_user_id`; na YCloud, `fromUserId`,
  `toUserId`, `recipientUserId`). Com o nome de usuário ativado, o
  telefone do cliente pode ser **omitido** do evento, salvo interação nos
  últimos 30 dias com aquele número do escritório ou se ele estiver na
  agenda de contatos da Meta. Desde julho de 2026, dá para enviar ao
  BSUID. O BSUID muda se o cliente trocar de telefone. A Meta avisa que
  quem não suportar o BSUID perde a capacidade de processar as mensagens
  dessas pessoas.
- **Coexistência, limites.** Não há grupos, mensagens temporárias,
  visualização única, localização em tempo real nem listas de
  transmissão. Mensagens de/para WhatsApp para Windows e WearOS **não
  geram webhook**. Celular principal inativo por cerca de 14 dias
  desconecta (`PRIMARY_INACTIVITY`). Eventos `account_offboarded`,
  `account_reconnected` e `account_update` com `PARTNER_REMOVED`.
- **Histórico.** Até 180 dias, uma vez por onboarding; mídia só dos
  últimos 14 dias.

**Divergências entre as fontes oficiais:**

- vazão na coexistência: 20 mps (Meta) × 5 mps (YCloud);
- janela gratuita de anúncio: "até 7 dias" (Meta) × 72 h (YCloud);
- a página "WhatsApp billing rules" da YCloud ainda diz que atendimento e
  utility dentro da janela são grátis, o que a página de preços da própria
  YCloud e a da Meta já corrigiram para 01/10/2026;
- validade dos IDs de mídia do webhook: a Meta mudou de 30 para 7 dias.

Nenhuma delas muda a recomendação. Atendimento humano não chega perto de
5 mps.

## 3. Recomendação

**YCloud com coexistência no piloto, atrás de um adaptador de provedor do
CRM.** Fundamentos:

1. O número do escritório já está em coexistência pela YCloud, por causa
   do chatbot. A Meta direta exigiria que o Praxis virasse Tech Provider
   (verificação, App Review, Embedded Signup v4), um custo de entrada alto
   para um único escritório. Também poderia exigir tirar o número da
   YCloud, o que derruba o chatbot (**a validar**).
2. O custo de mensagens da Meta é o mesmo nos dois caminhos. O custo
   adicional da YCloud é o plano (o Free inclui API) e canais extras.
3. Mídia por 30 dias com a chave reduz o risco de expiração; na Meta, a
   URL dura 5 minutos.
4. O formato normalizado da A7 isola o CRM do provedor: trocar de
   provedor troca o adaptador, não o domínio.

**O que a recomendação não decide:** usar o número do chatbot. O piloto
começa com um número dedicado de teste (§12, decisão 2), porque hoje uma
resposta humana enviada pelo CRM pela API **não pausa o chatbot**. O
chatbot pausa com o eco do celular, e o envio pela API não gera eco.

**Custo do adaptador para não ficar preso:**

- **Interface** `WhatsAppProvider` (mesmo padrão do `CalendarProvider` da
  B2), com provedor simulado e YCloud. Entra na etapa B3.1, sem custo
  relevante a mais: o simulador precisa ser refeito de qualquer forma,
  porque não tem webhook, mídia nem envio assíncrono.
- **Adaptador Meta, se um dia for preciso:**
  - o parser já existe (`normalize-event.ts`);
  - faltam assinatura `X-Hub-Signature-256`, verificação `hub.challenge`,
    envio pela Graph API e download de mídia em dois passos;
  - tamanho estimado: uma etapa comparável à 4a da B2;
  - o processo de Tech Provider é à parte e mais lento que o código.
- **Manutenção contínua:**
  - fixtures de contrato por provedor, a partir dos exemplos oficiais;
  - revisão dos changelogs da Meta (BSUID, preço, Embedded Signup) e da
    YCloud a cada etapa;
  - nenhum tipo do provedor sai do adaptador.

## 4. Arquitetura proposta

### 4.1 Fluxo de entrada

```
Provedor ──POST──▶ /api/webhooks/whatsapp/[provider]
                     1. lê o corpo bruto; verifica a assinatura (falha → 401)
                     2. resolve o canal pela chave de roteamento do provedor
                        (desconhecido, desligado ou de outro ambiente → 404)
                     3. grava na caixa de entrada CIFRADA, única por
                        (canal, id do evento do provedor) → 2xx
                     4. publica no Inngest com id = id da caixa de entrada
                        (falha não desfaz o passo 3)
Inngest worker ──▶ decifra em memória → Zod → adaptador.parse()
                     → eventos normalizados → RPC de serviço por evento
                     (entrada, eco, status, conta, sistema), cada uma
                     idempotente e transacional
Cron reconciliador ──▶ republica caixa de entrada parada (padrão A11)
```

### 4.2 Fluxo de saída humana

```
Composer ──▶ sendMessageAction (requirePermission + Zod)
   ──▶ RPC reserve_outbound_message:
        acesso, vínculo, consentimento, janela (com margem), canal ativo;
        grava a mensagem 'queued' com client_dedupe_key e a outbox
        (mesma transação)
   ──▶ Inngest (id = id da mensagem) ──▶ adaptador.send(externalId = id)
        aceito  → 'accepted' + id do provedor
        recusado → 'failed' + motivo legível
        timeout/rede → 'uncertain' (nunca reenvia sozinho)
   ──▶ webhook de status (por externalId ou wamid) atualiza a projeção
   ──▶ reconciliador: 'uncertain' é conferido pelo webhook ou pela consulta
        do provedor; continua incerto → visível para decisão humana
```

### 4.3 Mudanças de dados (para as migrations das etapas)

| Objeto | Mudança |
|---|---|
| `whatsapp_channels` | `provider` (`simulated`/`ycloud`/`meta`), `environment` (`preview`/`production`), chave de roteamento por provedor (`provider_account_ref` + número E.164; `phone_number_id` só para a Meta), `status` com `paused` e `disconnected`, `last_event_at`, `send_enabled` |
| `whatsapp_channel_credentials` (nova) | Chave de API e segredo do webhook cifrados (padrão B2, AAD = ambiente + workspace + canal); deny-all |
| `whatsapp_webhook_inbox` (nova) | Corpo cifrado, hash, id do evento, tipo, estado, tentativas, `expires_at`; única por `(channel_id, provider_event_id)` |
| `conversations` | `wa_id` passa a opcional; `wa_user_id` (BSUID) opcional; ao menos um dos dois; unicidade por canal e identidade; `last_inbound_at` (janela) |
| `contact_identifiers` | Novo provedor `whatsapp_bsuid`; vínculo de troca de número pelos eventos de sistema |
| `messages` | `origin` (`crm`, `business_app`, `external_api`, `history`, `inbound`); `provider_message_id`; `wa_message_id` opcional até a aceitação; `body_text` opcional com mídia; `sent_by` e `client_dedupe_key` exigidos só para `origin = 'crm'`; `template_name`, `template_language` |
| `message_status` | `accepted` e `uncertain`; `played` só no log |
| `message_media` (nova) | Tipo, MIME, tamanho, SHA-256, referência do provedor, caminho no Storage, estado do download, `expires_at`; deny-all |
| `whatsapp_outbox` (nova) | Uma por mensagem de saída; estados e travas do padrão A11 |
| `whatsapp_channel_events` (nova) | Saúde do canal: desconexão, reconexão, recusa de credencial, webhook parado |
| `whatsapp_domain_events` (nova) | Eventos para a C1, só gravados (§5.4) |

## 5. Fronteira B3 × chatbot × C1

### 5.1 B3

- conexão real do canal;
- recebimento e armazenamento das mensagens;
- envio humano pela Central de Conversas;
- status de entrega e leitura;
- mídias previstas no escopo;
- consentimento e janela de 24 h;
- observabilidade, retries e falhas;
- vínculo com contato, lead e oportunidade.

A criação de contato, lead, oportunidade e atividade no primeiro contato
(A7 §6) **continua**, porque é um critério de aceite já entregue. Mas ela
passa a valer só para mensagem recebida em tempo real de identidade
realmente nova. Nunca vale para histórico importado, eco do celular ou
mensagem do chatbot.

### 5.2 Chatbot externo

- Continua independente. Nada do Worker, do banco D1, das filas ou dos
  prompts entra no Praxis. O projeto do chatbot não é modificado.
- O CRM pode **ver** as mensagens do chatbot como `origin =
  'external_api'`, se a YCloud as entregar ao endpoint do CRM (**a
  validar**), sem nunca interpretá-las.
- **Passagem futura sem respostas duplicadas** (documentação apenas):
  1. Hoje o chatbot pausa uma conversa quando vê o eco do celular. Uma
     resposta humana pelo CRM sai pela API e não gera eco, então **não**
     pausa o chatbot.
  2. Opção recomendada: as mensagens do CRM saem com `externalId`
     prefixado (por exemplo `praxis:`), e o chatbot, que já recebe
     `whatsapp.message.updated`, passa a tratar esse prefixo como "humano
     assumiu". Exige mudança no chatbot, fora da B3.
  3. Alternativas:
     - o CRM só envia quando o chatbot estiver pausado para aquela
       conversa, o que exige o CRM consultar o estado do chatbot;
     - o advogado assume sempre pelo celular, e o CRM fica só de leitura
       naquele número.
  4. Enquanto nada disso existir, o **envio pelo CRM fica desligado no
     número do chatbot** (`send_enabled = false` no canal).

### 5.3 C1

Pertencem à C1:

- regras automáticas e mudança automática de status;
- atividades criadas por eventos;
- follow-ups, cadências e distribuição;
- agendamento automático;
- gatilhos comerciais;
- respostas automáticas por IA e qualificação automática.

A B3 não implementa nada disso.

### 5.4 Eventos que a B3 grava para a C1

Gravados em `whatsapp_domain_events` (append-only, idempotentes por
origem), **sem consumidor** na B3:

- `conversation.first_inbound`: primeira mensagem de uma identidade nova;
- `message.inbound`: inclui se reabriu a janela;
- `message.outbound_human`: origem `crm` ou `business_app`;
- `message.outbound_external`: chatbot;
- `message.delivered`, `message.read`, `message.failed`;
- `window.closing`: calculado na leitura, não por agendador;
- `conversation.link_resolved`, `consent.granted`, `consent.revoked`;
- `channel.disconnected`, `channel.reconnected`.

## 6. Etapas de implementação

Cada etapa é uma PR com testes, CI verde e validação própria. Nenhuma liga
nada em Preview ou Production sem autorização.

### B3.1 Fundação do provedor

- **Interface `WhatsAppProvider`:**
  - `verifyWebhook`;
  - `parseWebhook` → eventos normalizados;
  - `sendText`, `sendTemplate`, `sendMedia`;
  - `fetchMedia`;
  - `lookupMessage`, para reconciliar.
- **Provedores** simulado e YCloud, este só com configuração completa.
- **Configuração por ambiente:**
  - `WHATSAPP_PROVIDER` ausente faz a rota responder 404 (padrão B2);
  - falha fechada em Preview e Production.
- **Canal por workspace** com `provider` e `environment`.
- **Credenciais** cifradas com chave por ambiente e AAD.
- **Ambiente autenticado** pelo cabeçalho assinado da B2.
- **Permissão nova `channel.manage`** (owner/admin): cadastrar, pausar,
  desligar o envio e desconectar.
- **Migrations:** canal, credenciais e RLS deny-all.
- **Testes:**
  - pgTAP: isolamento, credencial ilegível por SELECT e ambiente oposto
    recusado;
  - unitários: cifra e AAD.

### B3.2 Entrada real

- Rota `src/app/api/webhooks/whatsapp/[provider]`, com runtime Node e
  corpo bruto.
- Assinatura validada antes de qualquer `JSON.parse`, com tolerância de
  tempo.
- Workspace resolvido só pelo canal cadastrado do ambiente.
- Caixa de entrada cifrada, depois 2xx, depois Inngest.
- Worker com RPCs de serviço:
  - entrada;
  - eco do celular;
  - status;
  - eventos de conta;
  - troca de número ou BSUID.
- Identidade BSUID e telefone opcional, sem nunca criar contato duplicado
  quando o telefone aparecer depois.
- Status com a regra corrigida (§1.3).
- Histórico importado: **ignorado no piloto**. Se for habilitado, grava só
  mensagens, sem lead nem atividade.
- **Testes:**
  - fixtures oficiais da YCloud: texto, mídia, eco, sem telefone, não
    suportada, status fora de ordem, `delivered` depois de `failed`;
  - assinatura adulterada, timestamp velho e evento duplicado;
  - concorrência real (estender `a7-concurrency-check.mjs`).

### B3.3 Saída humana

- Envio em duas fases (reserva e outbox) com `client_dedupe_key` da A7.
- Consentimento: gate da A7 sem mudança.
- Janela: checada na reserva com margem; recusa do provedor por janela
  vencida vira `failed` com mensagem clara e oferta de template.
- Templates aprovados, listados do provedor e só da categoria permitida
  (§12, decisão 4); parâmetros validados; rejeição de template visível.
- Resultado incerto: estado `uncertain`, **sem reenvio automático**;
  reconciliação por webhook ou consulta; botão "reenviar" só com
  confirmação humana e chave nova.
- Status: `queued` → `accepted` → `sent` → `delivered` → `read` /
  `failed`.
- Tela: origem da mensagem, aviso de janela, composer de template, envio
  bloqueado com motivo quando `send_enabled = false`.

### B3.4 Mídia

- **Piloto:** recebimento de texto, áudio, imagem e documento; envio só de
  texto e template (§12, decisão 3).
- **Download feito pelo worker** logo ao receber o evento:
  - antes da expiração (YCloud: 30 dias; Meta: URL de 5 min, ID de 7
    dias);
  - com limite de tamanho e tipos permitidos;
  - SHA-256 conferido;
  - bucket privado por workspace (padrão B1).
- **Acesso:**
  - só por rota autenticada que confere o alcance da conversa;
  - URL assinada curta.
- **Logs:** nunca mídia, link do provedor ou telefone; só ids internos.
- **Retenção:** apagar arquivo e manter tombstone (§12, decisão 6).

### B3.5 Operação

- Erros visíveis na conversa e no painel do canal:
  - credencial recusada;
  - número desconectado (`PARTNER_REMOVED`, `account_offboarded`,
    inatividade);
  - endpoint suspenso;
  - rate limit com respeito ao `Retry-After`.
- Reautorização: fluxo guiado de nova conexão; o canal fica `paused` até
  a confirmação.
- Batimento: `last_event_at` por canal. Alerta de webhook parado com
  limiar configurável e sem PII (padrão de alertas da B2).
- Retries: Inngest com teto alinhado ao estado terminal (lição da A11);
  caixa de entrada travada vira alerta.
- Desligamento controlado, em três níveis:
  - envio do canal desligado;
  - canal pausado (aceita o webhook e não processa);
  - rota sem provedor (404).

### B3.6 Validação

Ver §10.

## 7. Modelo de segurança

- **Entrada pública única por provedor**:
  - assinatura obrigatória sobre o corpo bruto;
  - comparação em tempo constante e tolerância de tempo;
  - resposta sem detalhe interno;
  - canal desconhecido ou de outro ambiente → 404, sem enumeração.
- **Workspace** sempre derivado do canal cadastrado no ambiente
  autenticado, nunca do payload.
- **Cliente administrativo** só em `src/app/api/webhooks/**` e
  `src/app/api/cron/**` (regra de lint existente). As RPCs de serviço têm
  `EXECUTE` só para o papel de serviço.
- **Segredos:**
  - chave de API e segredo do webhook cifrados por ambiente, com AAD;
  - Preview nunca tem credencial de Production;
  - rotação documentada.
- **RLS** habilitada e forçada em toda tabela nova. Deny-all para caixa de
  entrada, credenciais, mídia, outbox e eventos.
- **Permissões:**
  - `channel.manage`: owner/admin;
  - `conversation.send`: inalterada;
  - envio de template: **mesmo papel** de `conversation.send`, salvo
    decisão contrária;
  - mídia segue o alcance da conversa.
- **Dados pessoais:**
  - payload cifrado na caixa de entrada;
  - `payload_sanitized` sem telefone, texto, mídia ou BSUID completos;
  - logs, auditoria e alertas só com ids internos;
  - nenhum telefone ou texto em mensagem de erro.
- **Auditoria** dentro das funções `SECURITY DEFINER`, como na A2:
  - canal conectado, pausado e desconectado;
  - credencial trocada;
  - envio e template;
  - reenvio após resultado incerto;
  - consentimento.

## 8. Matriz de riscos

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| Preview e Production no mesmo Supabase | Alta | Alto | Canal com `environment`; ambiente autenticado pela assinatura da B2; credenciais com AAD do ambiente; `phone_number_id` e chave de roteamento únicos impedem o mesmo número nos dois ambientes; endpoints e segredos distintos por ambiente |
| Mesmo número no chatbot e no CRM | Certa (se for o número do escritório) | Alto | Piloto em número de teste; no número do chatbot, envio do CRM desligado até haver passagem (§5.2) |
| Mensagem do celular sem webhook | Média | Médio | Windows e WearOS não geram evento (Meta). Avisar a equipe; a tela indica "histórico pode estar incompleto"; teste de aceite com os aparelhos reais |
| CRM e chatbot respondendo juntos | Alta sem passagem | Alto | Envio desligado no número do chatbot; contrato futuro pelo `externalId` |
| Evento duplicado, atrasado ou fora de ordem | Certa | Médio | Unicidade por id de evento e por `wamid`; locks; rank de status; status de mensagem ainda não vista fica pendente e é reaplicado |
| Status regredir | Média | Médio | Projeção nunca regride; `delivered`/`read` prevalecem sobre `failed`; log bruto preserva tudo |
| Mídia expirar antes do processamento | Baixa (YCloud) / Média (Meta) | Médio | Download imediato pelo worker; alerta de caixa de entrada travada; estado `media_expired` visível |
| Janela fechar entre a intenção e o envio | Média | Baixo | Checagem com margem na reserva; recusa do provedor tratada; oferta de template |
| Template rejeitado ou recategorizado | Média | Médio | Só templates aprovados; evento de revisão atualiza a lista; categoria decide o consentimento exigido |
| Consentimento de atendimento × marketing | Média | Alto | Gate da A7 (`whatsapp_atendimento`); template marketing exige `whatsapp_marketing` (a criar na B3.3, se a decisão 4 permitir) |
| Telefone, texto ou mídia em logs | Média | Alto | Cifra na entrada, `payload_sanitized`, revisão de logs no CI (busca por padrões), erro sanitizado |
| Troca ou desconexão do número | Média | Alto | Eventos de conta → canal `disconnected` e envio bloqueado; alerta; troca de número do cliente ligada pelo BSUID e pelos eventos de sistema |
| Exclusão e retenção de mensagens | Média | Alto | Política decidida (§12, decisão 6); retenção em lotes com tombstone (padrão A11); a exclusão no CRM não apaga no WhatsApp nem no provedor |
| Custo por mensagem e do intermediário | Média | Médio | 1.000 atendimentos grátis por número por mês; template utility cobrado mesmo na janela; contador por canal; plano YCloud e canais extras previstos |
| Cliente com BSUID sem telefone | Crescente | Alto | Identidade BSUID desde a B3.2; contato criado sem telefone; ligação posterior sem duplicar |
| Dependência da YCloud | Média | Médio | Adaptador; nenhum tipo da YCloud fora dele; número na conta da empresa (rota Facebook) |

## 9. Critérios de aceite

1. Nenhuma requisição sem assinatura válida grava algo; corpo adulterado,
   timestamp vencido e canal de outro ambiente são recusados.
2. O mesmo evento entregue N vezes, inclusive em paralelo, produz uma
   mensagem e um efeito.
3. Mensagem sem telefone (só BSUID) é recebida e vinculada. O telefone que
   aparece depois liga ao mesmo contato, sem duplicar.
4. O eco do celular aparece na conversa com origem própria, não cria lead
   nem atividade e não abre a janela.
5. Histórico, eco e chatbot nunca disparam a criação automática da A7.
6. Status fora de ordem nunca regridem; `delivered` depois de `failed`
   corrige a projeção; o log guarda tudo.
7. O envio humano grava uma mensagem por intenção; resultado incerto nunca
   reenvia sozinho; reenvio exige confirmação e nova chave.
8. Sem consentimento de atendimento, nada sai. Janela fechada: texto livre
   recusado com motivo e oferta de template.
9. A mídia do piloto é baixada, conferida, guardada no bucket privado e
   aberta só por quem vê a conversa.
10. Nenhum telefone, texto, mídia, BSUID ou segredo aparece em log, erro,
    auditoria ou alerta.
11. Canal desconectado ou pausado bloqueia o envio com aviso; webhook
    parado gera alerta.
12. Preview e Production não leem nem alteram canais, mensagens ou
    credenciais um do outro.
13. Os eventos do §5.4 são gravados uma vez cada, sem consumidor.
14. Desligar o provedor faz a rota responder 404 sem tocar no banco.

## 10. Validação controlada

1. **Provedor simulado** (CI): fixtures oficiais, pgTAP, concorrência
   real, e2e.
2. **Número dedicado de teste em Preview:**
   - WhatsApp Business num aparelho de teste;
   - coexistência pela YCloud;
   - endpoint e segredo só de Preview;
   - dados fictícios;
   - roteiro: texto, áudio, imagem, documento, eco do celular, status,
     janela vencida, template, desconexão e reconexão.
3. **Production com o número de teste:**
   - mesmo roteiro curto;
   - isolamento confirmado com registros reais;
   - o canal de Preview é desligado antes.
4. **Número real do escritório**, só depois:
   - da decisão sobre o chatbot (§12, decisões 2 e 7);
   - com envio desligado até existir a passagem;
   - com autorização expressa.

Cada passo para e relata antes do próximo, como na B2.

## 11. Configurações externas futuras

Nenhuma é feita agora. Em ordem, cada uma com autorização:

1. Número de teste com WhatsApp Business num aparelho dedicado.
2. Canal de coexistência na YCloud para o número de teste. Plano: o Free
   tem 2 canais; um já é do chatbot, a confirmar no console sem alterar
   nada.
3. Chave de API do CRM. Chave separada da do chatbot, se a YCloud
   permitir (**a validar**).
4. Endpoint de webhook do CRM por ambiente, com eventos de entrada, eco,
   status, conta e template, e segredo próprio.
5. Variáveis por ambiente na Vercel (nomes a definir na B3.1): provedor,
   chaves de cifra das credenciais e da caixa de entrada.
6. Funções do Inngest para o worker, a outbox e o reconciliador.
7. Bucket privado do Storage para mídia.
8. Templates de atendimento na YCloud, se a decisão 4 permitir.
9. Migrations aplicadas no Supabase compartilhado, com o mesmo cuidado da
   B2.

## 12. Decisões pendentes (João)

| # | Decisão | Recomendação | Impacto | Alternativa |
|---|---|---|---|---|
| 1 | Meta direta ou YCloud | **YCloud**, atrás do adaptador | Começa rápido, sem processo de Tech Provider; o custo de mensagens é o mesmo; dependência limitada ao adaptador | Meta direta: sem intermediário, mas exige verificação, App Review, Embedded Signup e pode conflitar com o chatbot no mesmo número |
| 2 | Mesmo número do chatbot ou número de teste | **Número de teste** no piloto | Valida tudo sem risco de resposta dupla a cliente real; custo de um chip e um aparelho | Número do escritório só com envio do CRM desligado (CRM vira espelho de leitura) |
| 3 | Mídias no piloto | **Receber** texto, áudio, imagem e documento; **enviar** só texto e template | Cobre o que cliente de advocacia manda (áudio e foto de documento) sem o fluxo de upload | Só texto no piloto (mais simples, mas áudio e documentos ficam fora da conversa); ou vídeo também |
| 4 | Templates fora da janela de 24 h | **Sim, só utility de retomada** de atendimento, aprovados e escolhidos pelo advogado | Permite responder quem escreveu há mais de 24 h; cada envio é cobrado | Não permitir: fora da janela, só pelo celular. Marketing fica para depois, com consentimento próprio |
| 5 | Quem conecta e administra o canal | **Owner e admin** (`channel.manage`) | Mesmo nível do simulador hoje; poucas pessoas mexem em credencial | Incluir manager; ou só owner |
| 6 | Retenção de mensagens e mídias | Mensagens enquanto existir o contato/lead; **mídia por 12 meses**, depois apagar o arquivo e manter o registro | Equilíbrio entre prova do atendimento e volume de dados pessoais | Prazo menor para mídia (por exemplo 90 dias), ou sem prazo |
| 7 | Passagem futura chatbot → humano | **Prefixo no `externalId`** das mensagens do CRM, tratado pelo chatbot como "humano assumiu" (mudança no chatbot, fora da B3) | Fecha o risco de resposta dupla sem acoplar os dois sistemas | O advogado assume só pelo celular (CRM só lê no número do chatbot); ou o CRM consulta o estado do chatbot antes de enviar |

## 13. Fontes oficiais (consultadas em 19/10/2026)

Meta:

- Coexistência:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/
- BSUID:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/
- Webhooks:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/
- Status:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status/
- Mídia:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
- Preço:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- Tech Provider:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers
- Gerenciar webhooks:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks
- Changelog:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog

YCloud:

- Receptor de webhook (assinatura, retries):
  https://docs.ycloud.com/en/api-reference/guides/api-fundamentals/implement-a-webhook-receiver.md
- Configurar webhooks:
  https://docs.ycloud.com/en/api-reference/guides/api-fundamentals/configure-webhooks.md
- Coexistência:
  https://docs.ycloud.com/en/documentation/whatsapp-business-platform/accounts-and-business-identity/whatsapp-business-app-coexistence.md
- Onboarding da coexistência:
  https://docs.ycloud.com/en/documentation/channels/whatsapp-accounts-management/coexistence/onboard-whatsapp-business-app.md
- Sair da coexistência:
  https://docs.ycloud.com/en/documentation/channels/whatsapp-accounts-management/coexistence/off-board-whatsapp-business-app.md
- Eco do celular:
  https://docs.ycloud.com/en/api-reference/guides/examples/webhook-examples/whatsapp-business-app-sent-message-sync-webhook-examples.md
- Mensagens recebidas:
  https://docs.ycloud.com/en/api-reference/guides/examples/webhook-examples/whatsapp-inbound-message-webhook-examples.md
- Status:
  https://docs.ycloud.com/en/api-reference/guides/examples/webhook-examples/whatsapp-message-updated-webhook-examples.md
- Envio:
  https://docs.ycloud.com/en/api-reference/guides/whatsapp-platform/send-whatsapp-message.md
- Erros e reenvio:
  https://docs.ycloud.com/en/api-reference/guides/api-fundamentals/handle-errors.md
- Limites:
  https://docs.ycloud.com/en/api-reference/guides/api-fundamentals/rate-limits.md
- BSUID:
  https://docs.ycloud.com/en/api-reference/guides/whatsapp-platform/use-business-scoped-user-ids.md
- Preço:
  https://docs.ycloud.com/en/documentation/whatsapp-business-platform/pricing-limits-and-quality/whatsapp-pricing.md
- Planos: https://www.ycloud.com/pricing
