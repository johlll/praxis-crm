# B3 — WhatsApp real: levantamento técnico e plano

Status: **plano aprovado na direção geral (YCloud atrás de um adaptador
próprio, piloto com número dedicado de teste), com as correções da
revisão incorporadas. Nenhuma implementação foi feita.** Este documento
não cria código, migration, variável nem configuração externa. A B3.1
simulada pode começar depois do merge; o adaptador real e qualquer número
real dependem dos portões do §6.7. Situação de cada decisão no §12.

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
  interface de provedor própria do CRM. A Meta direta continua possível e
  fica como alternativa futura (§3). O piloto começa com **número dedicado
  de teste**. No número do chatbot, o envio pelo CRM fica desligado até
  existir e ser provado um contrato explícito e autenticado de passagem
  entre o chatbot e o atendimento humano (§5.2).
- **Isolamento:** a B3 reaproveita o *padrão* da B2 (assinatura de
  ambiente, cifra com AAD), nunca suas chaves nem sua finalidade
  criptográfica (§7.1).

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
| Número desconhecido = cliente novo (§6) | Só mensagem recebida de pessoa externa cria lead, depois de procurar contato, lead ou cliente existente; histórico, ecos do celular, mensagens do chatbot, identidades internas e eventos técnicos nunca criam lead nem atividade (§15.10) |
| Envio síncrono e garantido | O provedor aceita e confirma depois; o resultado pode ser incerto |
| Janela irrelevante | Texto livre só com a janela de 24 h aberta; mensagens do celular não abrem nem estendem a janela da API |
| `phone_number_id` roteia | Na YCloud, a chave é `wabaId` + número do escritório |

### 1.8 Padrões de outras fases reaproveitados

- **A11:** caixa de entrada cifrada (AES-256-GCM, colunas separadas, chave
  exclusiva), outbox com reconciliador `for update skip locked`, Inngest
  com `id` estável, falha fechada sem configuração, retenção com
  tombstone, `payload_sanitized` sem PII.
- **B2 (só o padrão arquitetural):** contrato de provedor com provedor
  simulado (`src/server/calendar/provider.ts`), ideia de um ambiente
  autenticado por assinatura do servidor (Preview e Production
  compartilham o Supabase), cifra de credenciais com chave por ambiente e
  AAD (`token-crypto.ts`), webhook que responde 404 quando o provedor não
  está configurado, agendador e alertas desligáveis. **Nenhuma chave,
  variável, tabela de chaves ou cabeçalho da B2 é reutilizado** pela B3
  (§7.1).
- **B1:** bucket privado do Storage acessado só pelo servidor.
- **A1/A2:** cliente administrativo restrito por lint a
  `src/app/api/webhooks/**` e `src/app/api/cron/**`.

## 2. Comparação oficial Meta × YCloud

A. **Meta WhatsApp Cloud API diretamente.** B. **YCloud com WhatsApp
Business App Coexistence.** A YCloud é um provedor (BSP) que opera sobre a
mesma Cloud API da Meta: regras de janela, template, preço e BSUID são da
Meta nos dois casos.

**"Meta direta" tem dois cenários diferentes:**

- **(a) Integração da própria empresa com a própria conta (WABA).** A
  Cloud API é usada diretamente pela empresa dona do número, com app e
  token próprios; a própria Meta fala em "empresas diretamente
  integradas". Não exige que o Praxis seja Tech Provider. Se esse caminho
  oferece o onboarding de **coexistência** (manter o app no celular) sem
  passar por um parceiro não está descrito na página de coexistência
  consultada, que descreve o fluxo para parceiros: **a validar**.
- **(b) CRM SaaS que conecta contas de clientes**, por Embedded Signup e
  coexistência. Aqui se aplicam o custo e o prazo de Tech Provider (ou
  Solution Partner): verificação da empresa, App Review com vídeos,
  tokens por cliente e onboarding próprio. Esse é o cenário relevante se
  o Praxis virar produto para vários escritórios.

A coluna A abaixo descreve os dois cenários quando eles diferem.

| Critério | A. Meta direta | B. YCloud com coexistência |
|---|---|---|
| Continuar usando o WhatsApp Business no celular | (b) Sim, pela coexistência, com o fluxo de parceiro documentado. (a) Coexistência sem parceiro: **a validar**; sem ela, o número passa a ser só da API | Sim. É o produto padrão ("WhatsApp Business APP Coexistence") |
| Processo de conexão | (a) App da própria empresa ligado à própria conta, token do sistema e webhook próprio. (b) Tech Provider: verificação da empresa, App Review com dois vídeos (envio e criação de template), Embedded Signup (v2 descontinuada em 15/10/2026; usar v4) com `featureType: whatsapp_business_app_onboarding` | Console da YCloud → criar canal de coexistência → número do app → QR code no celular → escolha do histórico → autorização Meta. Rota "Facebook" (portfólio próprio) ou "QR code"; as duas exigem verificação da empresa |
| Propriedade do número | O número continua da empresa e registrado no app | Igual. Na rota "Facebook", a conta WhatsApp fica no portfólio Meta da própria empresa. Na rota "QR code", o portfólio que detém a conta é **a validar** (portão P5, §6.7) |
| Recebidas | Webhook `messages` | `whatsapp.inbound_message.received` |
| Enviadas pelo celular | `smb_message_echoes`, que a Meta manda exibir no histórico | `whatsapp.smb.message.echoes` |
| Enviadas pela API por outro sistema (chatbot) | Não geram eco. Só os status chegam a quem enviou | Endpoints da YCloud são por conta (até 20). `whatsapp.message.updated` traz o conteúdo da mensagem; se ele chega a todos os endpoints da conta, inclusive para mensagens de outra chave, e se há filtro, é **a validar** (portões P3 e P4, §6.7) |
| Status | `sent`, `delivered`, `read`, `failed`, `played`; `delivered` pode ser pulado quando lida | `accepted` (resposta do envio), depois `sent`, `delivered`, `read`, `failed`; ordem não garantida; `delivered` pode vir depois de `failed` e repetir |
| Assinatura | `X-Hub-Signature-256`: HMAC-SHA256 do corpo bruto com o segredo do app; verificação inicial com `hub.verify_token` e `hub.challenge`; mTLS opcional | `YCloud-Signature: t=…,s=…`: HMAC-SHA256 de `"{t}.{corpo bruto}"` com o segredo do endpoint; tolerância de tempo é política nossa (5 min no exemplo); rotação do segredo por API |
| Retries | Até 7 dias, com frequência decrescente; duplicatas possíveis; responder 200 | 7 retries (10 s, 30 s, 5 min, 30 min, 1 h, 2 h, 2 h); responder 2xx em menos de 6 s; endpoint pode ser suspenso ou ficar `pending` |
| Duplicação e ordem | Duplicatas documentadas; ordem não documentada | Deduplicar pelo `id` do evento; ordem explicitamente não garantida |
| Janela de 24 h | Aberta por mensagem ou ligação do cliente; renovada a cada mensagem dele; fora dela, só template | Igual (regra da Meta). Mensagens do celular e histórico importado **não** abrem nem estendem a janela da API |
| Texto livre e template | Texto livre só na janela; template aprovado fora dela | Igual; envio por fila (`POST /v2/whatsapp/messages`) ou síncrono (`sendDirectly`) |
| Texto, áudio, imagem, documento, vídeo | Todos. Imagem JPEG/PNG até 5 MB; áudio AAC/AMR/MP3/M4A/OGG-Opus até 16 MB; vídeo MP4/3GP até 16 MB; documento até 100 MB | Todos (mesma base); upload de mídia pela API da YCloud |
| Download de mídia | ID → URL temporária (**5 min**) → download com o token; IDs vindos do webhook valem **7 dias**; a Meta guarda a mídia 30 dias | `link` acessível direto por poucos minutos; com o cabeçalho `X-API-Key`, por **30 dias** |
| Ids das mensagens | `wamid` | `wamid` + `id` da YCloud + `externalId` (nosso, opcional, só para correlação) |
| Idempotência do envio | Não documentada no envio | **Não tem**: um POST repetido pode duplicar. O `externalId` serve para correlacionar o webhook com o nosso registro; **não** é chave de idempotência. Reconciliar pelo webhook antes de qualquer nova tentativa |
| Limites | Coexistência: 20 mps fixos | Coexistência: 5 mps documentados pela YCloud; API: 200 rps por número (fila) |
| Custo da Meta (fotografia de 19/10/2026) | Por mensagem entregue. **Desde 01/10/2026:** mensagens de atendimento acima de 1.000 por número por mês são cobradas; template utility dentro da janela passa a ser cobrado. Mensagens do celular continuam grátis | O mesmo custo da Meta, repassado pela YCloud, que declara "zero mark-up" |
| Custo do intermediário (fotografia de 19/10/2026) | Nenhum. No Brasil, a cobrança direta da Meta deve migrar para BRL até 30/06/2027 | Plano Free US$ 0 (inclui API, 2 canais); Growth US$ 39, Pro US$ 89, Enterprise US$ 399 por mês; canal extra US$ 5/mês; usuário extra US$ 10/mês. A página fala em cobrança mínima após 30 dias se houver suporte, sem valor |
| Dependência do fornecedor | Só da Meta. (a) Entrada simples para a própria conta. (b) Custo alto de entrada e manutenção (Tech Provider, App Review, mudanças da plataforma) | Da YCloud para webhook, envio, mídia e chave de API. As regras continuam da Meta |
| Portabilidade | Número e conta da empresa | Sair da coexistência é feito no celular (Configurações > Conta > Plataforma comercial). Trocar de parceiro exige novo onboarding; o histórico só pode ser sincronizado uma vez por onboarding, em 24 h |
| Compatibilidade com a A7 | O normalizador atual já lê o formato da Meta | Exige um parser próprio para o mesmo formato normalizado |
| Compatibilidade com o chatbot | O chatbot usa a YCloud; ligar o mesmo número à Meta direta e à YCloud ao mesmo tempo, ou movê-lo entre elas, tem regras **a validar** (portão do §6.7) e pode afetar o chatbot | O CRM entra na mesma conta YCloud do número, com endpoint próprio, sem tocar no projeto do chatbot. Alcance de uma chave de API separada para o CRM: portão do §6.7 |
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

**Preços e regras mutáveis.** Os valores de preço, franquia, categoria e
regra de cobrança desta seção são uma **fotografia consultada em
19/10/2026**. Eles mudam com frequência (a própria Meta alterou a cobrança
em 01/10/2026) e precisam ser conferidos de novo no painel e na
documentação antes do Preview externo e antes de Production. O CRM **não
codifica tarifa nem franquia como regra de negócio**:

- guarda, por mensagem, os valores de custo que o provedor devolver
  (categoria, modelo, valor e moeda), sem recalcular;
- separa **estimativa** de **valor final**: na YCloud, o valor é estimado
  enquanto a mensagem está aceita ou enviada e final depois da entrega;
- qualquer contador de franquia é só informativo, nunca bloqueia ou
  libera envio.

## 3. Recomendação

**YCloud com coexistência no piloto, atrás de um adaptador de provedor do
CRM.** Fundamentos:

A Meta direta **é possível**: no cenário (a) do §2, a própria empresa
integra a própria conta sem o Praxis virar Tech Provider. A escolha da
YCloud para o piloto não se apoia numa impossibilidade da Meta, e sim em:

1. **Coexistência já oferecida e em uso.** O número do escritório já está
   em coexistência pela YCloud, por causa do chatbot, com o fluxo de
   conexão pronto no console. Na Meta direta, a coexistência sem parceiro
   é **a validar**, e mover o número entre fornecedores tem regras ainda
   não confirmadas (portão do §6.7).
2. **Velocidade do piloto.** Sem app próprio na Meta, sem App Review e sem
   fluxo de onboarding a construir: o trabalho fica no CRM (adaptador,
   segurança, operação).
3. **Mídia.** O arquivo fica disponível por 30 dias com a chave; na Meta,
   a URL dura 5 minutos e o ID do webhook vale 7 dias.
4. **Operação.** Console com estado dos canais e do endpoint, rotação do
   segredo por API e eventos de conta já entregues no mesmo webhook.
5. **Compatibilidade com o chatbot.** O CRM entra na mesma conta, com
   endpoint próprio, sem mexer no chatbot nem no registro do número.
6. **Custo.** O custo de mensagens da Meta é o mesmo nos dois caminhos; o
   da YCloud é o plano (o Free inclui API) e canais extras (fotografia de
   19/10/2026, §2).

O cenário (b), Praxis como Tech Provider com Embedded Signup e
coexistência, passa a ser relevante se o Praxis virar produto para vários
escritórios. O adaptador mantém esse caminho aberto: trocar de provedor
troca o adaptador, não o domínio.

**O que a recomendação não decide:** usar o número do chatbot. O piloto
começa com um número dedicado de teste (§12, decisão 2), porque hoje uma
resposta humana enviada pelo CRM pela API **não pausa o chatbot**. O
chatbot pausa com o eco do celular, e o envio pela API não gera eco. A
passagem exige o contrato do §5.2.

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
  - no cenário (a), basta o app da própria empresa; no cenário (b), o
    processo de Tech Provider é à parte e mais lento que o código.
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
        (externalId só correlaciona; não impede envio duplicado)
        aceito  → 'accepted' + id do provedor
        recusado → 'failed' + motivo legível
        timeout/rede → 'uncertain' (nunca reenvia sozinho)
   ──▶ webhook de status (por wamid ou externalId) atualiza a projeção
   ──▶ reconciliador: 'uncertain' é conferido pelo webhook ou pela consulta
        do provedor; continua incerto → visível para decisão humana
```

### 4.3 Mudanças de dados (para as migrations das etapas)

| Objeto | Mudança |
|---|---|
| `whatsapp_channels` | `provider` (`simulated`/`ycloud`/`meta`), `environment` (`preview`/`production`), chave de roteamento por provedor (`provider_account_ref` + número E.164; `phone_number_id` só para a Meta), `status` com `paused` e `disconnected`, `last_event_at`, `send_enabled` |
| `whatsapp_environment_keys` (nova) | Registro próprio das assinaturas de ambiente do WhatsApp (§7.1); não usa `calendar_environment_keys` |
| `whatsapp_channel_credentials` (nova) | Chave de API e segredo do webhook cifrados com chave e AAD próprias do WhatsApp (§7.1); deny-all |
| `whatsapp_webhook_inbox` (nova) | Corpo cifrado (chave própria, §7.1), hash, id do evento, tipo, estado, prazo de retenção; única por `(channel_id, provider_event_id)`. Implementada na B3.2b (§17), sem contador de tentativas: a política de nova tentativa é da B3.2c/B3.2d |
| `conversations` | `wa_id` passa a opcional; `wa_user_id` (BSUID) opcional; ao menos um dos dois; unicidade por canal e identidade; `last_inbound_at` (janela) |
| `contact_identifiers` | Novo provedor `whatsapp_bsuid`; vínculo de troca de número pelos eventos de sistema |
| `messages` | `origin`, a origem técnica (`crm`, `business_app`, `chatbot`, `external_api`, `history` ou `inbound`); `sender_classification`, a classificação do remetente (`external`, `internal`, `automation` ou `unresolved`), separada da origem: `internal` não é origem (regras no §15.10; decisões 11 e 14; modelagem documental, sem schema nesta fase); `provider_message_id`; `wa_message_id` opcional até a aceitação; `body_text` opcional com mídia; `sent_by` e `client_dedupe_key` exigidos só para `origin = 'crm'`; `template_name`, `template_language`, `template_category` (a final, conferida no envio); custo devolvido pelo provedor (categoria, modelo, valor, moeda, `cost_is_final`); `content_purged_at` |
| `message_status` | `accepted` e `uncertain`; `played` só no log |
| `message_media` (nova) | Tipo, MIME, tamanho, SHA-256, referência do provedor, caminho no Storage, estado do download, `expires_at`; deny-all |
| `whatsapp_outbox` (nova) | Uma por mensagem de saída; estados e travas do padrão A11 |
| `whatsapp_channel_events` (nova) | Saúde do canal: desconexão, reconexão, recusa de credencial, webhook parado |
| `whatsapp_domain_events` (nova) | Eventos para a C1, só gravados (§5.4) |
| `whatsapp_templates` (nova) | Espelho dos templates do provedor: nome, idioma, estado, **categoria final**, data da última mudança; atualizado pelos eventos de revisão |
| `whatsapp_handoffs` (nova, só quando o contrato do §5.2 existir) | Estado durável de "humano assumiu" por conversa, com confirmação do chatbot e expiração |
| `whatsapp_retention_policies` (nova) | Prazo por categoria e workspace (§7.2) |
| `whatsapp_legal_holds` (nova) | Preservação formal com fundamento, escopo e responsável (§7.2) |
| `whatsapp_retention_runs` (nova) | Trilha de cada eliminação em lote, sem conteúdo |

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

- Continua independente, funcional e em produção: é integrado, não
  reconstruído. Nada do Worker, do banco D1, das filas ou dos prompts entra
  no Praxis. A B3 não modifica o chatbot; a única mudança prevista nele é a
  do contrato de passagem, em desenvolvimento isolado e desligado, com
  implantação sujeita a nova autorização (decisão 15, §15.6).
- O CRM **exibe** as mensagens do chatbot com `origin = 'chatbot'`,
  `sender_classification = 'automation'` e o rótulo "chatbot/automação"
  (decisão 11), de preferência pelo evento que a YCloud entrega ao
  endpoint do CRM (portões P3/P4, §6.7), sem nunca interpretá-las nem
  criar lead a partir delas. `chatbot` exige correlação positiva com uma
  mensagem do chatbot; sem ela, a saída fica como `external_api` (§15.10).
- Hoje o chatbot pausa uma conversa quando vê o eco do celular. Uma
  resposta humana pelo CRM sai pela API e não gera eco, então **não**
  pausa o chatbot.

**Passagem futura chatbot → humano: contrato explícito** (documentação
apenas; exige mudança no chatbot, fora da B3):

1. **Estado durável por conversa.** "Humano assumiu" é um registro
   persistido (`whatsapp_handoffs`), com quem assumiu, quando, e a partir
   de qual mensagem. Não é inferido de nenhuma mensagem enviada.
2. **Canal autenticado entre CRM e chatbot.** Uma chamada, evento ou
   endpoint dedicado, com autenticação própria (segredo exclusivo dessa
   integração, assinatura com tempo, sem reaproveitar segredos da YCloud,
   da B2 ou do webhook).
3. **Idempotência.** Cada pedido de passagem tem uma chave única;
   repetir o pedido não cria nova passagem nem muda o estado já
   confirmado.
4. **Confirmação (acknowledgement).** O chatbot responde que pausou
   aquela conversa. **Sem a confirmação, o CRM não envia.** O CRM nunca
   conclui que houve passagem só porque enviou uma mensagem.
5. **Expiração e encerramento.** A passagem tem duração e pode ser
   encerrada explicitamente (devolver ao chatbot), com registro e
   confirmação do mesmo jeito.
6. **Falha fechada.** Chatbot indisponível, resposta inválida, assinatura
   errada ou confirmação ausente: o envio pelo CRM continua bloqueado
   naquela conversa, com o motivo visível.

O `externalId` das mensagens do CRM **pode** continuar sendo enviado,
mas só como dado auxiliar de correlação. Ele não é chave de
idempotência, não prova que o chatbot recebeu nada e não é usado,
sozinho, para concluir que o chatbot pausou.

Alternativa sem integração: o advogado assume sempre pelo celular (o eco
já pausa o chatbot), e o CRM fica só de leitura naquele número.

**Enquanto o contrato não existir e não houver confirmação do chatbot,
`send_enabled` permanece `false` no número do chatbot.**

O levantamento do código do chatbot (§15) confirmou dois pontos. Ele já tem
o estado durável "humano assumiu", mas não tem nenhuma rota para recebê-lo:
hoje só o eco do celular e os comandos do operador mudam esse estado. Ele
também descarta clientes antigos antes de gravar. A proposta mínima de
contrato está no §15.6, e as decisões 10 a 15 do §12 fecham como ele será
integrado.

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
- `message.outbound_human`: mensagem enviada pelo CRM (`origin = 'crm'`);
- `message.outbound_external`: qualquer mensagem de saída observada que
  não nasceu no CRM. O payload leva `origin` (`chatbot`, `business_app` ou
  `external_api`) e `sender_classification`; a C1 usa esses campos para
  distinguir a origem, sem inferi-la pelo nome do evento;
- `message.delivered`, `message.read`, `message.failed`;
- `window.closing`: calculado na leitura, não por agendador;
- `conversation.link_resolved`, `consent.granted`, `consent.revoked`;
- `channel.disconnected`, `channel.reconnected`.

## 6. Etapas de implementação

Cada etapa é uma PR com testes, CI verde e validação própria. Nenhuma liga
nada em Preview ou Production sem autorização.

### B3.1 Fundação do provedor

Implementada só com o provedor simulado; o registro do que foi feito está
no §14.

- **Interface `WhatsAppProvider`:**
  - `verifyWebhook`;
  - `parseWebhook` → eventos normalizados;
  - `sendText`, `sendTemplate`, `sendMedia`;
  - `fetchMedia`;
  - `lookupMessage`, para reconciliar.
- **Provedores:** só o simulado nesta etapa. O adaptador YCloud real
  depende dos portões do §6.7.
- **Configuração por ambiente:**
  - `WHATSAPP_PROVIDER` ausente faz a rota responder 404 (mesmo padrão da
    B2);
  - falha fechada em Preview e Production.
- **Canal por workspace** com `provider` e `environment`.
- **Credenciais** cifradas com chave, versão e AAD próprias do WhatsApp
  (§7.1).
- **Ambiente autenticado** por assinatura de ambiente **própria do
  WhatsApp** (§7.1). Nenhuma chave ou cabeçalho do calendário é aceito.
- **Permissão nova `channel.manage`** (owner/admin): cadastrar, pausar,
  desligar o envio e desconectar.
- **Migrations:** canal, credenciais e RLS deny-all.
- **Testes:**
  - pgTAP: isolamento, credencial ilegível por SELECT, ambiente oposto
    recusado e assinatura de ambiente do calendário recusada;
  - unitários: cifra e AAD, inclusive que um texto cifrado com a
    finalidade ou a chave de outro módulo não decifra.

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
- Origem técnica (`origin`) separada da classificação do remetente
  (`sender_classification`); `chatbot` só com correlação positiva, senão
  `external_api`; lead só por `inbound` + `external` (§15.10).
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
- Consentimento: gate da A7 sem mudança para atendimento
  (`whatsapp_atendimento`). Consentimento de marketing
  (`whatsapp_marketing`) é outra finalidade, nunca derivada do de
  atendimento, e não é usado no piloto.
- Janela: checada na reserva com margem; recusa do provedor por janela
  vencida vira `failed` com mensagem clara e, quando houver, a opção de
  um template permitido.
- **Templates fora da janela:**
  - a categoria final é a que a Meta aprovou, e depende do conteúdo e da
    finalidade real, não do nome nem da intenção de quem criou. Uma
    "retomada de atendimento" genérica **não** é presumida utility;
  - no piloto, **marketing fica desabilitado**;
  - só sai template **aprovado** cuja **categoria final** esteja na lista
    permitida do canal (no piloto, só utility);
  - utility só pode ser usado associado a uma solicitação, caso,
    compromisso, documento ou serviço específico do cliente: o envio
    exige a conversa vinculada e a indicação desse objeto;
  - a categoria e o estado são conferidos no momento da reserva contra o
    espelho atualizado pelos eventos de revisão;
  - recategorização, rejeição, pausa ou categoria inesperada **bloqueia o
    envio** e aparece na interface com o motivo;
  - parâmetros validados antes do envio.
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
- **Retenção:** conforme a política por categoria do §7.2; ao vencer,
  apagar o arquivo e manter tombstone.

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
- Retenção: job em lotes com os prazos do §7.2, trilha em
  `whatsapp_retention_runs` e respeito ao legal hold.

### B3.6 Validação

Ver §10.

### 6.7 Portões antes do adaptador real e do número real

A **B3.1 com provedor simulado pode avançar sem estas respostas.** O
adaptador YCloud real e qualquer número real **não podem**. Cada portão é
fechado com evidência registrada (documentação oficial, resposta do
suporte ou teste só de leitura) e aprovação.

| Portão | Antes de | Condição objetiva |
|---|---|---|
| P1 | Implementar credenciais reais da YCloud | Confirmado se existe chave de API separada para o CRM e qual o seu alcance (conta inteira, canal, número) |
| P2 | Implementar credenciais reais da YCloud | Confirmado o isolamento por canal/número e as permissões da chave. Se a YCloud não oferecer escopo, o risco de a chave do CRM alcançar o canal do chatbot é registrado e **aceito formalmente** antes da configuração |
| P3 | Receber eventos do chatbot | Confirmado quais endpoints recebem `whatsapp.message.updated` de mensagens enviadas por outra integração |
| P4 | Receber eventos do chatbot | Confirmado se há filtro por canal, chave ou tipo de evento no endpoint |
| P5 | Usar número real | Confirmada a propriedade da conta WhatsApp na conexão por QR code |
| P6 | Usar número real | Confirmadas as regras para mover o mesmo número entre fornecedores (YCloud ↔ Meta direta) |
| P7 | Usar o número do chatbot | Provado o contrato de passagem do §5.2, com confirmação do chatbot em teste |
| P8 | Preview externo e Production | Preços, franquias, categorias e regras de cobrança conferidos de novo (§2) |
| P9 | Validação externa | Prazo provisório de retenção definido (§7.2) |

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
  - chave de API e segredo do webhook cifrados por ambiente, com AAD
    própria (§7.1);
  - Preview nunca tem credencial de Production;
  - rotação documentada.
- **Chave da YCloud:** alcance limitado ao canal esperado, ou risco
  aceito formalmente (portões P1 e P2).
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
  - consentimento;
  - eliminação por retenção e legal hold.

### 7.1 Isolamento criptográfico da B3

A B3 reaproveita **só o padrão arquitetural** da B2. Nenhuma chave,
variável, cabeçalho, tabela de chaves ou finalidade criptográfica da B2 é
reutilizada. **Compartilhar o Supabase não significa compartilhar
segredos entre módulos.**

- **Assinatura de ambiente própria do WhatsApp.**
  - chave própria por ambiente (valores diferentes em Preview e
    Production);
  - finalidade própria embutida na mensagem assinada (por exemplo
    `praxis:whatsapp:env:v1`), para que uma assinatura de outro módulo
    nunca valha aqui, mesmo com chave igual por engano;
  - cabeçalho próprio e registro próprio no banco
    (`whatsapp_environment_keys`);
  - o banco recusa qualquer cabeçalho, chave ou assinatura do calendário.
- **Cifra das credenciais do canal.** Chave e versão próprias; AAD com
  finalidade, ambiente, workspace e canal (por exemplo
  `praxis:whatsapp:credential:v1|<ambiente>|<workspace>|<canal>`).
- **Cifra da caixa de entrada do webhook.** Chave e versão próprias,
  separadas das credenciais; AAD com finalidade, ambiente, canal e id do
  evento.
- **Nomes de variáveis próprios**, definidos na B3.1 e sempre com prefixo
  `WHATSAPP_` (por exemplo `WHATSAPP_ENV_SIGNING_KEY`,
  `WHATSAPP_CREDENTIAL_KEY_VERSIONS`, `WHATSAPP_INBOX_KEY_VERSIONS`). **Não
  se usa `CALENDAR_ENV_SIGNING_KEY`, `CALENDAR_TOKEN_*` nem outro segredo
  de calendário**, nem as chaves de contato da A3 ou do payload da A11.
- Uma chave do WhatsApp vazada não decifra nem assina nada da B2, da A3 ou
  da A11, e vice-versa.

### 7.2 Retenção e LGPD

A **política final é pendente de decisão da Vizentini, como
controladora** (§12, decisão 6). Este plano não aprova prazo definitivo.
O desenho técnico precisa aceitar qualquer política:

- **Prazos fixos e configuráveis por categoria**, por workspace:
  - corpo das mensagens;
  - mídia;
  - payload bruto cifrado do webhook;
  - eventos técnicos e auditoria.
- **Eliminação automática em lotes**, idempotente e segura com execuções
  concorrentes (padrão A11, `for update skip locked`).
- **Tombstone sem conteúdo.** O registro fica com ids, datas, direção,
  origem e status, sem texto, mídia, telefone nem payload, para não
  quebrar a auditoria referencial nem a ordem da conversa.
- **Trilha da eliminação** em `whatsapp_retention_runs`: categoria,
  quantidade, intervalo e motivo, sem conteúdo.
- **Legal hold.** Preservação formal registrada com fundamento, escopo
  (conversa, contato ou caso), responsável e data de liberação. Impede só
  as eliminações abrangidas; o resto da política continua valendo.
- **Exclusão de contato.** Não apaga silenciosamente prova necessária (por
  exemplo, sob legal hold), mas manter o contato também **não** significa
  retenção ilimitada: os prazos por categoria continuam correndo.
- **Piloto.** Não inventa prazo definitivo. Pode usar um prazo temporário
  curto, explicitamente provisório, definido antes da validação externa
  (portão P9) e substituído pela política da Vizentini.

## 8. Matriz de riscos

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| Preview e Production no mesmo Supabase | Alta | Alto | Canal com `environment`; ambiente autenticado por assinatura **própria do WhatsApp** (§7.1); credenciais com chave e AAD próprias do ambiente; nenhum segredo compartilhado com outros módulos; `phone_number_id` e chave de roteamento únicos impedem o mesmo número nos dois ambientes; endpoints e segredos distintos por ambiente |
| Mesmo número no chatbot e no CRM | Certa (se for o número do escritório) | Alto | Piloto em número de teste; no número do chatbot, envio do CRM desligado até o contrato de passagem estar provado (§5.2, portão P7) |
| Mensagem do celular sem webhook | Média | Médio | Windows e WearOS não geram evento (Meta). Avisar a equipe; a tela indica "histórico pode estar incompleto"; teste de aceite com os aparelhos reais |
| CRM e chatbot respondendo juntos | Alta sem passagem | Alto | Envio desligado no número do chatbot; contrato futuro explícito e autenticado, com estado durável, confirmação e falha fechada (§5.2); `externalId` nunca prova passagem |
| Evento duplicado, atrasado ou fora de ordem | Certa | Médio | Unicidade por id de evento e por `wamid`; locks; rank de status; status de mensagem ainda não vista fica pendente e é reaplicado |
| Status regredir | Média | Médio | Projeção nunca regride; `delivered`/`read` prevalecem sobre `failed`; log bruto preserva tudo |
| Mídia expirar antes do processamento | Baixa (YCloud) / Média (Meta) | Médio | Download imediato pelo worker; alerta de caixa de entrada travada; estado `media_expired` visível |
| Janela fechar entre a intenção e o envio | Média | Baixo | Checagem com margem na reserva; recusa do provedor tratada; oferta de template |
| Template rejeitado ou recategorizado | Média | Médio | Só templates aprovados com categoria final permitida; evento de revisão atualiza o espelho; recategorização, rejeição ou categoria inesperada bloqueia o envio com aviso |
| Consentimento de atendimento × marketing | Média | Alto | Finalidades separadas: atendimento (`whatsapp_atendimento`, gate da A7) nunca autoriza marketing; marketing desabilitado no piloto; quando existir, exigirá `whatsapp_marketing` próprio |
| Chave da YCloud com alcance maior que o canal | Média | Alto | Portões P1 e P2: confirmar escopo, ou registrar e aceitar formalmente o risco antes da configuração |
| Telefone, texto ou mídia em logs | Média | Alto | Cifra na entrada, `payload_sanitized`, revisão de logs no CI (busca por padrões), erro sanitizado |
| Troca ou desconexão do número | Média | Alto | Eventos de conta → canal `disconnected` e envio bloqueado; alerta; troca de número do cliente ligada pelo BSUID e pelos eventos de sistema |
| Exclusão e retenção de mensagens | Média | Alto | Política pendente da Vizentini (§12, decisão 6); prazos configuráveis por categoria, eliminação em lotes com tombstone e trilha, legal hold (§7.2); prazo provisório no piloto; a exclusão no CRM não apaga no WhatsApp nem no provedor |
| Custo por mensagem e do intermediário | Média | Médio | Valores do §2 são fotografia de 19/10/2026, reconferidos antes do Preview externo e de Production (P8); nenhuma tarifa no código; custo devolvido pelo provedor guardado por mensagem, estimado separado do final |
| Regras e preços da Meta mudarem | Alta | Médio | Mesma conferência periódica; changelogs revisados a cada etapa; nada hardcoded |
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
15. Nenhuma chave, cabeçalho ou assinatura do calendário (B2) autentica
    qualquer operação de WhatsApp; um texto cifrado por outro módulo não
    decifra com as chaves do WhatsApp.
16. `externalId` nunca é usado, sozinho, para concluir que o chatbot
    pausou; sem confirmação do contrato do §5.2, o envio no número do
    chatbot continua bloqueado.
17. Template com categoria inesperada, recategorizado, rejeitado ou
    pausado não sai, e o motivo aparece na interface; marketing está
    desabilitado no piloto.
18. Retenção vencida remove o conteúdo (texto, mídia, payload) e mantém o
    tombstone, sem quebrar referências de auditoria, conversa ou
    atividade; cada lote fica na trilha de eliminação.
19. Legal hold impede somente as eliminações formalmente abrangidas por
    ele; o restante da política segue normalmente.
20. A chave da YCloud não acessa canal fora do alcance esperado; se a
    YCloud não oferecer escopo, o risco aparece registrado e aceito antes
    da configuração (portão P2).
21. Nenhum evento do chatbot, do histórico, do eco do celular, de
    identidade interna, de status ou técnico cria lead, atividade ou
    automação comercial; só `origin = inbound` com
    `sender_classification = external` pode criar lead.
22. Nenhuma automação da C1 é antecipada: os eventos do §5.4 não têm
    consumidor e nenhuma regra muda status, cria atividade ou responde
    sozinha.

## 10. Validação controlada

1. **Provedor simulado** (CI): fixtures oficiais, pgTAP, concorrência
   real, e2e. Pode acontecer antes de qualquer portão.
2. **Número dedicado de teste em Preview** (depois dos portões P1, P2, P5,
   P6, P8 e P9):
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
   - dos portões P3 e P4 (eventos do chatbot) e P7 (contrato de passagem
     provado);
   - com envio desligado até a confirmação do chatbot;
   - com autorização expressa.

Cada passo para e relata antes do próximo, como na B2.

## 11. Configurações externas futuras

Nenhuma é feita agora. Em ordem, cada uma com autorização:

1. Número de teste com WhatsApp Business num aparelho dedicado.
2. Canal de coexistência na YCloud para o número de teste. Plano: o Free
   tem 2 canais; um já é do chatbot, a confirmar no console sem alterar
   nada.
3. Chave de API do CRM, só depois dos portões P1 e P2.
4. Endpoint de webhook do CRM por ambiente, com eventos de entrada, eco,
   status, conta e template, e segredo próprio.
5. Variáveis por ambiente na Vercel, todas com prefixo `WHATSAPP_` e
   nomes finais definidos na B3.1 (§7.1): provedor, assinatura de
   ambiente, chaves de cifra das credenciais e da caixa de entrada.
   Nenhuma variável de calendário é reaproveitada.
6. Funções do Inngest para o worker, a outbox e o reconciliador.
7. Bucket privado do Storage para mídia.
8. Templates na YCloud com finalidade específica (§6, B3.3); a categoria
   final é a aprovada pela Meta.
9. Migrations aplicadas no Supabase compartilhado, com o mesmo cuidado da
   B2.

## 12. Decisões

Situação após a revisão da PR #41 (19/10/2026), com as decisões 8 e 9
aprovadas no merge da PR #42 (20/10/2026) e as decisões 10 a 15, abertas
pelo levantamento do chatbot (§15), aprovadas em 20/10/2026:

| # | Decisão | Situação | O que vale | Impacto | Alternativa |
|---|---|---|---|---|---|
| 1 | Meta direta ou YCloud | **Aprovada** | **YCloud no piloto**, atrás do adaptador próprio (§3) | Coexistência já oferecida, piloto rápido, mídia por 30 dias, compatível com o chatbot; o custo de mensagens é o mesmo | Meta direta continua possível: (a) com a própria conta; (b) como Tech Provider, se o Praxis virar produto para vários escritórios |
| 2 | Mesmo número do chatbot ou número de teste | **Aprovada** | **Número dedicado de teste** no piloto; no número do chatbot, `send_enabled = false` | Valida tudo sem risco de resposta dupla a cliente real; custo de um chip e um aparelho | Número do escritório só depois dos portões P3, P4 e P7 |
| 3 | Mídias no piloto | **Aprovada** | **Receber** texto, áudio, imagem e documento; **enviar** só texto e template | Cobre o que cliente de advocacia manda sem o fluxo de upload | Vídeo e envio de mídia em etapa posterior |
| 4 | Templates fora da janela de 24 h | **Aprovada com correção** | Só template **aprovado** com **categoria final permitida** (no piloto, utility); utility ligado a solicitação, caso, compromisso, documento ou serviço específico; **marketing desabilitado**; recategorização, rejeição ou categoria inesperada bloqueia; nenhuma mensagem genérica de reengajamento é presumida utility (§6, B3.3) | Permite retomar um atendimento concreto fora da janela; cada envio é cobrado | Não permitir templates: fora da janela, só pelo celular |
| 5 | Quem conecta e administra o canal | **Aprovada** | **Owner e admin** (`channel.manage`) | Poucas pessoas mexem em credencial | — |
| 6 | Retenção de mensagens, mídia, payload e eventos | **Pendente** (decisão da Vizentini, como controladora) | Nenhum prazo definitivo aprovado. O desenho aceita prazos por categoria, eliminação em lotes, tombstone, trilha e legal hold (§7.2). Piloto com prazo provisório curto, definido antes da validação externa (P9) | Sem a política final, nada vai para o número real do escritório | — |
| 7 | Passagem chatbot → humano | **Substituída** | O prefixo em `externalId` deixa de ser o mecanismo. Vale o **contrato explícito e autenticado** do §5.2: estado durável, canal autenticado, idempotência, confirmação, expiração e falha fechada. `externalId` fica só como correlação | Exige mudança no chatbot, fora da B3; até a confirmação, o CRM não envia no número do chatbot | O advogado assume só pelo celular, e o CRM fica só de leitura naquele número |
| 8 | Canal pausado no webhook | **Aprovada** (20/10/2026, merge da PR #42) | Canal **pausado** continua resolvível pela resolução do webhook, com o estado devolvido; a **B3.2 deve definir e testar** quais efeitos são permitidos para evento de canal pausado. Canal **desativado** não é resolvido | O evento de um canal pausado não se perde, e nada é feito com ele sem regra testada | Recusar também o canal pausado (eventos descartados enquanto pausado) |
| 9 | Papel de `WHATSAPP_PROVIDER` | **Aprovada** (20/10/2026, merge da PR #42) | Durante o piloto, habilita **um único provedor por ambiente**. Nunca substitui o provedor gravado no canal: o adaptador é sempre o do canal, e `adapter.kind === canal.provider === credencial.provider` antes de banco adicional ou rede | Configuração simples no piloto; um canal YCloud nunca usa o simulador | Lista de provedores habilitados por ambiente, se um dia dois provedores precisarem conviver |
| 10 | Arquitetura de entrada com o chatbot | **Aprovada** (20/10/2026) | **Opção 1:** a YCloud entrega direto e de forma independente ao webhook existente do chatbot e a um webhook próprio do Praxis. O Praxis não entra antes do chatbot, e o chatbot não encaminha ao Praxis o tráfego que recebe (§15.4) | O Praxis vê também os clientes antigos que o chatbot descarta; os sistemas caem e voltam de forma independente | Opção 2 (o chatbot encaminha um envelope) e opção 3 (o Praxis recebe primeiro), ambas rejeitadas |
| 11 | Leads e mensagens do chatbot | **Aprovada** (20/10/2026) | O Praxis **exibe** as mensagens enviadas pelo chatbot, com origem visual e técnica "chatbot/automação" (`origin = chatbot` só com correlação positiva; classificação do remetente separada, §15.10). **Só mensagem recebida de pessoa externa** pode criar lead, e só depois de procurar contato, lead ou cliente existente, sem duplicar. Identidade ambígua, BSUID não resolvido ou possível número interno viram **pendência de identificação**, sem criação por palpite. Mensagem do chatbot, eco do celular, histórico, status, comando interno ou evento técnico nunca criam lead nem atividade. Automação do status comercial fica na C1. As mensagens do chatbot vêm de preferência do evento da YCloud no segundo endpoint (P3/P4); se ele não existir, a alternativa é documentada antes de implementar, sem trabalho síncrono no webhook do chatbot (§15.10) | Conversa completa no CRM, sem lead duplicado nem lead criado por evento técnico | — |
| 12 | Resumo e qualificação do bot no CRM | **Aprovada para fase posterior** (20/10/2026) | Integração só depois de a entrada real ficar estável. Transfere só dados estruturados necessários, com contato/lead identificado, origem "chatbot", versão, data e idempotência. Nunca prompt, raciocínio interno, logs internos ou conversa completa sem necessidade. **Fora da primeira PR da B3.2** (§15.10) | Contexto para o advogado com dado mínimo | — |
| 13 | Vencimento da passagem | **Aprovada** (20/10/2026) | O chatbot **fica em silêncio até liberação explícita**. Vencimento ou perda da confirmação bloqueia novos envios pelo CRM, mas **não** reativa a IA. A interface mostra a passagem vencida ou pendente e exige liberar ou assumir de novo (§15.6) | Nunca há resposta dupla por vencimento | O chatbot volta sozinho para a IA, rejeitada |
| 14 | Identidades internas do canal | **Aprovada** (20/10/2026) | Cadastro por **workspace, canal e ambiente**, administrado por owner/admin (`channel.manage`), aceitando **telefone normalizado e BSUID**. A identificação vem do cadastro confiável, nunca de texto ou campo livre do evento. Mensagens, comandos, ecos e status de identidades internas não criam contato, lead ou atividade de cliente. **Nenhum telefone real no repositório ou neste documento** (§15.10) | Comandos e alertas do Dr. não poluem o CRM | — |
| 15 | Mudança mínima no chatbot | **Aprovada só para desenvolvimento isolado** (20/10/2026) | Branch/PR própria, depois de reler por inteiro o livro de regras do chatbot. Desligada por padrão, sem deploy na Cloudflare e sem segredo real. Não altera webhook, fila ou processamento atuais, nem acrescenta chamada externa síncrona ao caminho quente. Testada localmente ou em recursos separados, com dados fictícios, autenticação, horário, nonce, idempotência, timeout, falha fechada e rollback documentado. **Implantar no chatbot real exige nova autorização expressa** (§15.6, §15.10) | Necessária para o portão P7 e para a B3.3 no número do chatbot | O CRM fica só de leitura no número do chatbot |

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

## 14. B3.1 — o que foi implementado

Fundação interna e **somente simulada**. Nenhuma configuração externa foi
feita: nenhuma conta, canal, chave ou endpoint na YCloud ou na Meta, nenhum
número, nenhuma variável na Vercel, nenhuma migration no Supabase hospedado
e nenhuma alteração no chatbot. Os portões P1–P9 (§6.7) continuam
**pendentes**.

### 14.1 Entregue

- **Contrato `WhatsAppProvider`** (`src/server/whatsapp/provider/contract.ts`):
  verificar assinatura de webhook, normalizar eventos, enviar texto, enviar
  template, consultar mensagem, buscar mídia e descrever capacidades. Tipos
  normalizados próprios do CRM, sem campos da Meta ou da YCloud. O contato
  é uma identidade explícita (telefone, BSUID ou ambos) e o webhook é
  conferido sobre bytes (§14.6).
- **Provedor simulado** (`provider/simulated.ts`): verifica a assinatura de
  um webhook simulado (esquema próprio do simulador) e normaliza um payload
  simulado. Enviar, consultar e buscar mídia respondem `unsupported`
  explicitamente, nunca sucesso.
- **Seleção pelo provedor do canal** (`provider/index.ts`): o adaptador
  segue o provedor gravado no canal; `WHATSAPP_PROVIDER` só habilita um
  provedor no ambiente. Ausente, vazio, desconhecido ou de outro provedor →
  desligado; `ycloud` e `meta` → desligados (`not_available`); `simulated`
  só fora de Production (§14.6).
- **Ambiente próprio do WhatsApp** (`src/server/whatsapp/environment.ts` e
  `private.whatsapp_request_environment()`):
  - cabeçalho `X-Praxis-WhatsApp-Env` no formato
    `v1.<ambiente>.<expira>.<hmac>`;
  - mensagem assinada `praxis:whatsapp:env:v1|<ambiente>|<expira>`;
  - chave `WHATSAPP_ENV_SIGNING_KEY`, uma por ambiente, e tabela
    `whatsapp_environment_keys`;
  - validade emitida de 5 minutos, e o banco recusa mais de 15.
- **Cifra das credenciais** (`src/server/whatsapp/credential-crypto.ts`):
  - AES-256-GCM com `WHATSAPP_CREDENTIAL_ACTIVE_KEY_VERSION` e
    `WHATSAPP_CREDENTIAL_KEY_VERSIONS`;
  - AAD `praxis:whatsapp:credential:v1|ambiente|workspace|canal|provedor|propósito`.
- **Cliente administrativo próprio** (`src/server/whatsapp/admin/supabase.ts`),
  que envia só o cabeçalho do WhatsApp. O lint proíbe outro cliente
  `service_role` e qualquer import do calendário em `src/server/whatsapp/**`.
- **Operações internas de canal** (`src/modules/whatsapp-channels/service.ts`):
  - listar sem credenciais e consultar o estado seguro;
  - cadastrar canal simulado e alterar nome e número exibido;
  - pausar, reativar e desligar o envio.

  Não são Server Actions e nenhuma tela as expõe. Workspace e usuário vêm
  da sessão; a entrada é estrita e recusa `workspaceId`, `actorUserId`,
  `role`, `environment` e `provider` vindos do formulário.
- **Permissão `channel.manage`**: owner e admin. As permissões da A7 ficaram
  sem mudança.

### 14.2 Decisões técnicas

- **Uma fonte de verdade.** `whatsapp_channels` (A7) evoluiu em vez de
  ganhar uma tabela paralela.
  - Linha legada (A7): sem ambiente, simulador, com `phone_number_id` e
    `routing_key = phone_number_id`; continua visível por SELECT direto e
    funcionando no simulador e na Central de Conversas.
  - Linha da B3: com ambiente e sem `phone_number_id`, então as funções da
    A7 nunca a alcançam. É invisível por SELECT direto e administrada só
    pelas funções de service_role.
- **Unicidade global** por `(provider, routing_key)`, mais forte que "por
  ambiente": a mesma chave de roteamento nunca existe em dois ambientes.
- **Identidade imutável**: workspace, ambiente, provedor, chave de
  roteamento e modo do canal não mudam depois da criação (gatilho).
- **Credencial amarrada ao canal** por FK composta
  `(workspace, canal, ambiente, provedor)`.
- **Canal simulado nunca habilita envio** (restrição). Nenhuma função desta
  etapa liga o envio; desligar o envio e pausar existem.
- **Segredo simulado de webhook** gerado no servidor, cifrado com a AAD do
  canal e gravado na mesma transação da criação. O id do canal é gerado pela
  aplicação porque entra na AAD.
- **`send_message` da A7 não foi alterada.** O estado do canal (pausado,
  envio desligado) vale para o caminho real da B3.3; o simulador da A7 nunca
  envia nada para fora.

### 14.3 Migrations

- `20261019120000_b3_whatsapp_foundation.sql` e, na revisão,
  `20261020120000_b3_1_credencial_contexto_confiavel.sql` (§14.6). Nenhuma
  migration aplicada foi editada. Antes dela, toda linha de `whatsapp_channels` era um canal
  simulado da A7 sem ambiente. Depois, as mesmas linhas ficam como legadas,
  com `routing_key` igual ao `phone_number_id`, e nenhuma vira canal real.

### 14.4 Testes

- **Unitários:**
  - `b3-whatsapp-environment` (assinatura, vetor compartilhado com o SQL,
    finalidade, validade, separação da B2);
  - `b3-whatsapp-credential-crypto` (ida e volta, AAD por ambiente,
    workspace, canal, provedor e propósito, adulteração, chaves e
    ciphertext da B2 recusados, erros sem segredo);
  - `b3-whatsapp-provider` (seleção, capacidades, `unsupported`,
    assinatura, normalização);
  - `b3-whatsapp-channel-service` (matriz de papéis, A7 sem regressão,
    recusa antes de efeito, sessão como única fonte de workspace e ator,
    nenhuma credencial em retorno ou erro);
  - `b3-a7-channel-compat` (simulador da A7 nunca recebe canal da B3).
- **pgTAP:**
  - `29_b3_whatsapp_foundation`: RLS forçada, GRANTs, funções só de
    service_role, ambiente ausente, forjado, vencido, eterno, com chave
    trocada ou no formato e finalidade da B2, papéis, workspace e ambiente
    diferentes, integridade, unicidade, A7 preservada e auditoria sem
    segredo;
  - `01_rls_isolation`, com o caso da B3.1 entre workspaces.
- **Contagem no CI da primeira rodada da PR #42:** 1269 testes unitários (84 arquivos),
  1312 asserções pgTAP (29 arquivos; 74 da B3.1), 31 no isolamento entre
  workspaces e 76 testes e2e.
- **Testes de mutação** (cada mutação aplicada, testada e desfeita):

  | Mutação | Onde rodou | Testes que falharam |
  |---|---|---|
  | Conferência de ambiente removida no banco | CI, branch descartável | pgTAP 56, 57, 58, 60 e 73 (Production alcançando canal de Preview; função da B3 alcançando o canal legado) |
  | Conferência de ambiente removida no servidor | Local | serviço: linha de outro ambiente; leitura de credencial de outro ambiente |
  | Permissão aceitando manager | Banco no CI; `roles.ts` local | pgTAP 46, 47 e 48; unitário da matriz de papéis |
  | Parte da AAD removida (canal ou provedor) | Local | 3 e 2 testes da cifra, respectivamente |
  | Leitura de credencial liberada | CI, branch descartável | pgTAP 7 e 16; isolamento 31 |
  | Credencial atravessando a projeção do canal | Local | serviço: campos inesperados |
  | Cabeçalho aceitando a chave do calendário | Local | ambiente: `CALENDAR_ENV_SIGNING_KEY` nunca autentica |

  A branch descartável e a PR temporária de mutação (#43) foram fechadas
  sem merge e excluídas.

### 14.5 Limites mantidos

- Sem adaptador YCloud ou Meta e sem nenhuma chamada HTTP externa.
- Sem webhook público, caixa de entrada, Inngest, fila ou reconciliador.
- Sem envio real, janela de 24 h, templates, mídia ou Storage. O BSUID só
  existe no contrato: nenhuma persistência, contato ou conversa por BSUID.
- Sem contrato com o chatbot, eventos para a C1 ou automações.
- Sem tela nova.

### 14.6 Revisão da PR #42

Esta rodada **começou pelos testes**: os testes de reprodução foram
escritos e commitados antes da correção (`test(b3.1): reprodução…`) e
rodados contra o HEAD `3bdb181`. Contra esse HEAD:

- **Unitários novos:** 59 de 67 falham. Os 8 que passam:
  - "variável ausente" e "variável vazia" (já desligavam);
  - "canal YCloud nunca recebe o simulador" (passa só porque a função
    antiga ignorava o canal e desligava por falta de variável);
  - 5 de assinatura (multibyte, um byte alterado, LF × CRLF, NFC × NFD,
    BOM). O HMAC do Node já operava sobre bytes quando recebia um
    `Uint8Array`, apesar de o contrato declarar `string`.
- **pgTAP novo (`30_b3_1_revisao_credencial`):** 31 de 36 falham, rodado
  numa PR temporária (#44), fechada sem merge. Os 5 que passam (privilégios
  e auditoria) passam por vacuidade: as funções novas não existiam.

O que mudou, por ponto:

1. **Leitura de credencial com contexto confiável.**
   - `whatsapp_get_channel_credential(canal, propósito)` foi removida.
   - A nova exige canal, workspace, provedor, routing key e propósito. Ela
     confere tudo contra a linha do canal no ambiente autenticado.
     Divergência → `channel_not_found`.
   - No servidor, a leitura só aceita um `ResolvedWhatsAppChannelContext`.
     Esse contexto é produzido apenas por resolução interna (sessão
     autorizada ou webhook), com marca de tipo e registro em tempo de
     execução. Objeto montado à mão é recusado antes do banco.
   - A linha devolvida tem de bater campo a campo com o contexto antes de
     decifrar. A AAD é montada do contexto, nunca da linha.
   - O webhook tem resolução própria e atômica,
     `whatsapp_resolve_webhook_channel(provedor, routing key)`. Ela
     devolve o canal e só o segredo do webhook (nunca a chave de API),
     apenas no ambiente autenticado, e nunca para canal desativado.
   - Não existe helper que decifre credencial de qualquer workspace só pelo
     UUID.
2. **Provedor do canal.** `resolveWhatsAppProvider({ channelProvider })`
   escolhe o adaptador pelo provedor gravado no canal; a variável só
   habilita. Antes de ler credencial ou chamar qualquer coisa vale
   `adapter.kind === canal.provider === credencial.provider`. A divergência
   falha antes de banco adicional ou rede.
3. **Identidade sem telefone.** `WhatsAppContactIdentity` aceita telefone,
   BSUID ou ambos, e nunca nenhum. Um identificador malformado invalida a
   identidade (falha fechada).
   - A entrada usa `sender` e a saída usa `recipient`.
   - O simulador aceita evento só com BSUID.
   - O formato exato do BSUID será confirmado na B3.2.
4. **Corpo bruto.** O webhook passa por três etapas separadas
   (`src/server/whatsapp/webhook.ts`):
   1. leitura dos bytes exatos, com limite de 256 KiB;
   2. assinatura conferida sobre `Uint8Array`;
   3. normalização só de um `VerifiedWebhookBody`, que é uma cópia dos
      bytes verificados, decodificados em UTF-8 estrita, sem remover BOM.

   Corpo em texto ou não verificado é recusado.

**Contagem no CI final da revisão:**

| Etapa | Resultado |
|---|---|
| Testes unitários | 1325 (88 arquivos) |
| pgTAP | 1348 asserções (30 arquivos; 36 da revisão) |
| Isolamento entre workspaces | 31 |
| E2E | 76 |

Typecheck, lint, build e Preview passaram.

**Mutações da revisão** (cada uma aplicada, testada e desfeita):

| Ponto | Mutação | Resultado |
|---|---|---|
| 1 | Leitura sem conferir a resolução interna do contexto | 1 teste falha |
| 1 | Linha de outro workspace aceita (decifra com AAD da linha) | 1 teste falha |
| 1 | Webhook sem conferir a routing key da linha | 1 teste falha |
| 1 | Banco: leitura sem conferir o workspace | pgTAP 8, 9 e 13 |
| 1 | Banco: leitura sem conferir provedor e routing key | pgTAP 10, 11 e 12 |
| 1 | Banco: webhook devolve qualquer propósito | pgTAP 21 e 22 |
| 1 | Banco: webhook sem filtro de ambiente | pgTAP 25 e 31 |
| 2 | Variável substitui o provedor do canal | 6 testes falham |
| 2 | Adaptador de outro provedor aceito na leitura | 1 teste falha |
| 2 | Credencial de outro provedor aceita | 1 teste falha |
| 3 | Evento sem telefone nem BSUID aceito | 2 testes falham |
| 3 | Simulador ignora o BSUID | 2 testes falham |
| 3 | BSUID inválido ignorado (falha aberta) | 2 testes falham |
| 4 | Normaliza corpo não verificado | 1 teste falha |
| 4 | Decodificação tolerante (remove BOM, troca byte inválido) | 2 testes falham |
| 4 | Aceita corpo como texto | 1 teste falha |
| 4 | Corpo verificado não é cópia | 1 teste falha |
| 4 | Leitura sem limite de tamanho | 1 teste falha |
| 4 | Pipeline normaliza mesmo com assinatura recusada | 1 teste falha |

As mutações de banco rodaram numa PR temporária (#45), fechada sem merge,
com a branch excluída. Os portões P1–P9 continuam **pendentes**.

Decisões aprovadas no merge da PR #42 (20/10/2026): canal pausado continua
resolvível pelo webhook, e a B3.2 define e testa os efeitos permitidos;
canal desativado não é resolvido. `WHATSAPP_PROVIDER` habilita um único
provedor por ambiente no piloto, sem substituir o provedor do canal. Ver
§12, decisões 8 e 9.

## 15. Levantamento de compatibilidade da B3.2 com o chatbot (20/10/2026)

Leitura **somente** do projeto do chatbot da Vizentini
(projeto separado, pacote `vizentini-chatbot`, versão publicada
`bebd6e2a` de 20/10/2026). Foram lidos o código de entrada, fila, pipeline,
conversas, entregas, envio, mídia, escopo, pausa, retenção, comandos do
operador, as 21 migrations do D1, o `STATUS.md` e o documento de contratos.
De `wrangler.jsonc` foram lidos **só nomes** de bindings, filas, crons e
variáveis. Nenhum segredo, `.dev.vars`, `.env`, `.secrets/`, `.wrangler/`
ou histórico de clientes foi aberto. Nada foi alterado no chatbot, no
Praxis (código), na YCloud, na Cloudflare, na Vercel ou no Supabase.

**O chatbot já está funcional e em produção.** A B3 o **integra**; não o
reconstrói nem duplica as funções dele (§15.5).

### 15.1 Fatos que mudam ou completam este plano

1. **O chatbot não é um registro completo do número.** Em produção vale o
   escopo "só contatos novos": o webhook consulta o contato na YCloud e
   **descarta sem gravar** eventos de quem já tinha conversa com o
   escritório. Isso inclui mensagens, ecos e status de clientes antigos.
   Também descarta eventos sem telefone (só BSUID) e tipos que não trata.
   Encaminhar ao Praxis "depois de gravar" perderia justamente os clientes
   antigos.
2. **Assinaturas do webhook do chatbot:** `inbound_message.received`,
   `smb.message.echoes` e `message.updated`. O histórico (`smb.history`)
   é tratado pelo código, mas não está assinado.
3. **Já existe uma máquina de três estados** por conversa:
   - `AI_ACTIVE`;
   - `HANDOFF_PENDING`: o bot encaminhou ao Dr. e fica em silêncio;
   - `HUMAN_ACTIVE`: o eco do celular ou o comando do operador.

   Nenhum estado volta sozinho para a IA: só `npm run session -- resume`.
   O estado fica em `conversations` (`mode` e `handoff_pending_at`), com
   trilha em `mode_changes` e `handoffs`.
4. **Não existe endpoint para assumir ou liberar.** O Worker só tem
   `POST /webhooks/ycloud`, `GET /resumo/<id>` e `GET /health`. "Assumir",
   "retomar" e "pausar" são comandos do operador, que rodam SQL pelo
   `wrangler d1`. O canal de comandos do Dr. (WhatsApp pessoal → número
   do escritório) trata conversões ("virou cliente", "não fechou",
   "desfazer", "resumo"), não passagem de atendimento.
5. **Trafegam no mesmo número mensagens que não são de cliente:**
   - comandos do Dr. a partir do número pessoal dele;
   - respostas interativas (botões e listas) ao Dr.;
   - modelos de alerta ao Dr., como `novo_atendimento_aguardando`
     (categoria marketing);
   - retomadas de 24 h a 15 dias, com modelos marketing pendentes e o
     recurso desligado.

   Um endpoint do Praxis no mesmo número verá esse tráfego e precisa
   classificá-lo como interno.
6. **Um único ambiente.** Os recursos `vizentini-chatbot-teste` (Worker,
   D1, filas) são os que atendem leads reais desde 14 e 16/10/2026. "Teste"
   é só um conjunto de travas (lista autorizada, sessão de captura) e a
   pausa geral. Qualquer mudança no chatbot vai direto para o atendimento
   real.
7. **Limites do plano gratuito já apertados:**
   - webhook com até cerca de 7,5 ms de CPU, perto do limite de 10 ms;
   - consumidor da fila com 49 de 50 subrequisições no pior caso, áudio
     ou documento.

   Não cabe chamada extra por mensagem no caminho atual.
8. **Retenção do chatbot:**
   - 7 dias para mensagens, caixa de entrada bruta, eventos e
     encaminhamentos;
   - 60 dias para os dados do lead;
   - conversa encaminhada ou assumida mantém o estado por até 60 dias.

   Mídia não é guardada, só o link da YCloud (30 dias). A transcrição e a
   leitura de documentos ficam no D1.
9. **Uma chave da YCloud para tudo:** envio, "digitando", consulta de
   contato, download de mídia e eventos de conversão. Isso pesa nos portões
   P1 e P2: uma chave da conta inteira dada ao CRM teria o mesmo alcance.

### 15.2 Fluxo atual do chatbot

```
Cliente (WhatsApp)                       Dr. (app WhatsApp Business, coexistência)
        │                                          │
        └──────────────► YCloud (conta da Vizentini, número do escritório)
                          │ webhook do chatbot: inbound_message.received,
                          │ smb.message.echoes, message.updated
                          ▼ YCloud-Signature t=,s= (HMAC; tolerância 6 h)
Worker vizentini-chatbot-teste — POST /webhooks/ycloud
  1. corpo (≤ 1 MB) → 2. assinatura → 3. JSON com id/type → tipo tratado?
  4. travas: lista autorizada | sessão | escopo "só contatos novos"
     (consulta o contato na YCloud) → descartado = 200 SEM gravar
  5. webhook_inbox (INSERT OR IGNORE por event_id, corpo bruto)
  6. fila {inboxId} → 200            (falha na fila: o cron recupera)
          │
          ▼ fila ...-events (lote 1, max_retries 6, DLQ ...-events-dlq)
Consumidor: adapta → inbound_events (dedupe) → contato/conversa (telefone|BSUID)
  ├─ eco do celular ................ conversa → HUMAN_ACTIVE (IA pausa)
  ├─ message.updated ............... status da resposta (por externalId/wamid)
  └─ mensagem do cliente → travas (encaminhada, pausa geral, tetos, idade,
       humano) → transcrição/leitura (OpenAI) → IA → portões
       → reserva da resposta (id estável = externalId) → sendDirectly
       → sent | rejected | uncertain (nunca reenvia)
       → encaminhamento: HANDOFF_PENDING + alerta (modelo) ao Dr. → silêncio
Cron */5: recupera inbox parada, lembretes, avisos, retomadas, sinais
Cron diário: retenção 7 d (conversa) / 60 d (lead)
Operador: npm run session -- assume | resume | pausar | retomar (wrangler d1)
```

### 15.3 Arquiteturas comparadas

1. YCloud entrega os mesmos eventos ao chatbot e ao Praxis (dois
   endpoints da mesma conta; a YCloud aceita até 20).
2. O chatbot recebe e, depois de gravar, encaminha ao Praxis um envelope
   assinado e idempotente.
3. O Praxis recebe primeiro e encaminha ao chatbot.

| Critério | 1. YCloud → os dois | 2. Chatbot encaminha | 3. Praxis encaminha |
|---|---|---|---|
| Perda | Cada endpoint tem as próprias reentregas; o Praxis fora do ar por mais de cerca de 5 h 40 perde eventos (reconciliação pela API da YCloud a validar) | Perde tudo o que o chatbot descarta (clientes antigos, só BSUID, tipos ignorados, eventos de conta), salvo mudança no caminho quente | Chatbot passa a depender do Praxis; perda no Praxis vira perda no bot |
| Duplicação | Dedupe independente por id do evento em cada lado | Exige outbox e dedupe novos no chatbot | Idem, no sentido contrário |
| Atraso | Nenhum a mais | Uma fila e um envio a mais | Uma fila e um envio a mais no caminho do bot, que é sensível a tempo ("digitando", espera de rajada) |
| Disponibilidade | Independentes | Praxis cego quando o chatbot cai ou é pausado | Bot para quando Vercel, Supabase ou Inngest param |
| Custo | Nenhum a mais (endpoint grátis) | Subrequisições e operações de fila no plano gratuito, já no limite | Idem no Praxis, e o bot herda o risco |
| Mudança no chatbot | **Nenhuma** para a entrada | Grande: encaminhar antes das travas, outbox, fila e cron novos, segredo novo | Muito grande: nova origem assinada, troca da entrada que funciona |
| Independência | Alta | Baixa | Baixa |
| Mídia | Cada um baixa do link da YCloud com a própria chave (P1/P2) | Mesmo problema de chave, ou bytes repassados (fora do orçamento) | Idem |
| Passagem para humano | Contrato explícito à parte (§15.6), igual em qualquer opção | Idem | Idem |
| Recuperação | Reentregas por endpoint, mais a reconciliação de cada lado | O Praxis só recupera o que o chatbot gravou (7 dias) | O chatbot só recupera o que o Praxis repassar |

A opção 2 não economiza a passagem para humano: ela continua exigindo o
contrato do §15.6. Também troca uma integração que a YCloud já entrega
pronta por código novo dentro de um sistema em produção, sem ambiente de
teste e no limite do plano gratuito.

### 15.4 Recomendação (aprovada: decisão 10)

**Opção 1.** A YCloud entrega diretamente ao endpoint do Praxis, que é
próprio, com segredo próprio e um por ambiente. O chatbot fica como está na
entrada. A única mudança prevista no chatbot é a mínima do contrato de
passagem (§15.6), e só para que o CRM possa **enviar** no número do chatbot
(portão P7). Até lá, o CRM fica só de leitura nesse número (§5.2).

Justificativa:
- é a única opção em que o Praxis vê também os clientes antigos que o
  chatbot descarta;
- não mexe no caminho quente do chatbot;
- mantém os dois sistemas independentes para falhas;
- coincide com o desenho dos §3 e §4.

A opção 3 fica descartada: não há evidência técnica a favor dela, e ela
põe em risco o atendimento que já funciona. A opção 2 também foi rejeitada
(decisão 10): o chatbot não encaminha ao Praxis o tráfego que recebe.

Condições abertas:
- P3: se o endpoint do Praxis recebe o `message.updated` das respostas do
  bot. Sem isso, o CRM não vê o que o bot respondeu (ver o risco R1);
- P4: se há filtro por canal ou chave, além do filtro por tipo de evento,
  que o chatbot já usa.

```
                 YCloud (mesma conta, número do escritório)
       endpoint do chatbot                 endpoint do Praxis (um por ambiente)
        (sem mudança)                       inbound, echoes, message.updated,
              │                             eventos de conta
              ▼                                   ▼
   Worker do chatbot                     /api/webhooks/whatsapp/ycloud (B3.2)
   pausa no eco; HANDOFF/HUMAN           bytes → assinatura → canal pela
              ▲                          routing key → inbox cifrada → 2xx
              │                          → Inngest → RPCs (B3.2)
              │  contrato §15.6 (assinado, idempotente, com ack)
   Praxis ────┘  request_human / release_human / get_state
   (rota nova no chatbot, mudança mínima, só para o envio da B3.3)

   B3.3 no número do chatbot: o CRM só envia com ack "human_active" válido
   e não vencido; sem ack → bloqueado, com o motivo visível.
```

### 15.5 Já existe / adaptar / criar

| Item | Situação | Onde fica |
|---|---|---|
| Recebimento, assinatura, inbox, fila, DLQ e recuperação do chatbot | Já existe; reutilizar como está (não duplicar no chatbot) | Chatbot |
| IA, triagem, transcrição, leitura de documentos, tetos, alertas, comandos do Dr., sinais, retomadas | Já existe; não duplicar no Praxis (C1 e automações continuam fora da B3) | Chatbot |
| Estado `HUMAN_ACTIVE` e silêncio após o eco ou o encaminhamento | Já existe; reutilizar como o "humano assumiu" do contrato | Chatbot |
| Contrato `whatsapp_handoffs`, ack e expiração | Adaptar: rota assinada nova que chama a mesma mudança de estado do `assume`/`resume`, mais a tabela de pedidos | Chatbot (mudança mínima) e Praxis |
| Adaptador YCloud: assinatura sobre bytes e normalização dos eventos | Criar no Praxis. As regras conferidas no chatbot servem de referência; nenhum código copiado | Praxis (B3.2) |
| Endpoint, inbox cifrada, Inngest e RPCs de entrada | Criar | Praxis (B3.2) |
| Origem técnica (`inbound`, `business_app`, `chatbot`, `external_api`, `history`) e classificação do remetente (`external`, `internal`, `automation`, `unresolved`) | Criar (§15.10) | Praxis (B3.2) |
| Identidades internas do canal (telefone normalizado e BSUID), por workspace, canal e ambiente | Criar (decisão 14); sem isso, os comandos do Dr. criariam lead | Praxis (B3.2) |
| Pendência de identificação: identidade ambígua, BSUID não resolvido ou possível número interno | Criar (decisão 11); nunca cria lead por palpite | Praxis (B3.2) |
| Identidade BSUID sem telefone | Adaptar: o contrato já aceita (§14.6); falta persistir | Praxis (B3.2) |
| Envio humano, outbox, janela e templates | Criar (B3.3) | Praxis |
| Mídia: download e Storage | Criar (B3.4); o chatbot não guarda arquivos | Praxis |

Funções que **não** devem ser duplicadas: resposta automática, triagem,
qualificação, alerta ao Dr., comandos do Dr., retomadas, sinais de
conversão e "digitando" (que também marca a mensagem como lida). O Praxis
nunca chama essas APIs da YCloud no número do chatbot.

### 15.6 Contrato mínimo chatbot ↔ Praxis (sem implementação)

**Autenticação:**
- dois segredos novos, **um por direção e por ambiente**, exclusivos desta
  integração. Nenhum vem da YCloud, do calendário, do WhatsApp do CRM ou de
  outro módulo;
- cabeçalho com versão, horário, nonce e HMAC-SHA256 de
  `praxis:chatbot:v1|<direção>|<horário>|<nonce>|<sha256 do corpo>`;
- tolerância de 120 s;
- nonce e id do pedido guardados até expirarem (proteção contra
  repetição).

**Praxis → chatbot.** É uma rota nova no Worker, fora do webhook, com
três ações:

| Ação | Corpo mínimo | Resposta (ack) |
|---|---|---|
| `request_human` | `request_id` (UUID, chave de idempotência), `conversation_ref` (provedor, routing key do número, telefone ou BSUID), `expires_at` (prazo máximo a decidir), motivo em código | `{ack, request_id, state: "human_active", state_version, effective_at, expires_at}` |
| `release_human` | `request_id`, `conversation_ref`, motivo em código | `{ack, request_id, state: "ai_active" \| "handoff_pending", state_version}` |
| `get_state` | `conversation_ref` | `{state, state_version, since, expires_at?}` |

- **Idempotência:** o mesmo `request_id` devolve a mesma resposta, sem
  nova mudança de estado.
- **Confirmação explícita:** o CRM só libera o envio com ack
  `human_active` válido, do ambiente certo e não vencido. Antes de cada
  envio, confere o `state_version` (ou chama `get_state`).
- **Timeout** de 5 s no CRM. Sem ack, resposta inválida, assinatura errada
  ou estado diferente: **falha fechada**, o envio fica bloqueado naquela
  conversa com o motivo visível.
- **Expiração (decisão 13):** vencido o prazo ou perdida a confirmação,
  o CRM bloqueia novos envios até um novo `request_human`. O chatbot **fica
  em silêncio** até `release_human` ou `resume`; o vencimento nunca reativa
  a IA. A interface mostra a passagem vencida ou pendente e exige liberar
  ou assumir de novo.

**Chatbot → Praxis.** Mensagens, ecos, status e mídia chegam ao Praxis
direto da YCloud (opção 1, decisão 10); o chatbot não repassa o tráfego
que recebe nem conteúdo. Nesta direção há três peças distintas:

1. **Avisos de estado da passagem** (parte opcional do contrato de
   passagem):
   - o chatbot só avisa as mudanças de estado (`handoff_pending`,
     `human_active`, `ai_active`, pausa geral);
   - cada aviso leva `event_id` (idempotência) e `state_version`
     monotônica;
   - sai por outbox no chatbot, com reentrega, fora do webhook;
   - o Praxis responde 200 só depois de gravar.
2. **Contingência para respostas do chatbot** (só se P3 falhar e após
   nova aprovação):
   - não faz parte da primeira entrega da B3.2;
   - só existe se o P3 for comprovadamente falso, isto é, se o endpoint
     do Praxis não receber o `message.updated` das respostas do bot;
   - exige proposta e autorização separadas antes de qualquer código;
   - envia apenas os ids das respostas do próprio chatbot;
   - não repassa mensagens recebidas nem conteúdo (texto, mídia,
     telefone ou BSUID);
   - funciona de modo assíncrono, por outbox, com reentrega;
   - não acrescenta chamada ao webhook nem ao caminho quente do chatbot.
3. **Resumo e qualificação** (fase posterior autorizada pela decisão 12;
   fora da primeira PR da B3.2):
   - só depois de a entrada real ficar estável;
   - apenas dados estruturados necessários, com contato ou lead
     identificado, origem "chatbot", versão, data e chave de
     idempotência;
   - nunca prompt, raciocínio interno, logs internos ou a conversa
     completa sem necessidade.

**Logs dos dois lados:** só ids internos, códigos, `state_version` e
decisões. Nunca telefone, BSUID, texto, mídia, resumo ou segredo.

**Mudanças mínimas no chatbot:**
- rota assinada;
- tabela de pedidos (id, ação, conversa, resultado, vencimento), que entra
  na retenção;
- um motivo novo de troca de modo (`praxis_takeover`);
- testes;
- um segredo novo por direção.

Ficam sem mudança: o pipeline, que já respeita `HUMAN_ACTIVE`, e o webhook
(CPU).

Condições da decisão 15:
- desenvolvimento isolado em branch/PR própria, depois de reler por
  inteiro `docs/LIVRO-DE-REGRAS.md` do chatbot;
- desligado por padrão, sem deploy na Cloudflare e sem segredo real;
- sem alterar webhook, fila ou processamento atuais;
- sem chamada externa síncrona no caminho quente;
- testes locais ou em recursos separados, com dados fictícios, cobrindo
  autenticação, horário, nonce, idempotência, timeout e falha fechada;
- rollback documentado;
- implantação no chatbot real só com nova autorização expressa.

### 15.7 Portões P1–P9 diante do código do chatbot

| Portão | Respondido pelo código? | O que o código mostra | O que ainda falta |
|---|---|---|---|
| P1 | Não | O chatbot usa uma só `YCLOUD_API_KEY` para envio, consulta, mídia e eventos | Confirmar na YCloud se há chave separada e o alcance dela |
| P2 | Não | Uma chave da conta alcança envio, consulta de contato e eventos de conversão do número do escritório | Escopo por canal; senão, aceite formal do risco |
| P3 | Em parte | O endpoint do chatbot recebe o `message.updated` das próprias respostas (entrega real confirmada em 02/10) | Se outro endpoint da conta recebe esse status (documentação, suporte ou teste com número de teste) |
| P4 | Em parte | Existe filtro por tipo de evento (o endpoint do chatbot assina 3 tipos) | Filtro por canal ou chave |
| P5 | Não | O número está em coexistência pela YCloud (STATUS do chatbot) | Titularidade da WABA no console ou na Meta |
| P6 | Não | — | Regras de portabilidade YCloud ↔ Meta |
| P7 | Sim, como **não cumprido** | Não há rota nem pedido assinado; só operador por CLI e eco | Implementar o §15.6 no chatbot (desenvolvimento isolado autorizado pela decisão 15) e provar em teste; implantação real exige nova autorização |
| P8 | Não | O chatbot envia modelos marketing no mesmo número (alerta; retomadas pendentes) e registra cobrança na janela desde 01/10 | Rever preços e categorias, considerando o volume dos dois sistemas no mesmo número |
| P9 | Não | O chatbot usa 7 e 60 dias, prazos do teste dele | Prazo provisório do Praxis (decisão 6) |

### 15.8 Riscos e decisões

**Riscos:**
- **R1. Respostas do bot invisíveis.** O CRM pode não ver as respostas do
  bot (P3). Sem correlação positiva, elas aparecem como `external_api`.
  Mitigação, só se o P3 falhar e com nova aprovação: a contingência dos
  ids do §15.6 ou a reconciliação pela API da YCloud.
- **R2. Alcance da chave.** A chave do CRM pode alcançar o envio do número
  do chatbot (P1/P2).
- **R3. Buraco de eventos.** Lacuna se o endpoint do Praxis ficar fora por
  mais tempo que as reentregas (cerca de 5 h 40). Mitigação a validar:
  consulta de mensagens pela API da YCloud no reconciliador.
- **R4. Comandos do Dr. viram lead.** O tráfego do Dr. (comandos, alertas,
  botões) seria tratado como cliente sem o cadastro de identidades internas
  (decisão 14).
- **R5. Lead em dobro.** Mitigado pela decisão 11: busca de contato, lead ou
  cliente antes de criar, e pendência de identificação no lugar do palpite.
  O bot continua dono da triagem; o status comercial automático é da C1.
- **R6. Mudança no chatbot vai direto ao atendimento real.** O chatbot tem
  um ambiente só. O Preview do Praxis nunca aponta para o número do
  escritório.
- **R7. Corrida entre Dr., bot e CRM.** Ela não some (documentado no
  STATUS do chatbot); o contrato só reduz a janela.
- **R8. Retenções diferentes.** O Praxis guardaria por mais tempo conversas
  que o bot apaga em 7 dias. É preciso aviso e política (decisão 6 / P9).
- **R9. Orçamento do Worker gratuito.** Qualquer chamada nova no caminho
  quente do chatbot pode estourar CPU ou subrequisições.

**Decisões:** as de número 10 a 15 foram aprovadas em 20/10/2026 (§12).
Continuam abertos os portões P1–P6, P8 e P9, além do P7, que só fecha com o
contrato provado em teste.

### 15.9 B3.2 em PRs pequenas

Todas usam fixtures e o provedor simulado. Nenhuma configura endpoint, chave
ou número.

| PR | Conteúdo | Depende de |
|---|---|---|
| B3.2a | **Implementada (§16).** Adaptador YCloud puro: assinatura sobre bytes (`t=,s=`), normalização de entrada, eco, status, histórico (ignorado) e eventos de conta a partir de exemplos oficiais; identidade telefone e/ou BSUID; sem rede | — |
| B3.2b | **Implementada (§17).** `whatsapp_webhook_inbox` cifrada (chave e AAD próprias), única por (canal, id do evento), com prazo de retenção; RPC de gravação; pgTAP | B3.2a |
| B3.2c | **Implementada (§18).** Rota `/api/webhooks/whatsapp/[provider]/[webhookRouteId]`: bytes → canal pelo localizador opaco da URL (UUID aleatório; o segredo é por canal) → assinatura → inbox → 2xx → evento `{ inboxId }` no Inngest próprio do WhatsApp; 404 sem provedor | B3.2b |
| B3.2d-1 | **Implementada (§19).** Claim atômico da inbox: só pelo `inboxId`, com lease, token, `claim_count` e contexto resolvido no banco; leitura que decifra e confere o hash antes de devolver o corpo; complete, fail e release presos ao token; leitura e marcações sem claim aposentadas | B3.2c |
| B3.2d-2a | **Implementada (§20).** Rota `/api/inngest/whatsapp` e app `praxis-crm-whatsapp` com chaves próprias `WHATSAPP_`; função do consumidor com o ciclo inteiro num único `step.run`; evento estrito `{ inboxId }`; normalização pelo adaptador do canal; `routing_mismatch`; matriz do estado do canal; falhas terminais × recuperáveis; `ignored`/`unsupported` finalizados com disposição cercada pelo claim (`whatsapp_inbox_dispose`); nenhuma escrita no domínio | B3.2d-1 |
| B3.2d-2b1 | **Implementada (§21).** Modelo do domínio sobre a A7: identidades por telefone, BSUID ou os dois (BSUID só com índice cego e cifra); conversa com identidade obrigatória e telefone opcional; mensagens com texto opcional, tipo de conteúdo, `origin` e `sender_classification` separados, correlação positiva, ids do provedor e custo estimado × final; `accepted`; identidades internas (owner/admin); ledger técnico de efeitos; backfill determinístico; contratos tipados. Nenhuma RPC de efeito | B3.2d-2a |
| B3.2d-2b2a | **Implementada (§22).** Efeito atômico de mensagem recebida: RPC com a trava da inbox, token, lease e ambiente; ledger `message.inbound`; identidade por telefone e BSUID sem auto-merge; classificação pelas identidades internas ativas (sem nenhuma ativa → `unresolved`); contato, lead, oportunidade e atividade só para `inbound` + `external`; rollback integral; concorrência real | B3.2d-2b1 |
| B3.2d-2b2b1 | **Implementada (§23).** Mensagem de saída **observada**: registra no CRM uma mensagem já enviada pelo WhatsApp Business App (eco `smb.message.echoes`/`smb.message.created`). Não envia mensagem, não chama a YCloud e não altera o chatbot | B3.2d-2b2a |
| B3.2d-2b2b2 | **Implementada (§24, PR #235).** Status e custo de uma mensagem de saída já gravada (`message.status`): localização pelo id do provedor e pelo wamid, nunca pelo `externalId` sozinho; `message_not_found` recuperável; status pela regra compartilhada, sem regressão; código de erro sanitizado; custo estimado × final (o final nunca muda; outro final é `cost_conflict`; só o final é cobrado); `externalId` opaco; destinatário conferido; nada criado. Não liga o consumidor, não envia mensagem e não altera o chatbot | B3.2d-2b2b1 |
| B3.2d-2b2b3a | **Concluída e mesclada na PR #262 (merge `ff13405`; §25).** Identidade alterada e troca de número (`contact.identity_changed`): identidade anterior só lida, nunca criada (`identity_not_found` recuperável); o telefone novo substitui o antigo na MESMA identidade; telefone ou BSUID de outra identidade, ou outro BSUID na mesma → `identity_conflict`; sem auto-merge; a conversa acompanha o número, com os vínculos comerciais preservados e marcados para revisão; `identity` sem a nova → `review_required`; contato e telefones do contato intactos. Não liga o consumidor | B3.2d-2b2b2 |
| B3.2d-2b2b3b | **Implementada na PR #293 (§26).** Eventos operacionais da conta e do número (`account`): `provider_account_ref` neutra e imutável no canal, e as datas `last_event_at` e `provider_status_event_at`, que só avançam; `whatsapp_channel_events` deny-all, sem telefone, routing key, conta ou payload; **só** `phone_number.deleted` e `business_account.deleted` desconectam (`active`/`paused` → `disconnected`, sem envio, auditoria sanitizada); evento igual ou anterior ao último de estado é `stale_event`; os demais tipos só são registrados (o `code` é opaco); `disabled` nunca é reativado e não existe reativação automática; canal sem referência confiável → `account_reference_unverified`. Não liga o consumidor nem a YCloud real | B3.2d-2b2b3a |
| B3.2d-2b3 | Ligação do consumidor da B3.2d-2a às RPCs da B3.2d-2b2: o release `domain_effect_not_implemented` dá lugar ao efeito; a decisão por tipo e estado do canal continua a do §20.4; os resultados `channel_*` dos efeitos viram release com o mesmo código | B3.2d-2b2b3b |
| B3.2e | Reconciliador: republica as entradas `pending` e as `processing` com lease vencida; batimento do canal (`last_event_at`). Portão obrigatório antes de webhook real (§18.3) | B3.2d-2b3 |
| Fora do Praxis | Contrato do §15.6 no chatbot (rota, tabela de pedidos, testes), em branch/PR própria do chatbot, desligado e sem deploy | Decisão 15; implantação real com nova autorização; necessário antes da B3.3 no número do chatbot |
| Posterior | Resumo e qualificação estruturados do chatbot (decisão 12) | Entrada real estável |

Ligar um endpoint real da YCloud continua dependendo de P1–P4 e de
autorização.

### 15.10 Regras aprovadas para a B3.2 (decisões 10 a 15)

**Origem técnica e classificação do remetente** (decisão de modelagem
documental; sem schema nem migration nesta fase):
- `origin` diz por qual caminho a mensagem passou:
  - `inbound`: recebida no número do canal;
  - `crm`: enviada pelo CRM;
  - `business_app`: eco do aplicativo do celular;
  - `chatbot`: enviada pelo chatbot, com correlação positiva;
  - `external_api`: enviada por integração externa cuja origem
    específica não foi comprovada (fallback);
  - `history`: histórico importado.
- `sender_classification` diz quem enviou: `external` (pessoa externa),
  `internal` (identidade do cadastro interno ou usuário do escritório),
  `automation` (automação comprovada, como o chatbot) ou `unresolved`
  (sem identificação confiável).
- `internal` não é origem. Uma mensagem enviada pelo Dr. pelo aplicativo
  tem `origin = business_app` e `sender_classification = internal`; um
  comando do Dr. recebido do número pessoal tem `origin = inbound` e
  `sender_classification = internal`.
- `origin = chatbot` exige correlação positiva e confiável com uma
  mensagem do chatbot. Nunca se classifica como chatbot por exclusão ("não
  saiu do CRM nem do celular"), nem por texto ou campo que qualquer
  integração da conta possa preencher. A forma de correlação aceita é
  definida e testada antes de ser usada (P3/P4, ou a contingência do
  §15.6). Sem ela, a saída fica como `external_api`, com
  `sender_classification = unresolved`.

**Exibição das mensagens do chatbot (decisão 11):**
- origem técnica `chatbot`, classificação `automation` e rótulo visual
  "chatbot/automação";
- fonte preferida: o `message.updated` entregue pela YCloud ao endpoint
  do Praxis (portões P3/P4);
- se esse evento não chegar ao segundo endpoint, vale só a contingência
  do §15.6, com proposta e autorização separadas **antes** de
  implementar. Ela nunca acrescenta trabalho síncrono ao webhook do
  chatbot nem faz o chatbot repassar o tráfego que recebe (decisão 10).

**Criação de lead (decisão 11):**
- só por mensagem recebida ao vivo de pessoa externa identificada
  (`origin = inbound` e `sender_classification = external`);
- antes de criar, busca de contato, lead ou cliente existente por
  telefone normalizado e BSUID, sem duplicar;
- identidade ambígua, BSUID não resolvido ou possível identidade interna
  viram **pendência de identificação** (`sender_classification =
  unresolved`) para decisão humana;
- nunca criam lead nem atividade:
  - mensagem de saída de qualquer origem (`crm`, `business_app`,
    `chatbot`, `external_api`);
  - mensagem do chatbot;
  - eco do celular;
  - histórico importado;
  - status;
  - comando interno;
  - evento técnico ou de conta.
- mudança automática de status comercial: C1.

**Identidades internas (decisão 14):**
- tabela própria por workspace, canal e ambiente, com telefone normalizado
  e/ou BSUID;
- RLS, gravação só por funções de `service_role` acionadas por owner/admin
  com `channel.manage`;
- a classificação usa só esse cadastro, nunca texto ou campo livre do
  evento;
- mensagens, comandos, ecos e status dessas identidades ficam com
  `sender_classification = internal`, mantendo a `origin` técnica, sem
  contato, lead ou atividade de cliente;
- testes e documentos usam só números fictícios.

**Passagem e vencimento (decisões 13 e 15):** ver §15.6. O CRM não envia no
número do chatbot até o portão P7 fechar.

**Resumo e qualificação (decisão 12):** fase posterior, fora da primeira PR
da B3.2.

## 16. B3.2a — adaptador YCloud puro (20/10/2026)

Implementado só o adaptador, sem rede, sem credencial real, sem banco, sem
Inngest e sem rota. Ele ainda **não** está ligado na resolução de provedor:
`resolveWhatsAppProvider` continua devolvendo `not_available` para a
YCloud, e a rota é da B3.2c. Nada foi configurado na YCloud, na Meta, na
Vercel, no Supabase ou na Cloudflare, e nenhuma migration foi criada.

### 16.1 Entregue

- `src/server/whatsapp/provider/ycloud.ts`: `YCloudWhatsAppProvider`
  (`verifyWebhook`, `normalizeEvents`; envio, consulta e mídia respondem
  `unsupported`) e `ycloudRoutingKey`.
- `src/server/whatsapp/status-projection.ts`: projeção pura de status fora
  de ordem e repetidos (§16.5).
- `src/server/whatsapp/provider/contract.ts`: tipos novos, todos aditivos.
  O simulador e o teste de igualdade da B3.1 acompanham os campos novos.

### 16.2 Assinatura e corpo

- Cabeçalho `YCloud-Signature: t=<unix em segundos>,s=<hex>`, com
  HMAC-SHA256 do segredo do endpoint sobre `<t>.` seguido dos **bytes
  exatos** do corpo. Nunca sobre JSON reserializado.
- Exatamente um `t` (1 a 12 dígitos) e ao menos um `s` (64 hexadecimais,
  maiúsculas aceitas). Partes sem `=` são ignoradas, como no exemplo
  oficial. Aceita se **qualquer** `s` conferir, e todas passam por
  `timingSafeEqual`, sem atalho.
- Custo limitado antes de qualquer HMAC (a rota será pública): cabeçalho de
  no máximo **1024 caracteres** e no máximo **8 assinaturas** `s`. Um
  cabeçalho com 8 assinaturas tem cerca de 550 caracteres, o que deixa
  folga para a rotação de segredo. Acima de qualquer limite, a recusa é
  `malformed_signature`, sem calcular HMAC nem comparar, e a lista nunca é
  percorrida além da nona assinatura. Com 8 assinaturas, são exatamente 8
  comparações e 1 HMAC.
- Tolerância de horário: 300 s por padrão, como no exemplo oficial.
  Configurável de 1 s a 6 h; fora disso, o construtor recusa.
- Limite de 256 KiB, o mesmo da leitura do corpo (§14.6). Segredo vazio é
  recusado antes de calcular.
- As recusas só carregam um código (`invalid_body`, `body_too_large`,
  `invalid_secret`, `missing_signature`, `malformed_signature`,
  `stale_signature`, `signature_mismatch`). Nada de segredo, assinatura ou
  conteúdo. O adaptador não escreve log.
- Só o corpo devolvido por `verifyWebhook` é decodificado, em UTF-8
  estrita. BOM e byte inválido viram `invalid_payload`, nunca são removidos
  em silêncio.

### 16.3 Eventos e formatos suportados

Um evento por requisição, como a YCloud entrega. Envelope obrigatório:
- `id`: 6 a 128 caracteres, a chave oficial de deduplicação;
- `type`;
- `apiVersion`: exatamente `"v2"`. Versão ausente, vazia, não textual ou
  diferente (v1, v3, `V2`) vira `invalid_payload`; uma v3 futura nunca é
  lida com o schema da v2;
- `createTime` em RFC 3339.

| Tipo YCloud | Fato normalizado | Origem candidata |
|---|---|---|
| `whatsapp.inbound_message.received` | `message.inbound`: ids (`id`, `wamid`), remetente (telefone e/ou BSUID), nome do perfil, tipo de conteúdo, texto só quando `type = text` | `inbound` |
| idem, com `type = system` e `user_changed_number` | `contact.identity_changed` (`phone_number`): identidade anterior e nova (`wa_id`/`new_wa_id` com `+`, `user_id`); o texto livre do sistema é descartado | — |
| idem, com `user_identity_changed` | `contact.identity_changed` (`identity`), sem inventar a identidade nova | — |
| idem, com `groupId` | `ignored` (`group_message`), sem conteúdo nem identidade | — |
| `whatsapp.smb.message.echoes` e `whatsapp.smb.message.created` | `message.outbound_observed`: ids, destinatário, tipo de conteúdo, texto | `business_app` |
| `whatsapp.message.updated` | `message.status`: `accepted`, `sent`, `delivered`, `read` ou `failed`, ids, `externalId` opaco, `errorCode`, destinatário quando houver, custo informado pelo provedor (§16.5); nunca o texto | `external_api` |
| idem, com `bizType` diferente de `whatsapp` (Verify) | `ignored` (`non_whatsapp_product`) | — |
| `whatsapp.smb.history` (entrada, saída ou só progresso) | `ignored` (`history`): ignorado no piloto, sem conteúdo nem identidade | — |
| `whatsapp.business_account.deleted`, `.updated`, `.reviewed` | `account` (`business_account`): WABA e código opaco (`removedReason`, `updateEvent`, `decision`) | — |
| `whatsapp.phone_number.deleted`, `.name_updated`, `.quality_updated`, `.business_username_updated` | `account` (`phone_number`): WABA, número, routing key e código opaco | — |
| Demais tipos oficiais (modelos, chamadas, grupos, contatos, pagamentos, fluxos, eco de agente da Meta) e tipos desconhecidos com envelope válido | `unsupported`, registrado e sem conteúdo | — |

Regras de identidade:
- aceita telefone, BSUID ou os dois;
- evento que exige remetente ou destinatário (entrada e eco) e não traz
  nenhum dos dois é recusado;
- identificador presente e malformado, inclusive vazio, invalida o evento;
- `recipientUserId` e o alias `toUserId` divergentes invalidam o evento;
- telefone nunca é fabricado a partir do BSUID;
- o adaptador não presume que um desconhecido seja cliente novo.

Mídia só tem o tipo: link, id e legenda ficam para a B3.4.

**Routing key da YCloud:** `<wabaId>:<número E.164 do escritório>`. Na
entrada, o número é o `to`; no eco e no status, é o `from`. Os canais YCloud
da B3.2c devem ser cadastrados com esse formato.

### 16.4 Origem e classificação

O adaptador entrega fatos do provedor. Ele **não** decide criação de lead,
contato ou conversa, identidade interna, automação, vínculo nem origem
`chatbot`. Os eventos não têm `sender_classification`.

A origem que ele relata é só uma candidata, conforme §15.10:
- `inbound` para mensagem recebida;
- `business_app` para eco do aplicativo;
- `external_api` para mensagem de API sem prova específica.

A B3.2d só promove `external_api` a `crm` casando o id com a própria
outbox. `chatbot` continua exigindo correlação positiva, que ainda não
existe (P3/P4).

### 16.5 Status fora de ordem

`projectWhatsAppMessageStatus` aplica a regra do §1.3:
- `delivered`/`read` corrigem um `failed` anterior;
- nada regride de `delivered`/`read` para `failed`;
- `accepted`/`sent` depois de `failed` não apagam o `failed`;
- fora isso, só avança;
- repetidos não mudam nada.

O resultado final não depende da ordem de chegada. O adaptador não
descarta nem reordena: cada entrega vira um fato próprio. A B3.2d aplica a
mesma regra no banco.

**Custo informado pelo provedor (`providerCost`).** Cumpre a decisão de
guardar o custo devolvido pelo provedor e distinguir estimativa de valor
final (§4.3). A estrutura tem:
- `source: "provider"`: nunca é estimativa calculada pelo CRM;
- `category`: `pricingCategory` como valor opaco validado. A lista é
  aberta, então uma categoria futura é preservada;
- `amount`: `totalPrice`, finito e não negativo; zero é válido (mensagem
  gratuita);
- `currency`: ISO 4217, três letras maiúsculas;
- `finality`: `final` em `delivered`/`read` e `estimated` em
  `accepted`/`sent`/`failed`.

O guia oficial de preço diz:
- em `accepted`/`sent` o preço é estimado;
- em `delivered`/`read` é o final, usado na cobrança;
- `failed` não é cobrado.

Por isso o valor que vier num `failed` fica como estimativa, nunca como
final.

Regras:
- campo presente e malformado (valor negativo, em texto ou infinito;
  moeda ou categoria fora do formato) → `invalid_payload`;
- custo parcial (valor sem moeda, moeda sem valor, só categoria) →
  `providerCost: null`;
- custo contraditório (`pricingType` gratuito com valor maior que zero) →
  `providerCost: null`. Nunca vira um custo que pareça confiável.

`projectWhatsAppProviderCost`:
- o valor final substitui a estimativa e nunca volta a ser estimativa nem
  some;
- entre estimativas, vale a mais recente;
- um `failed` com estimativa seguido de `delivered` termina com o valor
  final.

O valor fica em `number` nesta etapa. A precisão da gravação (`numeric`) é
da migration da B3.2d/B3.3.

### 16.6 `externalId` (leitura somente do caminho de envio do chatbot)

Lidos só o envio, os geradores de id e o documento de contratos do
chatbot. Nenhum segredo, cliente ou dado real foi aberto, e nada foi
alterado.

- **O chatbot envia `externalId` em todo envio:**
  - texto;
  - interativo;
  - modelo;
  - alerta ao Dr.
- **Como o valor é gerado:**
  - é o id interno da resposta, gravado antes de enviar;
  - o formato é `<prefixo>_<24 hexadecimais>`, um SHA-256 truncado de ids
    internos, sem chave;
  - o prefixo varia por tipo de envio: `msg-bot` (resposta), `msg-fu`
    (retomada), `msg-nudge` (lembrete), `dr-reply` (resposta ao Dr.) e
    `ho` (alerta de passagem);
  - o chatbot usa esse valor para casar a atualização de entrega, porque o
    envio não tem chave de idempotência.
- **O que a YCloud devolve:** o `whatsapp.message.updated` traz o `id` da
  YCloud, o `wamid` e o `externalId` enviado. A especificação oficial
  descreve o `externalId` como um texto "único (recomendado)" para
  conciliação.
- **Conclusão:** o `externalId` é um valor opaco de correlação.
  - Qualquer integração com a chave da conta pode enviar um valor no mesmo
    formato, então nem a existência nem o formato provam
    `origin = chatbot`.
  - O adaptador o preserva como texto opaco (até 512 caracteres, sem
    caractere de controle) e mantém `external_api`. Um teste cobre os
    formatos do chatbot.
  - **P3 e P4 continuam abertos.** Nenhuma confiança foi implementada.

### 16.7 Divergências e lacunas da documentação oficial

1. **`wabaId` e `from` no status.** A especificação marca os dois como
   obrigatórios em `whatsappMessage`. Os exemplos **atuais** de status os
   trazem:
   - o do guia de BSUID ("Use business-scoped user IDs");
   - o do catálogo "Webhook payload examples".

   Já a página genérica e mais antiga "Message status webhook examples"
   mostra o status sem os dois. O adaptador exige `wabaId` e `from` porque
   são necessários para rotear o evento ao canal correto. O formato ainda
   será confirmado com webhook real na B3.2c (P3/P4).
2. **Tolerância e reentregas.** O guia diz que a tolerância é política da
   aplicação, e não prazo de reentrega. Não documenta se as reentregas
   (até cerca de 5 h 40) são reassinadas com um `t` novo. O chatbot usa
   6 h. Aqui o padrão é 300 s, configurável até 6 h. A B3.2c decide com o
   teste controlado.
3. **Dois eventos de envio pelo aplicativo.** `whatsapp.smb.message.echoes`
   e `whatsapp.smb.message.created` podem representar saídas do
   aplicativo. Não está documentado se a mesma mensagem gera os dois.
   - Os dois viram `message.outbound_observed` (`business_app`), e o tipo
     original fica em `providerType`.
   - A deduplicação futura (B3.2d) será pelo identificador da mensagem
     (`id` da YCloud e `wamid`), **não** pelo tipo do evento.
4. **Eco de agente da Meta.** `whatsapp.echo_message.*` é de agente
   cadastrado pela API pública, não eco do aplicativo. Fica `unsupported`.
5. **`accepted` em `message.updated`.** O enum de status inclui
   `accepted`, mas a descrição de `message.updated` cita só `sent`,
   `failed`, `delivered` e `read`. O adaptador aceita os cinco.
6. **Placeholders nos exemplos.** Os exemplos oficiais usam textos como
   `BUSINESS-PHONE-NUMBER`. As fixtures os trocam por números fictícios
   E.164 (+1 202 555-01xx).
7. **Endereços da documentação.** As páginas `docs.ycloud.com/reference/...`
   citadas no §13 mudaram para `docs.ycloud.com/en/api-reference/...`.
   Fontes desta etapa:
   - guias "Implement a webhook receiver" e "Configure webhooks";
   - exemplos de status, entrada, eco do aplicativo, histórico, conta e
     número;
   - especificação `openapi/webhooks/testing-webhooks.yaml`.

### 16.8 Testes e mutações

A ordem seguida foi testes, depois implementação, depois mutações.

**Testes, antes da implementação.** Os testes de contrato foram escritos e
commitados primeiro e rodados contra a main `7b97297`, sem o adaptador. Lá,
112 falham e 2 passam. Os dois que passam:
- a resolução de provedor continua sem adaptador YCloud;
- as fixtures só têm dados fictícios.

**Implementação.** Com o adaptador, os 114 passam. A suíte unitária inteira
também passa (1439), assim como typecheck e lint.

**Arquivos de teste:**
- `b3-2a-ycloud-assinatura`;
- `b3-2a-ycloud-tempo-constante` (espiona `timingSafeEqual`);
- `b3-2a-ycloud-normalizacao`;
- `b3-2a-status-projecao`;
- `b3-2a-ycloud-isolamento`: sem `fetch` nem console, imports só de
  `node:crypto`, `zod`, contrato e webhook, YCloud ainda desligado, fixtures
  só com +1 202 555-01xx.

**Mutações.** Foram 23 mutações controladas, cada uma aplicada sozinha e
desfeita em seguida. Todas foram detectadas:

| Mutação | Detectada por |
|---|---|
| Assinatura sobre JSON reserializado | 79 testes, entre eles o do corpo com espaçamento incomum |
| `Buffer.equals` no lugar de `timingSafeEqual` | tempo constante |
| Sem tolerância de horário | limite de ±300 s; recusas só com código |
| Sem limite de tamanho | corpo acima de 256 KiB |
| Só a primeira assinatura `s` | aceita quando alguma `s` confere |
| Segredo vazio aceito | recusa segredo vazio |
| BOM removido em silêncio | BOM assinado vira `invalid_payload` |
| Telefone fabricado a partir do BSUID | só BSUID; tipo não suportado |
| Identificador malformado ignorado | telefone sem `+`, com letras, BSUID com espaço, BSUID do destinatário |
| Identificador vazio tratado como ausente | BSUID vazio, telefone vazio |
| Entrada sem identidade aceita | sem nenhuma identidade do remetente |
| Eco tratado como `inbound` | `smb.message.echoes` e `smb.message.created` |
| `externalId` com prefixo do bot vira `chatbot` | `externalId` só como valor opaco |
| Saída de API vira `chatbot` por exclusão | os 5 status e `externalId` opaco |
| Histórico processado como entrada | histórico de entrada ignorado |
| Tipo desconhecido recusado em vez de registrado | modelo, desconhecido e eco de agente |
| Alias de BSUID divergente aceito | `recipientUserId` × `toUserId` |
| Grupo não ignorado | mensagem de grupo |
| `wa_id` e `new_wa_id` divergentes aceitos | troca de número |
| Status carregando o texto | status sem texto |
| `failed` terminal | `delivered` corrige `failed`; ordem de chegada |
| `failed` regride `delivered`/`read` | nunca regride; ordem de chegada |
| Adaptador ligado na resolução | YCloud continua `not_available` |

**Revisão da PR #48** (versão do evento, custo do provedor e limites do
cabeçalho):
- **Testes primeiro.** Os testes de reprodução foram commitados primeiro
  (`a283f66`) e rodados contra o HEAD `a8db0ef`. Lá, 42 falham e 4
  passam. Os quatro que passam: a v2 já era aceita, e 8 assinaturas, 1024
  caracteres e a rotação já funcionavam.
- **Correção.** Com a correção (`cd47478`), os 46 passam. A suíte inteira
  também passa (1485), assim como typecheck e lint.
- **Mutações.** Foram 12 controladas, e todas foram detectadas:

| Mutação | Detectada por |
|---|---|
| Sem checagem de versão | ausente, vazia, v1, v3, `V2`, com espaço, número, null, objeto |
| Aceita qualquer versão começando por `v` | v1, v3, v3 com corpo da v2 |
| Descarta o custo | 19 testes de custo e de projeção |
| Marca estimativa como final | accepted, sent, failed; ponta a ponta |
| Estimativa tardia substitui o final | o final nunca volta a ser estimativa |
| Aceita valor negativo | valor negativo |
| Aceita valor infinito | `1e400` |
| Aceita moeda inválida | minúscula, 2 letras, por extenso |
| Custo parcial vira custo | valor sem moeda |
| Custo contraditório aceito | tipo gratuito com valor positivo |
| Sem limite de tamanho do cabeçalho | 1025 caracteres, sem HMAC |
| Sem limite de quantidade de assinaturas | 9 assinaturas, sem HMAC nem comparação |

### 16.9 Fora desta etapa

Ficam para as próximas PRs:
- inbox cifrada (B3.2b);
- rota pública (B3.2c);
- Inngest, RPCs e qualquer criação de lead, contato, conversa ou mensagem
  (B3.2d);
- identidades internas e `sender_classification` (B3.2d);
- mídia (B3.4);
- envio (B3.3);
- passagem chatbot/humano;
- credenciais reais e configuração externa.

As migrations da B3.1 continuam **sem** aplicação no banco hospedado.

### 16.10 Custo em `failed` (decisão aprovada em 20/10/2026, para a B3.2d)

- Não existe estado `not_charged`. O custo de um `failed` continua
  `finality: "estimated"`.
- **Só `providerCost.finality === "final"` pode entrar em total de custo
  efetivamente cobrado.** Estimativas (de `accepted`, `sent` ou `failed`)
  nunca entram nesse total.
- Um `failed` pode ser corrigido depois por `delivered` ou `read`. A
  projeção (§16.5) troca a estimativa pelo valor final.

## 17. B3.2b — caixa de entrada cifrada do webhook (21/10/2026)

Implementado só o armazenamento durável e idempotente de cada entrega
autêntica do webhook. Ficam de fora:
- rota pública;
- Inngest e processamento de mensagem;
- claim/lease, tentativas e retries;
- criação de contato, lead ou conversa;
- classificação de remetente;
- envio e mídia;
- YCloud real;
- variável na Vercel ou em qualquer serviço externo;
- migration no Supabase hospedado.

Revisada na PR #58 (§17.10): a inbox grava antes da normalização
completa, guarda o tipo bruto do provedor, separa as regras de estado do
canal para receber e para acessar, e tem teto técnico de 30 dias.

### 17.1 Entregue

- **Migration** `20261021120000_b3_2b_webhook_inbox.sql`. É nova: as
  migrations da B3.1 não foram editadas. Como ainda não foi hospedada, a
  revisão foi feita nela mesma.
- **`src/server/whatsapp/inbox-crypto.ts`:** a cifra própria da inbox.
- **`src/server/whatsapp/inbox.ts`:** a API do servidor (gravar, ler
  pendente, marcar, listar e expurgar).
- **Contrato do provedor:** `inspectEnvelope` (envelope mínimo, §17.3),
  implementada no YCloud e no simulador.
- **`VerifiedWebhookBody.copyBytes()`:** cópia dos bytes exatos, para
  hash e cifra.
- **`isTrustedWhatsAppChannelContext`:** exportado de `admin/channels.ts`.
- **Tipos do banco** atualizados (`src/server/types/database.ts`).

### 17.2 Tabela `whatsapp_webhook_inbox`

Uma linha por (canal, id do evento do provedor). Colunas:
- **Identidade:** ambiente, workspace, canal e provedor, presos à linha
  real do canal por FK (workspace, canal, ambiente, provedor).
- **Evento:** id do evento e `provider_event_type`, o tipo **bruto** do
  provedor como veio no envelope (por exemplo
  `whatsapp.inbound_message.received`). Lista aberta: o banco confere só o
  formato (`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`, até 128 caracteres). O tipo
  normalizado do CRM **não** é gravado; se for útil, a B3.2d cria um campo
  separado, preenchido só depois de um processamento bem-sucedido.
- **Corpo:** SHA-256 dos bytes exatos e o corpo cifrado, com versão da
  chave, nonce, texto cifrado e tag em colunas separadas.
- **Retenção e estado:** horário de recebimento e prazo de retenção;
  estado (`pending`, `processed`, `failed`) com horários de processamento,
  falha e expurgo; código de erro sanitizado (`^[a-z0-9_]{1,64}$`).
- **Evidência de conflito:** contagem, horário e hash da última entrega
  divergente.

Restrições do banco:
- conteúdo cifrado completo **ou** tombstone, nunca meio-termo;
- datas coerentes com o estado;
- código de erro só em `failed`;
- retenção depois do recebimento.

Nunca em texto puro: corpo, mensagem, telefone, BSUID, nome, mídia,
assinatura recebida ou segredo.

Diferente do §4.3, que previa "tentativas": não há contador de tentativas.
A política de nova tentativa pertence à B3.2c/B3.2d e ao reconciliador.

Isolamento:
- RLS ligada e forçada, sem GRANT e com políticas deny;
- as seis funções públicas são SECURITY DEFINER, com search_path travado e
  EXECUTE só para service_role (PUBLIC, anon e authenticated negados). As
  três auxiliares privadas não são executáveis por ninguém além do dono.

### 17.3 Envelope mínimo, idempotência e conflito

**A gravação acontece antes da normalização completa.** Do corpo
verificado, a inbox lê só o envelope mínimo, pela inspeção do adaptador:

```ts
type WebhookEnvelope = {
  providerEventId: string;   // id do evento no provedor
  providerEventType: string; // tipo bruto, como veio
  envelopeVersion: string;   // "v2" na YCloud, "1" no simulador
  eventCount: 1;             // exatamente um evento por entrega
};
inspectEnvelope(body: VerifiedWebhookBody):
  | { ok: true; envelope: WebhookEnvelope }
  | { ok: false; reason: "unverified_body" | "invalid_json" | "invalid_envelope"
                       | "unsupported_envelope_version" | "batch_not_supported" };
```

A inspeção:
- recebe só `VerifiedWebhookBody`;
- não interpreta mensagem, contato, status, custo ou conteúdo, e não
  decide o `NormalizedWhatsAppEvent`;
- não exige telefone, BSUID, texto ou campo específico do evento;
- recusa JSON inválido (ou UTF-8 inválido), envelope inválido, versão
  incompatível e lote.

| Adaptador | Envelope lido | Versão | Lote |
|---|---|---|---|
| YCloud | `id`, `type`, `apiVersion` do objeto do evento | só `v2`; outra string → `unsupported_envelope_version`; ausente → `invalid_envelope` | uma lista no topo → `batch_not_supported` (a YCloud manda um evento por requisição) |
| Simulador | `version`; `id` e `type` do único item de `events` | só `1` | mais de um item → `batch_not_supported`; lista vazia → `invalid_envelope` |

Um evento autêntico com envelope válido, mas cujo conteúdo o normalizador
recusa (por exemplo, mensagem recebida sem telefone e sem BSUID), é
guardado cifrado. A normalização completa continua recusando esse evento
quando for chamada; a falha é tratada na B3.2d.

`whatsapp_inbox_store` (`INSERT … ON CONFLICT (channel_id,
provider_event_id) DO NOTHING`) devolve um de três resultados:
- **`inserted`:** primeira entrega;
- **`duplicate`:** mesmo canal, id e hash, inclusive sobre um tombstone;
- **`conflict`:** mesmo canal e id, hash diferente.
  - o primeiro payload **não** é sobrescrito;
  - o novo corpo não é guardado, decifrado nem processado;
  - ficam só a evidência mínima (contagem, horário, hash) e um registro de
    auditoria `whatsapp.inbox.conflict` com ambiente, provedor e canal.

O id do evento e o tipo bruto saem da inspeção do **próprio** corpo
verificado, nunca de um parâmetro solto.

### 17.4 Cifra própria

- **Algoritmo e chaves:** AES-256-GCM com `WHATSAPP_INBOX_KEY_VERSIONS` e
  `WHATSAPP_INBOX_ACTIVE_KEY_VERSION`, com valores diferentes por
  ambiente. Não reutiliza a chave das credenciais do canal nem a da
  agenda.
- **AAD:** `praxis:whatsapp:inbox:v1|<ambiente>|<workspace>|<canal>|<provedor>|<id do evento>`.
  - Trocar qualquer elemento impede a decifragem.
  - Elemento com `|` é recusado, para que duas identidades nunca deem a
    mesma AAD.
- **Formato:** nonce de 12 bytes novo a cada cifra e tag de 16 bytes.
- **Falha fechada:** sem chave configurada, a gravação não acontece.

A API só aceita bytes já representados por `VerifiedWebhookBody` e o
contexto **confiável** do canal criado por resolução interna. Um objeto
montado à mão com UUIDs, ou uma cópia do contexto, é recusado antes do
banco.

### 17.5 Isolamento no banco e estado do canal

Todas as funções exigem o ambiente assinado do WhatsApp e conferem canal,
workspace, provedor, routing key e ambiente contra a linha real. A regra
de **estado** do canal é diferente para receber e para acessar:

| Estado atual do canal | Entrega nova (`store`) | Entrada existente (ler, listar, marcar) |
|---|---|---|
| `active` | aceita | acessa |
| `paused` | aceita e preserva | acessa |
| `disconnected` | aceita e preserva (status atrasado, evento de conta, o fato da recuperação) | acessa |
| `disabled` | recusada, nada gravado | acessa (histórico e investigação) |
| outro ambiente, workspace, canal, provedor ou routing key | não encontrado | não encontrado |

- Aceitar e preservar não é processar nem enviar. Processar eventos de
  canal pausado ou desconectado é decisão da B3.2c/B3.2d.
- Acessar uma entrada existente de canal desativado não reabre o
  recebimento: nem a reentrega idêntica é aceita.
- No banco: `private.whatsapp_inbox_channel_identity` confere a
  identidade; `whatsapp_inbox_receiving_channel` acrescenta a regra de
  recebimento (`store`); `whatsapp_inbox_existing_channel` não olha o
  estado (`list`, `get_pending`, `mark_processed`, `mark_failed`).
- O expurgo continua independente do estado do canal (§17.6).

A listagem comum (`whatsapp_inbox_list`) nunca devolve versão de chave,
nonce, texto cifrado ou tag. Só `whatsapp_inbox_get_pending` devolve o
texto cifrado, de uma entrada pendente, pela identidade inteira do canal.

### 17.6 Retenção e expurgo

- **Retenção:** vem de `WHATSAPP_INBOX_RETENTION_SECONDS`, configuração
  confiável e sem valor padrão, de **60 s a 30 dias** (2.592.000 s). Sem
  valor válido, a gravação falha fechada.
- **O prazo é calculado só pelo banco.** A aplicação manda só a retenção
  em segundos (`p_retention_seconds integer`), nunca um horário. O banco:
  - aceita só inteiros de 60 a 2.592.000;
  - captura um único horário de referência (`now()` da transação);
  - grava `received_at` com ele;
  - calcula `retain_until = received_at + make_interval(secs => retenção)`
    (segundos exatos, sem depender de fuso ou horário de verão).

  Assim, 30 dias exatos são sempre aceitos, 30 dias mais 1 s são sempre
  recusados, e o relógio da aplicação, adiantado ou atrasado, não muda o
  prazo nem provoca recusa. Uma restrição da tabela garante
  `retain_until <= received_at + 2.592.000 s`.
  - O teto é técnico: a inbox guarda o payload bruto, não o registro
    definitivo da conversa. A mensagem normalizada poderá ter outra
    política de retenção no futuro.
  - O valor do piloto continua pendente do portão P9 (decisão 6).
- **Expurgo:** `whatsapp_inbox_purge_expired` atua só no ambiente
  assinado e independe do estado do canal.
  - Apaga versão, nonce, texto cifrado e tag e mantém o **tombstone**:
    canal, id do evento, hash, datas e `purged_at`.
  - É idempotente: repetir não muda nada.
  - Audita `whatsapp.inbox.purged` por workspace, só com a contagem.
  - Uma reentrega idêntica depois do expurgo continua `duplicate`, e uma
    diferente, `conflict`. O tombstone nunca recebe conteúdo de volta.
- Não existe agendador nesta etapa.

### 17.7 Leitura e estados (contratos para a B3.2d)

> **Substituído na B3.2d-1 (§19).** A leitura de pendente e as marcações
> abaixo foram removidas. Agora o corpo só é lido e o estado só muda pelo
> claim, com lease e token. O texto abaixo registra a B3.2b como foi
> entregue.

- **`readPendingWhatsAppWebhookDelivery`:**
  - confere o contexto e a linha devolvida (entrada, canal, workspace,
    ambiente, provedor, routing key);
  - decifra com a AAD do **contexto**;
  - confere o SHA-256 em tempo constante;
  - devolve o id, o tipo bruto (`providerEventType`) e um
    `VerifiedWebhookBody` com os bytes exatos.
- **Estados:** pendente → processado ou falho. Repetir a mesma marcação é
  idempotente.
  - Processado não volta a pendente nem a falho.
  - Falho não vira processado: nova tentativa é política da B3.2c/B3.2d.
  - Entrada expurgada não é lida nem marcada.
- Não há fila, claim, contador de tentativas nem política de nova
  tentativa.
- **Requisito da B3.2d:** antes de processar em produção, tem de existir
  um claim atômico (ou garantia equivalente) que impeça dois workers de
  processarem a mesma entrada ao mesmo tempo. Hoje `get_pending` só lê, e
  as marcações só travam a linha durante a própria transação.

### 17.8 Testes e mutações (implementação inicial)

A ordem seguida foi testes, depois implementação, depois mutações.

**Reprodução vermelha, contra a main `3feedd1`, sem a B3.2b:**
- **Unitários** (`b3-2b-inbox-cifra`, `b3-2b-inbox-servidor`): commit
  `225b2cb`. Os 75 falham.
- **pgTAP 31 (84 testes):** rodado numa PR temporária só com o arquivo de
  teste.
  - Na primeira rodada, o arquivo usava `like()`, que não existe no pgTAP,
    e parou no teste 8, com 7 de 8 falhando. Corrigido para `alike()` em
    commit só de teste (`945c5b0`).
  - Na segunda rodada, 23 dos 24 testes executados falham, e o arquivo
    para quando a primeira consulta direta encontra a tabela inexistente.
    O único que passa é "nenhuma é executável por PUBLIC, anon ou
    authenticated", vazio sem as funções.

**Implementação** (`0e80dda`), verificada antes numa PR temporária com o
mesmo conteúdo:
- unitários: 75 de 75;
- suíte inteira: 1560;
- pgTAP 31: 84 de 84;
- CI completo verde (typecheck, lint, tipos gerados, pgTAP, isolamento,
  concorrência, build e E2E).

O pgTAP 29 da B3.1 contava todas as funções `public.whatsapp_*` (esperava
10, agora são 16). A contagem passou a excluir as seis da inbox, que o
pgTAP 31 cobre.

**Mutações do servidor:** 12, locais, cada uma aplicada e desfeita.
Todas foram detectadas:

| Mutação | Detectada por |
|---|---|
| Canal fora da AAD | AAD por canal; AAD de outro canal rotulada com o meu |
| Workspace fora da AAD | AAD por workspace; separador |
| Ambiente fora da AAD | AAD por ambiente |
| Aceita contexto fabricado | objeto à mão, cópia do contexto, leitura com contexto à mão |
| Sem conferência de ambiente no servidor | contexto de Preview com servidor em Production |
| Aceita corpo não verificado | bytes crus; objeto que imita o corpo |
| Listagem expõe texto cifrado | listagem e marcação só com metadado |
| Leitura sem conferir a identidade da linha | linha de outro workspace |
| Leitura sem conferir o hash | `inbox_integrity_failed` |
| Retenção com valor padrão | retenção ausente ou vazia |
| Erro do banco repassado com o texto original | erro desconhecido vira `unknown` |
| Reaproveita a chave de credencial | chave da inbox ausente |

**Mutações do banco:** 7, cada uma numa PR temporária própria (#51 a #57)
sobre o mesmo commit verificado. Todas foram detectadas pelo pgTAP:

| Mutação | Testes que falharam |
|---|---|
| Sem conferência de ambiente no canal | Production × Preview nos dois sentidos; leitura em outro ambiente |
| Conflito sobrescreve o primeiro payload | conflito sem sobrescrever; duplicata depois do conflito; auditoria; conflito sobre tombstone |
| Sem unicidade (canal, id do evento) | unicidade; duplicate; uma linha só; conflict |
| Expurgo apaga a linha (sem tombstone) | tombstone (e o arquivo para) |
| EXECUTE para authenticated | privilégios (29 e 31); authenticated não grava nem lista |
| Listagem expõe o texto cifrado | listagem e marcação só com metadado |
| Aceita canal desativado e desconectado | desativado e desconectado |

### 17.9 Limitações e decisões

- **Contexto confiável de canal desativado (B3.2d).** O banco já permite acessar
  a entrada existente de um canal desativado. No servidor, o contexto
  confiável desse canal hoje só sai da resolução administrada
  (`adminResolveManagedWhatsAppChannel`, com sessão autorizada): a
  resolução do webhook recusa canal desativado, como deve. Um worker sem
  sessão (B3.2d) vai precisar de uma resolução interna própria, por id do
  canal, sem segredo de webhook.
- **Resolvido na B3.2d-1 (§19):** o claim resolve a entrada pelo id, com
  o contexto e o estado atual do canal vindos do banco, inclusive de
  canal desativado, e trava a linha contra dois workers. O item acima e
  o seguinte deixaram de ser pendências.
- **Aceitas para a B3.2d:** a resolução interna de entradas antigas de
  canais desativados (item acima) e o claim atômico contra dois workers
  processarem a mesma entrada (§17.7).
- **Expurgo independe do estado.** Ele atua sobre pendentes vencidas
  também, porque a retenção prevalece.
- **Variáveis novas não configuradas:** `WHATSAPP_INBOX_KEY_VERSIONS`,
  `WHATSAPP_INBOX_ACTIVE_KEY_VERSION` e `WHATSAPP_INBOX_RETENTION_SECONDS`.
  Nenhuma foi criada em nenhum ambiente, e sem elas a gravação falha
  fechada.
- **Migration não aplicada no hospedado.** A da B3.2b, assim como as da
  B3.1, não foi aplicada no Supabase hospedado.

### 17.10 Revisão da PR #58

Pedida sobre o HEAD `712ee0d`. Três pontos:

1. **Gravar antes da normalização.** `storeWhatsAppWebhookDelivery`
   chamava `normalizeEvents()` antes de gravar: um evento autêntico com
   conteúdo inesperado era recusado e se perdia. Agora usa só a inspeção
   mínima do envelope (§17.3), e `event_kind` (tipo normalizado) virou
   `provider_event_type` (tipo bruto) na tabela, nas funções, nos tipos
   gerados e nas listagens.
2. **Regras de estado separadas.** A mesma regra (só ativo ou pausado)
   valia para tudo e podia aprisionar uma entrada legítima se o canal
   mudasse de estado depois do recebimento. Agora são duas regras (§17.5).
3. **Teto de 30 dias.** O teto técnico da retenção da inbox caiu de 3650
   para 30 dias (§17.6).

**Reprodução vermelha, contra o HEAD `712ee0d`** (commit só de testes
`b842116`):
- **Unitários:** arquivo novo `b3-2b-revisao-envelope-retencao` e
  ajustes em `b3-2b-inbox-servidor`. Falham 59; os que passam são guardas
  que já valiam (JSON inválido recusado, retenção ausente recusada, 60 s,
  7 e 30 dias aceitos).
- **pgTAP 31 revisado (113 testes):** numa PR temporária (#59) com o
  `712ee0d` e só o arquivo de teste. Falham 17 de 113, e o arquivo roda
  até o fim:
  - colunas exatas (`event_kind` ainda existe);
  - canal desconectado recusado na entrega nova;
  - 30 dias mais 1 segundo e 3650 dias aceitos (e, por isso, linhas a
    mais nos dois testes de contagem seguintes);
  - tipo bruto desconhecido do CRM recusado; tipo bruto não gravado;
  - listagem e marcação com `event_kind`;
  - canal desconectado depois do recebimento: leitura, marcação e entrega
    nova recusadas;
  - canal desativado depois do recebimento: listagem, leitura e as duas
    finalizações recusadas.

**Correção** (`b06fa32`): unitários da inbox 127 de 127; suíte inteira
1612; pgTAP 31 113 de 113 e CI completo verde na própria PR.

**Mutações do servidor e dos adaptadores:** 8, locais, cada uma aplicada
e desfeita. Todas foram detectadas:

| Mutação | Detectada por |
|---|---|
| `normalizeEvents()` de volta antes da gravação | YCloud e simulador sem identidade guardados; a gravação nunca normaliza; versão e lote |
| Inspeção YCloud exige identidade do remetente | inspeção aceita sem identidade; envelope sem corpo específico; gravação YCloud sem identidade |
| Inspeção YCloud ignora a versão | `v3` e `v1` recusados; gravação com versão incompatível |
| Inspeção YCloud aceita lote | lote recusado na inspeção e na gravação |
| Inspeção do simulador aceita lote | lote com dois eventos; lote não gravado |
| Tipo gravado é o normalizado | a gravação nunca normaliza; tipo desconhecido gravado como veio |
| Teto volta a 3650 dias | teto exportado; 30 dias mais 1 s, 31 dias e 3650 dias recusados |
| Retenção ausente vira 30 dias | ausente e vazia recusadas |

**Mutações do banco:** 5, cada uma numa PR temporária própria (#60 a #64)
sobre `b06fa32`:

| Mutação | Testes que falharam |
|---|---|
| Acesso a entrada existente usa a regra de recebimento | canal desativado depois: listagem, leitura e finalizações |
| Recebimento usa a regra de acesso | canal desativado: entrega nova recusada e nada gravado; desativado depois: entrega nova, reentrega idêntica, nenhuma linha nova |
| Regra antiga (ativo ou pausado) para todas as operações | desconectado: entrega nova; desconectado depois: leitura, marcação, entrega nova; desativado depois |
| Teto do banco volta a 3650 dias | 30 dias mais 1 s e 3650 dias recusados; nenhuma linha das recusadas; listagem do canal só com as entregas dele |
| Tipo restrito ao vocabulário normalizado | tipo bruto desconhecido do CRM aceito e gravado |

#### Prazo calculado pelo banco (última correção antes do merge)

Na revisão anterior, o servidor calculava `retain_until` com o próprio
relógio e o banco comparava com o dele: com exatamente 30 dias, uma
pequena diferença entre os relógios podia recusar uma configuração
válida. Corrigido como descrito no §17.6. Assinatura final:

```sql
public.whatsapp_inbox_store(
  p_channel_id uuid, p_workspace_id uuid, p_provider public.whatsapp_provider,
  p_routing_key text, p_provider_event_id text, p_provider_event_type text,
  p_body_sha256 text, p_key_version text, p_nonce text, p_ciphertext text,
  p_auth_tag text, p_retention_seconds integer
) returns jsonb  -- { outcome, inbox_id }
```

**Reprodução vermelha, contra o HEAD `3a9ffff`** (commit só de testes
`780aeb4`):
- **Unitários:** falham 8. São os três de retenção aceita (60 s, 7 e 30
  dias, que agora exigem `p_retention_seconds`), o "manda só os segundos,
  nunca um horário", os três de relógio da aplicação (adiantado 1 hora,
  atrasado 1 hora e adiantado 2 dias, em que os argumentos mudavam com o
  relógio) e o de argumentos exatos da gravação.
- **pgTAP 31 (123 testes):** numa PR temporária (#65) com o `3a9ffff` e só
  o arquivo de teste. Falham 46 dos 60 executados, e o arquivo para na
  linha 336: a função antiga não aceita a retenção em segundos, então
  nenhuma gravação acontece e a primeira consulta por uma entrada gravada
  não encontra linha. Falham também a assinatura (um inteiro no fim) e "a
  gravação não recebe horário, data nem intervalo da aplicação".

**Testes novos ou alterados:**
- unitários: retenção mandada em segundos; nenhum argumento com data ISO;
  relógio da aplicação adiantado 1 hora, atrasado 1 hora e adiantado 2
  dias, sempre com 30 dias aceitos e argumentos idênticos;
- pgTAP: assinatura; nenhum argumento de data, hora ou intervalo;
  retenção nula, zero, negativa, 59 s, 2.592.001 s e 3650 dias recusadas;
  2.592.000 s aceita, com `received_at = now()` e
  `retain_until - received_at = 2.592.000 s`; 7 dias com
  `retain_until - received_at = 604.800 s`; reentrega idêntica e
  divergente com outra retenção preservando o primeiro payload e o
  primeiro prazo; restrição de 30 dias na tabela.

**Correção** (`4660c93`): suíte inteira 1616; pgTAP 31 123 de 123; CI
completo verde e Vercel.

**Mutações:**

| Mutação | Onde | Testes que falharam |
|---|---|---|
| O servidor volta a calcular o prazo (horário absoluto pelo relógio da aplicação) | local | os 8 do vermelho unitário |
| O servidor manda os segundos **e** o horário absoluto | local | os mesmos 8 |
| O prazo usa um segundo horário (`clock_timestamp()`) | PR #66 | 30 dias exatos aceitos; prazo = recebimento + 2.592.000 s; 7 dias exatos; reentrega idêntica; primeiro prazo preservado |
| Limite exato recusado (teto 2.591.999 s) | PR #67 | 30 dias exatos aceitos; prazo de 30 dias; reentrega com 30 dias |
| Sem a restrição de 30 dias na tabela | PR #68 | restrição de 30 dias |
| Reentrega renova o prazo | PR #69 | primeiro prazo preservado |

Tombstone, isolamento, cifra, estados do canal e permissões não mudaram:
os testes deles continuam iguais e verdes.

## 18. B3.2c — rota pública autenticada do webhook (21/10/2026)

Implementada só a rota que recebe a entrega do provedor, autentica, grava
na inbox cifrada da B3.2b e publica um evento interno. Ficam de fora:
- normalização do evento e o consumidor do evento interno (B3.2d);
- a rota de atendimento do Inngest do WhatsApp e a signing key dela
  (B3.2d, com prefixo `WHATSAPP_`);
- contato, lead, conversa, classificação, envio e mídia;
- registro do adaptador YCloud na resolução de provedor (continua sem
  adaptador: `WHATSAPP_PROVIDER=ycloud` responde 404);
- reconciliador da inbox parada (B3.2e);
- credencial real, variável em qualquer serviço externo, app registrado no
  Inngest, migration no Supabase hospedado e qualquer mudança no chatbot.

Revisada na PR #70 (§18.7): a URL usa um localizador opaco no lugar da
routing key, o Inngest do WhatsApp é separado do da A11 e o evento interno
leva só o id da inbox.

### 18.1 Entregue

- **Rota** `src/app/api/webhooks/whatsapp/[provider]/[webhookRouteId]/route.ts`
  (runtime Node, sem cache), só `POST`.
- **`src/server/whatsapp/webhook-route.ts`:** o tratamento inteiro da
  requisição e `whatsappWebhookPath`, que monta o caminho de um canal.
- **`adminResolveWhatsAppWebhookRoute`** (`admin/channels.ts`): resolução
  pelo localizador opaco.
- **`src/server/whatsapp/inngest.ts`:** o cliente Inngest próprio do
  WhatsApp.
- **`src/server/whatsapp/inbox-events.ts`:** o evento interno.
- **`src/proxy.ts`:** `/api/webhooks/whatsapp` entra na lista de caminhos
  públicos (sem sessão; autenticado pela assinatura do canal).
- **Migration nova** `20261022120000_b3_2c_webhook_route_id.sql` (as
  migrations já mescladas não foram editadas) e os tipos gerados.

### 18.2 Por que o canal vem antes da assinatura, e por que pelo localizador

O segredo do webhook é **por canal** (B3.1). Para conferir a assinatura, a
rota precisa saber de qual canal é a entrega **antes** de autenticá-la, e
sem ler o corpo, que ainda não está autenticado. Por isso a referência do
canal vai na URL.

Essa referência **não** pode ser a routing key real: na YCloud ela é
`<wabaId>:<telefone do escritório>`, e a URL fica gravada nos logs da
Vercel, da YCloud, de observabilidade e no histórico de requisições. A URL
leva só o **localizador opaco** do canal:

```
/api/webhooks/whatsapp/<provedor>/<webhook_route_id>
```

- `webhook_route_id` é um UUID aleatório (versão 4) próprio do canal. Não é
  o id do canal nem derivado da routing key, e não contém nenhum dado do
  escritório.
- É só um **localizador**. A autenticação continua sendo a assinatura com o
  segredo do canal: quem conhece a URL e não tem o segredo recebe 401.
- É imutável depois de criado, para que a URL cadastrada no provedor não
  mude.
- A routing key real continua no banco e só é usada por dentro do servidor.
  Ela nunca entra na URL, na resposta ou no evento interno.
- A URL futura cadastrada na YCloud terá esse UUID, nunca WABA ou telefone.

**Diferença do §4.1.** O §4.1 previa a assinatura antes da resolução do
canal, e a rota só com `[provider]`. Com o segredo por canal, a ordem é a
desta seção.

### 18.3 Fluxo

| Passo | O que acontece | Falha |
|---|---|---|
| 1. Desligado? | Provedor da URL conhecido e habilitado neste ambiente, chave de ambiente do WhatsApp configurada, localizador que seja um UUID | 404 **sem banco** |
| 2. Bytes exatos | `readWhatsAppWebhookBody`, limite de 256 KiB, sem decodificar | 413 (tamanho), 400 (ilegível) |
| 3. Canal | `whatsapp_resolve_webhook_route(provedor, localizador)` no ambiente assinado devolve o canal e a routing key real; com ela, a resolução da B3.1 devolve o segredo do webhook, e as duas linhas têm de ser o mesmo canal | 404 (desconhecido, desativado, outro ambiente, divergência); 503 (banco ou cifra) |
| 4. Assinatura | `adapter.verifyWebhook` sobre os bytes, com o segredo **desse** canal | 401 `invalid_signature`, igual para toda falha |
| 5. Inbox | `storeWhatsAppWebhookDelivery`: inspeção mínima e gravação cifrada, sem normalização | 400 (envelope inválido, versão, lote); 404 (canal desativado no meio); 503 (retenção ou chave ausente, banco) |
| 6. Evento | `praxis/whatsapp.inbox.received` `{ inboxId }`, só para canal **ativo** e resultado `inserted` ou `duplicate` | falha ignorada: continua 200 |

Respostas: `200 {"status":"received"}` para `inserted`, `duplicate` e
`conflict`, e `{"error":"<código>"}` nas falhas. Nenhuma resposta traz
conteúdo, telefone, WABA, routing key, segredo, erro bruto, id da inbox, do
canal ou do workspace. Nenhuma etapa escreve log.

**Decisões mantidas:**
- `inserted` e `duplicate` com canal ativo publicam, com o mesmo id;
- `conflict` não publica;
- canal pausado ou desconectado: a entrega é preservada na inbox, sem
  evento (aceitar não é processar);
- nenhuma normalização acontece na rota.

**Por que 200 depois de uma falha de publicação é seguro.** A gravação na
inbox é durável e acontece antes da publicação; a entrada fica `pending`.
Responder 200 evita que o provedor reenvie algo que já está guardado. Isso
só é seguro porque a **B3.2e (reconciliador) é portão obrigatório antes de
cadastrar qualquer webhook real**: é ela que encontra a entrada pendente e
republica o evento perdido. Sem a B3.2e, uma publicação perdida ficaria
parada.

### 18.4 Resolução pelo localizador (banco)

```sql
public.whatsapp_resolve_webhook_route(
  p_provider public.whatsapp_provider,
  p_webhook_route_id uuid
) returns table (
  channel_id uuid, workspace_id uuid,
  environment public.whatsapp_environment, provider public.whatsapp_provider,
  routing_key text, status text
)
```

- Exige o ambiente assinado do WhatsApp; só canais desse ambiente.
- Canal desativado, de outro provedor, de outro ambiente ou inexistente:
  nenhuma linha (a rota responde 404). O id do canal não localiza nada.
- Nunca devolve credencial, texto cifrado, versão de chave ou segredo. O
  segredo continua saindo só da resolução da B3.1
  (`whatsapp_resolve_webhook_channel`), chamada com a routing key obtida
  aqui.
- SECURITY DEFINER, search_path travado, EXECUTE só para `service_role`.

A coluna `whatsapp_channels.webhook_route_id`:
- `uuid not null default gen_random_uuid()`, com restrição de unicidade;
- preenchida nos canais que já existiam (inclusive os legados da A7);
- travada pelo guarda da identidade do canal (`channel_identity_immutable`);
- o canal da B3 não é visível por SELECT direto de `authenticated` (só as
  linhas legadas da A7), então o localizador também não.

### 18.5 Evento interno e Inngest próprio

```ts
whatsappInngestClient().send({
  id: inboxId,                         // deduplicação do Inngest
  name: "praxis/whatsapp.inbox.received",
  data: { inboxId },                   // exatamente isto
});
```

- **Só o id da inbox.** Nada de workspace, canal, ambiente, provedor ou
  routing key. Um campo a mais na chamada nunca entra no evento.
- **Mesma entrada, mesmo evento:** a duplicata republica exatamente o mesmo
  evento, com o mesmo id.
- **Requisito da B3.2d:** o consumidor resolve tudo pelo `inboxId` no
  banco (canal, workspace, ambiente, provedor, estado) e **nunca confia em
  contexto recebido no evento**. Junto com o claim atômico (§17.7) e a
  resolução interna das entradas de canais desativados (§17.9).

**Separado da A11 e da agenda:**
- cliente próprio em `src/server/whatsapp/inngest.ts`, app
  `praxis-crm-whatsapp` (o da A11 é `praxis-crm`);
- chave própria `WHATSAPP_INNGEST_EVENT_KEY`, passada **explicitamente** ao
  SDK. Sem fallback para `INNGEST_EVENT_KEY`: sem a chave explícita, o SDK
  usaria a variável genérica da A11;
- nenhum arquivo de `src/server/whatsapp/` nem da rota importa
  `@/server/ingest/*` (A11) ou `@/server/calendar/*` (agenda); um teste
  confere isso em todos os arquivos;
- **falha fechada:** chave ausente, vazia ou só com espaços →
  `inbox_event_not_configured`, sem criar cliente nem enviar nada, e o
  erro não leva nome nem valor de chave.
- A rota de atendimento do Inngest e a signing key do WhatsApp ficam para a
  B3.2d, também com prefixo `WHATSAPP_`.
- Nenhuma variável foi configurada e nenhum app foi registrado no Inngest.

### 18.6 Testes

Escritos antes da implementação, contra a main `7e30e2c` (commit só de
testes `01a0fe2`): os 60 falham. Implementação `7889996`: os 60 passam.

Antes de publicar aquele commit de testes, corrigi dois erros meus nele: um
teste esperava gravar um corpo com BOM (a UTF-8 estrita da B3.1 recusa:
400) e o tipo do corpo da `Request`. O vermelho foi refeito depois.

A revisão (§18.7) reescreveu os dois arquivos unitários e acrescentou o
pgTAP 32. Cobertura final:

`tests/unit/b3-2c-rota-webhook.test.ts`:
- **URL:** o único segmento depois do provedor é `[webhookRouteId]`; o
  caminho de um canal é `/api/webhooks/whatsapp/<provedor>/<UUID>`, sem
  WABA, telefone ou routing key, e só é montado com um UUID; uma entrega
  válida chega por uma URL sem esses dados;
- **desligado:** sem provedor, simulador em Production, sem chave de
  ambiente, provedor desconhecido, de outro provedor ou em maiúsculas,
  YCloud sem adaptador: 404 sem banco;
- **localizador inválido:** vazio, não UUID, a própria routing key, o WABA,
  o telefone, caractere inválido, curto ou com espaço: 404 e **nenhuma**
  consulta;
- **bytes:** limites de 256 KiB; CRLF cifrado byte a byte; BOM recusado;
- **canal pelo localizador:** ordem das chamadas (localizador, segredo,
  gravação); routing key real só por dentro; UUID em maiúsculas é o mesmo;
  localizador desconhecido, de outro ambiente, de outro provedor, sem
  routing key ou com mais de uma linha: 404; segredo de outro canal ou
  canal desativado entre as resoluções: 404 sem gravar; erro do banco: 503
  sem detalhe;
- **assinatura:** os casos de 401, todos iguais;
- **inbox e evento:** evento exatamente `{ inboxId }`; duplicata
  republica o mesmo evento; conflito, pausado e desconectado não publicam;
  falha ao publicar continua 200 e nada é marcado; sem normalização;
  envelope inválido 400; configuração ausente 503;
- **nada sai:** respostas sem conteúdo, telefone, WABA, routing key, ids
  internos, segredo ou erro bruto; nada no console; rota pública.

`tests/unit/b3-2c-evento-interno.test.ts`:
- contrato exato do evento; mesma entrada, mesmo evento; campos a mais
  ignorados; id inválido; falha do Inngest com código fixo;
- app `praxis-crm-whatsapp` com a chave própria explícita;
  `INNGEST_EVENT_KEY` sozinha não habilita; chave do WhatsApp vazia ou só
  com espaços falha fechada mesmo com a da A11; com as duas, só a do
  WhatsApp é usada; o erro não leva nome nem valor de chave;
- nenhum arquivo do WhatsApp importa A11 ou agenda; o cliente e o evento
  não leem `INNGEST_EVENT_KEY` nem usam o app `praxis-crm`.

`supabase/tests/database/32_b3_2c_webhook_route.test.sql` (26 testes):
coluna uuid obrigatória, única, preenchida, diferente do id do canal, um
por canal, sem a routing key, versão 4 e imutável; função só de
`service_role`, SECURITY DEFINER, search_path travado, sem segredo no
retorno; sem ambiente assinado recusa; ativo, pausado e desconectado
encontrados com a routing key real e o estado; desativado, inexistente,
outro provedor, id do canal, nulo e o outro ambiente (nos dois sentidos)
não encontrados; `authenticated` e `anon` não resolvem e `authenticated`
não lê o canal por SELECT direto.

O pgTAP 29 passou a excluir a função nova da contagem das 10 funções da
B3.1, como já fazia com as da inbox.

### 18.7 Revisão da PR #70

Pedidos da revisão sobre `68c5f47`:
1. tirar a routing key da URL e usar um localizador opaco do canal;
2. separar por completo o Inngest do WhatsApp do da A11;
3. reduzir o evento interno a `{ inboxId }`.

Nada foi ampliado para processamento de mensagens.

**Vermelho antes, verde depois.**
- Commit só de testes `37759e8`, sobre `68c5f47`:
  - unitários: **78 de 96 falham**. Os 18 que passam são os de isolamento
    por arquivo dos arquivos que já eram limpos e o da rota pública;
  - pgTAP 32: **22 de 26 falham** (PR temporária #71, run 39640185748).
    Os 4 que passam são as negativas de privilégio e de acesso,
    verdadeiras também sem a função.
- Correção `e037c52`, mais os tipos gerados em `9daa943`:
  - unitários da B3.2c: **97 de 97** (um a mais, porque o teste de
    isolamento por arquivo passa a cobrir `inngest.ts`);
  - suíte inteira: 1713;
  - typecheck e lint limpos;
  - pgTAP 32: 26 de 26; CI completo verde (run 39642037086).

**Correções minhas no caminho.**
- **Fixture errada no commit de testes.** O segredo do "outro canal" estava
  cifrado com a AAD de outro id, e o teste dava 503 em vez de 404. Corrigi
  antes de publicar o commit (`37759e8`) e refiz o vermelho.
- **Tipos gerados incompletos em `e037c52`.** O gerador também acrescenta
  `webhook_route_id` ao retorno de `create_whatsapp_channel`. O CI falhou
  na comparação dos tipos. `9daa943` substitui o arquivo pelo gerado no CI.

**Mutações locais** (13, cada uma aplicada e desfeita; todas detectadas):

| Mutação | Detectada por |
|---|---|
| T1 routing key de volta na URL (`[routingKey]`) | único segmento `[webhookRouteId]`; entrega válida por URL sem WABA, telefone ou routing key |
| T2 resolve pela routing key recebida na URL | localizador não UUID, a routing key, o WABA ou o telefone: 404 e nenhuma consulta |
| T3 aceita linha do localizador de outro ambiente | linha de outro ambiente devolvida por engano: 404 |
| T4 não exige o mesmo canal nas duas resoluções | segredo de outro canal: 404 sem gravar |
| T5 volta a importar o publisher da A11 | app `praxis-crm-whatsapp`; `INNGEST_EVENT_KEY` sozinha não habilita; isolamento de imports |
| T6 aceita `INNGEST_EVENT_KEY` como fallback | `INNGEST_EVENT_KEY` sozinha não habilita; chave do WhatsApp vazia ou só espaços falha fechada |
| T7 app id `praxis-crm` | app `praxis-crm-whatsapp`; nenhum uso do app `praxis-crm` |
| T8 evento com workspace, canal, ambiente, provedor e routing key | evento só com o id da inbox; campos a mais nunca entram |
| T9 só o workspace a mais no evento | dados só `{ inboxId }` |
| T10 duplicata gera outro id de evento | id = id da inbox; mesma entrada, mesmo evento |
| T11 duplicata publicada com outro id, na rota | duplicata republica exatamente o mesmo evento |
| T12 falha de publicação marca a entrada como falha | falha ao publicar: 200 e a entrada fica pendente |
| T13 localizador sem validação de UUID antes do banco | localizador vazio, não UUID, routing key ou WABA: nenhuma consulta |

**Mutações do banco.** Seis, cada uma numa PR temporária (#72 a #77) sobre
`9daa943`. Todas foram reprovadas pelo pgTAP no CI:

| Mutação | Testes que falham |
|---|---|
| R1 o id do canal como localizador | 13, 14, 15 (ativo, pausado e desconectado não encontrados), 19 (o id do canal não serve), 23 |
| R2 aceita localizador de outro ambiente | 20 e 22 (o outro ambiente, nos dois sentidos) |
| R3 EXECUTE para `authenticated` | 32: 10 (privilégios) e 24 (`authenticated` não resolve); 29: 10 (nenhuma `public.whatsapp_*` para anon ou authenticated) |
| R4 aceita canal desativado | 16 (desativado: não encontrado) |
| R5 localizador igual ao id do canal | 4 (não é o id), 7 (versão 4), 19 |
| R6 localizador mutável | 8 (imutável) e 13 |

As PRs temporárias #71 a #77 foram fechadas, com as branches apagadas.

### 18.8 Limitações e requisitos para as próximas etapas

- **Roteamento do evento (B3.2d).** A assinatura prova que a entrega veio
  com o segredo do canal da URL. A inspeção mínima, porém, não lê a routing
  key do evento, então um evento de outro número da mesma conta, mandado
  para a URL de um canal, fica na inbox desse canal. A B3.2d tem de
  conferir a routing key normalizada contra a do canal e marcar a entrada
  como falha (`routing_mismatch`) quando divergir.
- **Consumidor do evento (B3.2d).** Tem de cumprir três coisas:
  - resolver canal, workspace, ambiente, provedor e estado pelo `inboxId`
    no banco, sem confiar em contexto do evento;
  - fazer o claim atômico (§17.7);
  - resolver internamente as entradas de canais desativados (§17.9).

  Hoje não há consumidor, então o evento não é processado.
- **Rota de atendimento e signing key do Inngest do WhatsApp (B3.2d)**, com
  prefixo `WHATSAPP_`.
- **Configuração global do SDK.** Variáveis globais do SDK do Inngest, como
  `INNGEST_DEV` e `INNGEST_BASE_URL`, continuam valendo para os dois
  clientes. A separação vale para o app e para a chave de evento.
- **YCloud ainda sem adaptador registrado.** `ycloud` continua `null` na
  resolução de provedor. Registrar o adaptador é um passo próprio, antes de
  qualquer webhook real (P3/P4), e inclui decidir a tolerância de horário
  da assinatura (§16).
- **Entradas de canal pausado ou desconectado** ficam pendentes, sem
  evento. Republicá-las na reativação é da B3.2d/B3.2e.
- **B3.2e é portão obrigatório.** Nenhum webhook real pode ser cadastrado
  antes do reconciliador da inbox parada. É ele que torna seguro responder
  200 depois de uma falha de publicação (§18.3).
- **Enumeração.** Localizador desconhecido responde 404 e assinatura
  inválida 401. Como o localizador é aleatório, isso não revela número nem
  conta do escritório.
- **Nada configurado fora do código:**
  - nenhuma URL cadastrada na YCloud ou na Meta;
  - nenhuma variável na Vercel;
  - nenhum app registrado no Inngest;
  - nenhuma migration aplicada no Supabase hospedado;
  - nenhuma mensagem enviada;
  - nenhuma mudança no chatbot.

## 19. B3.2d-1 — claim atômico da inbox e contexto interno (21/10/2026)

Esta etapa implementa só a fundação segura do consumidor: uma entrada da
inbox só é lida e só muda de estado por quem obteve o claim dela, e nenhum
contexto vindo do evento interno é confiado.

Ficam de fora:
- a rota `/api/inngest/whatsapp`, o registro de função no Inngest e a
  signing key (B3.2d-2);
- o consumo de evento real;
- normalização, roteamento do evento e aplicação ao domínio: conversa,
  contato, lead, atividade, mensagem e evento de domínio (B3.2d-2);
- republicação de pendentes e de leases vencidas (B3.2e);
- qualquer configuração externa e qualquer migration no Supabase hospedado.

### 19.1 Nova divisão da B3.2d

A B3.2d juntava concorrência, nova tentativa, normalização e mudanças
comerciais. Ela foi dividida para que a posse exclusiva de uma entrada
exista e esteja provada antes de qualquer efeito no domínio:

| Etapa | Conteúdo |
|---|---|
| **B3.2d-1** (esta) | Claim, lease, resolução interna pelo `inboxId` e leitura segura (decifra e confere o hash antes de devolver o corpo); finalizações presas ao token; aposentadoria da leitura e das marcações sem claim |
| **B3.2d-2** | Rota e função do Inngest do WhatsApp (prefixo `WHATSAPP_`), normalização, conferência da routing key do evento (`routing_mismatch`, §18.8), decisão por tipo de evento × estado do canal e aplicação ao domínio (regras do §15.10). Portão: efeito idempotente e cercado pelo claim vigente no banco (§19.9). Dividida em B3.2d-2a (consumidor sem efeito no domínio, §20) e B3.2d-2b (domínio, §20.9) |
| **B3.2e** | Republicação das entradas `pending` e das `processing` com lease vencida; batimento do canal. Continua portão obrigatório antes de qualquer webhook real (§18.3) |

### 19.2 Máquina de estados da inbox

| De | Operação | Para | Condição |
|---|---|---|---|
| `pending` | claim | `processing` | entrada dentro da retenção; gera token novo, `claim_count + 1` |
| `processing` | claim | `processing` | só com a lease **vencida**; token novo, o antigo deixa de valer |
| `processing` | complete | `processed` | token atual; terminal |
| `processing` | fail | `failed` | token atual e código simbólico; terminal |
| `processing` | release | `pending` | token atual e código simbólico; falha transitória, `claim_count` fica |
| `processing` | expurgo | `pending` (tombstone) | retenção vencida: a cifra e o claim somem |

- `processed` e `failed` nunca mudam de estado, nem por escrita direta.
- Uma restrição exige que `processing` tenha token, horário do claim e
  lease, com a lease depois do claim, ao menos um claim contado e conteúdo
  presente. Nos outros estados, token e lease ficam nulos.
- **`claim_count` conta aquisições de processamento, não entregas do
  provedor.** As entregas continuam deduplicadas na gravação, por canal e
  id do evento. Um gatilho impede que `claim_count` diminua.
- A evidência da última falha transitória (`last_release_code` e
  `last_released_at`) vem sempre com os dois campos juntos e só com código
  simbólico.

### 19.3 Claim e lease

```sql
public.whatsapp_inbox_claim(p_inbox_id uuid, p_lease_seconds integer) returns jsonb
```

- **Recebe só o id da inbox e a lease (15 a 900 s).** O servidor usa
  300 s quando o chamador não informa.
- **O contexto sai do banco, pela linha.** O banco resolve:
  - ambiente (o assinado da requisição);
  - workspace, canal e estado atual do canal;
  - provedor e routing key;
  - id e tipo bruto do evento;
  - hash e campos cifrados.
- **Ordem da decisão**, com a linha travada (`SELECT … FOR UPDATE`):
  1. inexistente ou de outro ambiente → `not_found`;
  2. `processed` → `already_processed`;
  3. `failed` → `terminal_failed`;
  4. expurgada ou com a retenção vencida → `expired`. A retenção prevalece
     também sobre uma lease vencida;
  5. `processing` com lease vigente → `busy`;
  6. senão → `claimed`, com token novo (`gen_random_uuid()`), lease a
     partir de `clock_timestamp()` e `claim_count + 1`.
- **Concorrência.** Quem chega durante um claim espera a trava e relê a
  versão final da linha, então duas chamadas nunca saem com dois claims
  válidos. A prova com sessões reais está no §19.7.
- **Estado do canal.** O canal pode estar ativo, pausado, desconectado ou
  desativado, e o claim devolve o estado atual. A entrada já recebida não
  fica presa. Processar ou não cada tipo de evento em cada estado é
  decisão da B3.2d-2. Isso também resolve o item do §17.9 sobre o contexto
  de canal desativado, porque o worker não precisa mais de sessão.
- **Retorno do `claimed`:**
  - traz o contexto interno, `claim_token`, `claim_count`, `claimed_at`,
    `lease_until`, hash e a cifra (versão, nonce, texto cifrado e tag);
  - **nunca** traz segredo do webhook, chave de API, credencial, corpo em
    texto puro ou mensagem de erro.
  - Os outros resultados devolvem só `{ outcome }`.

### 19.4 Finalização presa ao token

```sql
public.whatsapp_inbox_complete(p_inbox_id uuid, p_claim_token uuid) returns jsonb
public.whatsapp_inbox_fail(p_inbox_id uuid, p_claim_token uuid, p_error_code text) returns jsonb
public.whatsapp_inbox_release(p_inbox_id uuid, p_claim_token uuid, p_error_code text) returns jsonb
```

- Só alteram a entrada em `processing` com o **token atual** e a **lease
  vigente**:
  - token correto e lease vigente → pode finalizar;
  - token correto e lease vencida → `claim_lost`;
  - token antigo, inventado, ausente ou de outra entrada → `claim_lost`.
  - Em `claim_lost`, nada muda: estado, token, `claim_count`, horários,
    código e auditoria ficam como estavam.
- **A posse termina no vencimento da lease**, não só quando aparece outro
  token. Uma lease vencida volta a ter dono apenas por um novo
  `whatsapp_inbox_claim`.
- Com a linha travada, a ordem é: `not_found`, `already_processed`,
  `terminal_failed`; depois, estado `processing` e token; por fim, um único
  `clock_timestamp()` decide a lease (`lease_until` nula ou `<=` esse
  horário → `claim_lost`) e data a transição válida. `lease_until` igual ao
  horário da decisão já conta como vencida, o complemento exato do `busy`
  do claim.
- Resultados: `completed`, `failed`, `released`, `already_processed`,
  `terminal_failed`, `claim_lost` e `not_found` (inclui outro ambiente).
- Complete repetido → `already_processed`.
- Fail e release recebem só código simbólico (`^[a-z0-9_]{1,64}$`).
  Mensagem bruta → `invalid_error_code`, sem repetir o texto.
- Todas limpam token e lease. O release não mexe em `claim_count`.
- A falha terminal é auditada (`whatsapp.inbox.failed`) só com ambiente,
  provedor, canal e código. A auditoria nunca leva conteúdo, telefone,
  BSUID, routing key ou erro bruto.
- **Correção na revisão da PR #80.** A primeira versão (`49917a6`) não
  conferia `lease_until` na finalização: com a lease vencida e sem novo
  claim, o token antigo ainda completava, falhava ou liberava a entrada, o
  que contradizia o contrato da lease. A própria migration desta etapa foi
  corrigida (ela não foi mesclada nem aplicada); não há migration
  corretiva.

### 19.5 Caminho antigo aposentado

- **Removidas** na migration:
  - `whatsapp_inbox_get_pending`;
  - `whatsapp_inbox_mark_processed`;
  - `whatsapp_inbox_mark_failed`;
  - a auxiliar `private.whatsapp_inbox_lock_entry`.
- **Sem atalho direto à tabela.** A tabela perdeu o privilégio direto
  também de `service_role`. Só as funções SECURITY DEFINER a alcançam: a
  gravação, a listagem segura, o expurgo e as quatro do claim.
- **Servidor.** Saíram:
  - `readPendingWhatsAppWebhookDelivery`;
  - `markWhatsAppWebhookDeliveryProcessed`;
  - `markWhatsAppWebhookDeliveryFailed`.
- **Teste estático.** Confere que nenhum arquivo de `src` chama as RPCs
  antigas nem usa `.from("whatsapp_webhook_inbox")`.
- **Listagem.** Continua só com metadado. Agora mostra estado, contagem e
  lease, e nunca o token.
- **Expurgo.** Uma entrada vencida em processamento também é expurgada,
  vira tombstone `pending` e o token dela deixa de valer.

### 19.6 Servidor (`src/server/whatsapp/inbox.ts`)

- **`claimWhatsAppInboxEntry({ inboxId, leaseSeconds? })`:**
  - manda ao banco só o id e a lease. Qualquer outro campo do chamador é
    ignorado, e um id que não é UUID responde `not_found` sem banco;
  - confere o retorno campo por campo com esquema estrito: campo a mais,
    como corpo ou credencial, é recusado (`inbox_claim_invalid`);
  - exige que a linha seja da entrada pedida e do ambiente deste servidor;
  - monta o contexto a partir da linha, decifra com a AAD desse contexto
    e compara o SHA-256 em tempo constante;
  - só então devolve o `WhatsAppInboxClaim`, com `VerifiedWebhookBody` e
    metadados.
- **Falhas na conferência:**
  - cifra inválida → `fail` terminal com `inbox_decrypt_failed`;
  - hash divergente → `fail` terminal com `inbox_integrity_failed`;
  - chave da inbox ausente ou versão desconhecida → `release`, para nova
    tentativa.
  - Em todos os casos o corpo não sai.
- **Token.** O token não é propriedade do objeto do claim: fica num
  registro interno (`WeakMap`) e não aparece em JSON, erro ou log.
- **Finalizações.** `completeWhatsAppInboxClaim`, `failWhatsAppInboxClaim`
  e `releaseWhatsAppInboxClaim` só aceitam o claim emitido ali. Um objeto
  montado à mão ou copiado → `inbox_claim_untrusted`, sem banco.
- **`claim_lost` é repassado como veio.** O servidor não repete a chamada,
  não tenta completar e não dispara outra finalização (release ou fail)
  depois de um `claim_lost`. A garantia de posse é da RPC; o servidor não
  decide a lease pelo relógio local.
- **O claim não atravessa fronteira de execução.** A identidade do claim é
  a do objeto em memória (`WeakMap`). Ele não sobrevive a serialização,
  retorno de `step.run`, fila ou outra execução: uma cópia serializada →
  `inbox_claim_untrusted`, sem banco. Na B3.2d-2, claim, normalização,
  efeito e finalização acontecem na mesma execução lógica, e nenhuma
  operação externa ou efeito no domínio pode presumir que um claim
  serializado continua válido.
- Nenhuma operação escreve log; os erros são códigos fixos.

### 19.7 Testes

Escritos antes da implementação, contra a main `4e7c004`. O commit só de
testes é `c196ecf`.

**Vermelho contra a main**
- Unitários: 79 de 165 falham nos três arquivos tocados.
  - `b3-2d1-inbox-claim`: 78 de 79. O que passa é a checagem estática do
    `timingSafeEqual`, que a main já cumpre.
  - `b3-2b-inbox-servidor`: 1 de 30 (as chaves novas da listagem).
  - `b3-2b-revisao`: nenhuma falha; ali só saíram testes.
- pgTAP, na PR temporária #78:
  - 33: 74 de 82 falham. Os 8 que passam são negativas que já valem sem a
    função:
    - duas restrições de estado, que a main recusa pelo estado
      desconhecido;
    - nenhuma função da inbox executável por PUBLIC, anon ou authenticated;
    - nenhuma cifra no retorno do claim nem na listagem;
    - auditoria sem conteúdo;
    - as recusas de `authenticated` e de `anon`.
  - 31: 3 de 94 falham.
- Concorrência, na PR temporária #79: falha, porque os workers nem chegam
  à trava.

**Ajustes no caminho**
- **Antes de publicar o commit de testes**, corrigi dois erros meus:
  - o teste da chave ausente cifrava a fixture depois de apagar a chave;
  - um erro de tipo (`noUncheckedIndexedAccess`).
  - Refiz o vermelho depois.
- **Na primeira rodada da #78**, o pgTAP 33 parava na criação de uma
  função auxiliar que lê as colunas novas (Tests: 0). Em `7ffd948`, as
  leituras e escritas dessas colunas passaram por funções que capturam o
  erro. O vermelho foi refeito, agora com cada asserção contada.

**Verde (`5e78337` em diante)**
- Unitários: suíte inteira 1774; typecheck e lint limpos.
- No CI: pgTAP 33 (82) e 31 (94) passam, e o teste de concorrência real
  passa.

**Revisão da PR #80: lease vencida sem novo claim**

Testes escritos antes da correção, contra `49917a6`. O commit só de
testes é `df3e1b4`; a correção é `8185f38`.

- Vermelho contra `49917a6`:
  - pgTAP 33 (seção 13): 14 de 99 falham, todos da seção nova. Passam as
    outras 82 e três da seção 13 que valem nos dois códigos: lease futura
    finaliza, `already_processed` para os dois tokens e `terminal_failed`
    depois da falha.
  - Concorrência real, na PR temporária #96 (pgTAP sem interromper o
    job): os cenários 1 a 3 passam e o 4 falha, com
    `o complete com a lease vencida deveria ser recusado, veio: completed`.
  - Unitários: os 5 novos passam já contra `49917a6`. Eles fixam o
    contrato do servidor (repassar `claim_lost` sem repetir; recusar claim
    serializado), que já valia; a garantia da lease é da RPC.
- Verde (`8185f38`), no CI: unitários 1779 (suíte inteira), typecheck,
  lint e comparação de tipos limpos; pgTAP 33 (99) e 31 (94) passam;
  concorrência real com os quatro cenários; build e E2E (76).

**Cobertura**

pgTAP 33:
- **lease vencida sem novo claim (seção 13):**
  - complete, fail e release com o token atual → `claim_lost`;
  - nada muda: estado `processing`, token, `claim_count`, horários,
    código, `last_release_code`/`last_released_at` e auditoria;
  - lease terminando no instante atual já conta como vencida; a igualdade
    exata ao microssegundo não é reproduzível com o relógio real, então um
    teste estrutural confere a comparação `lease_until is null or
    lease_until <= v_now` na finalização;
  - lease 30 s à frente finaliza;
  - só um novo claim devolve um dono; o token substituído segue
    `claim_lost`, e `processed`/`failed` seguem nos resultados terminais;
- **estrutura:**
  - colunas e combinações incoerentes recusadas;
  - `claim_count` que não diminui;
  - estado terminal que não muda;
  - nenhum privilégio direto, nem de `service_role`;
- **funções:**
  - só as quatro do claim e as seguras da B3.2b;
  - argumentos exatos (só id, lease, token e código);
  - RPCs antigas inexistentes;
  - nada para PUBLIC, anon ou authenticated;
- **claim:**
  - primeiro claim com o contexto resolvido no banco e chaves exatas do
    retorno;
  - busy;
  - lease inválida;
  - reclaim com lease vencida e token novo;
- **tokens:** antigo, inventado, ausente e de outra entrada não alteram
  nada;
- **finalizações:**
  - complete e complete repetido;
  - fail com código bruto recusado e fail terminal auditado sem conteúdo;
  - release com `claim_count` preservado e novo claim;
- **retenção e isolamento:**
  - vencida e expurgada → `expired`;
  - expurgo durante o processamento invalida o token;
  - Preview × Production nos dois sentidos;
  - canal pausado, desconectado e desativado depois do recebimento;
- **listagem e permissões:** listagem sem token nem cifra; `authenticated`
  e `anon` sem acesso.

`scripts/b3-2d1-inbox-claim-concurrency-check.sh` é um passo novo do CI,
contra o Postgres local:
1. **Oito workers ao mesmo tempo.** Oito sessões psql pedem o claim da
   mesma entrada, todas paradas atrás de uma transação que segura a
   linha. Resultado: um `claimed` e sete `busy`, com `claim_count` 1.
2. **Token vencido espera e perde.** Com a lease vencida, um worker novo
   reclama a entrada e segura a transação. O complete do token antigo
   espera essa transação (cerca de 3,9 s no CI) e recebe `claim_lost`; só
   o token novo completa (`claim_count` 2).
3. **Complete segura a linha.** Com um complete de transação aberta, um
   claim concorrente espera e depois recebe `already_processed`.
4. **Lease vencida sem novo claim.** Um claim de 15 s vence de verdade, sem
   relógio forçado e sem nenhum outro claim. O complete com o token
   original recebe `claim_lost`, e a entrada segue `processing` com o
   mesmo token e `claim_count` 1. Um worker novo reclama com token novo; o
   token original segue recusado e só o novo completa (`claim_count` 2).

`tests/unit/b3-2d1-inbox-claim.test.ts`:
- só id e lease vão ao banco, e o contexto do evento é ignorado;
- lease fora da faixa e id inválido não chegam ao banco;
- o contexto vem da linha, inclusive de outro workspace, canal e provedor;
- corpo exato com CRLF; estados do canal;
- o token não aparece no objeto nem em JSON;
- retorno com corpo, segredo, chave de API, credencial ou campo
  desconhecido é recusado;
- linha de outra entrada ou de outro ambiente é recusada;
- AAD de outro workspace, canal, provedor, ambiente ou evento leva a falha
  terminal;
- hash divergente leva a falha terminal; chave ausente leva a release;
- finalizações só com o claim emitido ali, e códigos brutos recusados;
- `claim_lost` em complete, fail e release repassado com uma única
  chamada, sem repetir nem outra finalização;
- claim serializado (JSON, como um retorno de `step.run`) recusado antes do
  banco;
- APIs antigas inexistentes, e nenhum arquivo de `src` com RPC antiga ou
  acesso direto à tabela;
- nenhum erro bruto, token ou conteúdo em erro; nada no console.

O pgTAP 31 e os unitários da B3.2b perderam os testes das RPCs e APIs
aposentadas, agora cobertas pelo claim. O 31 passou a ler a tabela como
postgres.

### 19.8 Mutações

**Locais (servidor)**

16 mutações, cada uma aplicada e desfeita. Na primeira rodada, uma
sobreviveu: a AAD montada com workspace e canal fixos, iguais aos da
fixture. O teste de uma linha de outra identidade (`ab8231d`) passou a
pegá-la. Todas foram detectadas:

| Mutação | Detectada por |
|---|---|
| U1–U3 AAD sem workspace, sem canal ou sem provedor | AAD de outro workspace, canal ou provedor: falha terminal |
| U4 hash não conferido | hash divergente: `inbox_integrity_failed` |
| U5 retorno com corpo ou credencial aceito (esquema não estrito) | retorno com corpo, segredo, chave de API, credencial |
| U6 claim manda o contexto do evento | só id e lease vão ao banco |
| U7 token exposto no objeto do claim | o token não é propriedade nem aparece em JSON |
| U8 finalização aceita claim montado à mão | claim falsificado: `inbox_claim_untrusted` |
| U9 fail aceita erro bruto | códigos fora do formato recusados antes do banco |
| U10 complete sem token | complete manda o id e o token |
| U11 ambiente da linha não conferido | linha de outro ambiente: recusada |
| U12 id da linha não conferido | linha de outra entrada: recusada |
| U13 API antiga de marcação de volta | as APIs antigas não existem mais |
| U14 cifra inválida não falha a entrada | AAD de outra identidade: `fail` terminal chamado |
| U15 inboxId inválido vai ao banco | id inválido: `not_found` sem banco |
| U16 AAD de constantes, não da linha | entrada de outro workspace, canal e provedor decifra |

**Banco**

Cada mutação do banco rodou numa PR temporária, sobre `7ffd948`:

| Mutação | Reprovada por |
|---|---|
| D1 lease vigente não dá busy (dois workers com claim) | pgTAP 33: busy (25–27), novo claim e contagem (32), tokens errados (37), processed (39) |
| D2 claim sem trava de linha | Concorrência real, cenário 1: os oito workers saíram com `claimed` (`claimed=8`), não um. O pgTAP passa, como esperado, porque roda numa sessão só. A primeira versão desta mutação apagou também o `;` do SELECT e a migration não aplicava. Atribuí as falhas ao limite de pulls do `public.ecr.aws`, cujos avisos aparecem no mesmo passo, mas a causa era minha; corrigida a sintaxe, ela rodou |
| D3 reclaim antes do vencimento da lease | pgTAP 33: os mesmos seis do D1 |
| D4 token antigo completa | pgTAP 33: 14 testes, entre eles token antigo (33–34), inventado, ausente e de outra entrada (35–37), token liberado (56) |
| D5 complete sem token | pgTAP 33: token ausente (35–36), nada muda (37), complete com o token atual (38) |
| D6 fail e release aceitam erro bruto | pgTAP 33: fail e release com mensagem bruta (44, 52) |
| D7 release zera `claim_count` | pgTAP 33: release, contagem preservada, novo claim (53–56), `claim_count` nunca diminui (58) |
| D8 entrada vencida reclamada | pgTAP 33: vencida não expurgada (60–61), em processamento com retenção vencida (62) |
| D9 outro ambiente aceito | pgTAP 33: Preview com ambiente Production e o inverso (67, 70) |
| D10 canal desativado aprisiona a entrada antiga | pgTAP 33: claim e finalização com o canal desativado (76–77) |
| D11 claim liberado para `authenticated` | pgTAP 29 (10), 31 (11) e 33 (16, 80) |
| D12 leitura antiga sem claim mantida | Unitário: os tipos gerados voltam a expor `whatsapp_inbox_get_pending`, e o teste estático de `src` reprova. Sem atualizar os tipos, a comparação de tipos do CI reprova antes. Nos dois casos o CI para antes do pgTAP |
| D13 retorno do claim com credencial do canal | pgTAP 33: chaves exatas do retorno (19), nenhuma cifra de credencial (24) |
| D14 tabela continua acessível a `service_role` | pgTAP 33: nenhum privilégio direto (11) |
| D15 sem a guarda de `claim_count` e estados terminais | pgTAP 33: `claim_count` nunca diminui (58), processada não volta a pendente (59) |
| D16 finalização sem conferir `lease_until` (revisão da PR #80, sobre `8185f38`) | pgTAP 33, seção 13: 14 de 99, os mesmos do vermelho: complete, fail e release com a lease vencida (83, 85, 88), nada muda (84, 86, 89), sem auditoria (87), fronteira (90–91), comparação da finalização (92) e o reclaim seguinte (94–96, 98). PR temporária #97 |

As PRs temporárias #78, #79, #81 a #97 foram fechadas, com
as branches apagadas.

### 19.9 Limitações e requisitos para as próximas etapas

- **Portão obrigatório da B3.2d-2: efeito no domínio cercado pelo
  claim.** Um worker pode perder a lease depois de aplicar parte do
  efeito; o complete dele recebe `claim_lost`, e o novo dono processa de
  novo. Antes de qualquer escrita no domínio, a B3.2d-2 precisa garantir:
  1. toda escrita no domínio é idempotente pelo identificador estável do
     evento;
  2. a RPC que aplicar o efeito confere no banco o `inboxId`, o token atual
     e a lease vigente, com a mesma regra da finalização;
  3. de preferência, o efeito no domínio e a marcação como `processed`
     acontecem na mesma transação;
  4. se forem separados, uma queda entre o efeito e o complete não pode
     duplicar mensagem, conversa, contato, lead, atividade ou evento
     técnico;
  5. eventos ignorados legitimamente (por tipo ou estado do canal) também
     são finalizados com o claim vigente, nunca por fora dele.
- **Claim na mesma execução (B3.2d-2).** Claim, normalização, efeito e
  finalização acontecem na mesma execução lógica. O claim não é devolvido
  por `step.run`, não vai para fila nem para outra execução (§19.6).
- **Política de nova tentativa (B3.2d-2/B3.2e).** O release não tem
  espera nem teto. A B3.2d-2 decide o que é transitório, e a B3.2e decide
  quando republicar e o limite de `claim_count` antes de falhar de vez.
- **Estado do canal × tipo de evento (B3.2d-2).** O claim só informa o
  estado atual do canal.
- **Roteamento (B3.2d-2).** Continua o requisito do §18.8: conferir a
  routing key normalizada contra a do canal (`routing_mismatch`).
- **Inngest.** Não existe rota, função nem signing key, e nenhum evento
  real é consumido. O contrato pronto para o consumidor é
  `claimWhatsAppInboxEntry({ inboxId })` seguido de complete, fail ou
  release.
- **Migration não aplicada no hospedado.** Quando for aplicada, a
  revogação da tabela para `service_role` não quebra código: nenhum
  arquivo acessa a tabela diretamente, como o teste estático confere.
- **Nada configurado fora do código:**
  - nenhuma migration aplicada no Supabase hospedado;
  - nenhuma variável na Vercel;
  - nenhum app ou função registrado no Inngest;
  - nada na YCloud ou na Meta;
  - nenhuma mensagem enviada;
  - nenhuma mudança no chatbot;
  - nenhum lead, contato, conversa ou atividade criado.

## 20. B3.2d-2a — consumidor da inbox e app próprio do Inngest (27/10/2026)

Esta etapa implementa só o consumidor e a orquestração segura da inbox.
**Nada é escrito no domínio**: nenhum contato, lead, oportunidade,
atividade, conversa, mensagem ou status da A7 é criado ou alterado.

### 20.1 Divisão da B3.2d-2

A B3.2d-2 foi dividida para não misturar execução distribuída com a
evolução do domínio:

| Etapa | Conteúdo |
|---|---|
| **B3.2d-2a** (esta) | Rota e app próprios do Inngest, função do consumidor, validação estrita do evento interno, ciclo inteiro num único `step.run`, normalização pelo adaptador do provedor do canal, roteamento, matriz do estado do canal, classificação das falhas e finalização sem efeito (`ignored`/`unsupported`) |
| **B3.2d-2b** | Evolução do domínio reaproveitando a A7 (§20.9) |

Motivos da divisão:
- conversas da A7 exigem telefone, mas a B3 aceita identidade só por
  BSUID;
- mensagens da A7 pressupõem texto, e a B3 precisa aceitar mensagens sem
  texto;
- origem, classificação do remetente, custo e o status `accepted` ainda
  precisam de modelagem;
- uma PR só misturaria execução distribuída com migração do domínio.

### 20.2 App, rota e chaves próprios

- **App** `praxis-crm-whatsapp`, **rota** `/api/inngest/whatsapp`, função
  `b3-whatsapp-inbox-consumer`. Nada da A11 (`/api/inngest`,
  `@/server/ingest/*`) nem da agenda (`/api/inngest/calendar`,
  `@/server/calendar/*`) é importado.
- **Assinatura** só com `WHATSAPP_INNGEST_SIGNING_KEY`. Na rotação, a
  reserva própria é `WHATSAPP_INNGEST_SIGNING_KEY_FALLBACK`.
- **Sem queda para as variáveis genéricas.** Sem as opções, o SDK do
  Inngest leria sozinho `INNGEST_SIGNING_KEY`,
  `INNGEST_SIGNING_KEY_FALLBACK` e `INNGEST_EVENT_KEY`, que são da A11 e
  da agenda. A chave reserva da A11 passaria a autenticar esta rota. Por
  isso a assinatura, a reserva e a chave de evento são sempre passadas
  explicitamente. A que não estiver configurada recebe um valor que
  nunca valida nada (aleatório, por processo) e nunca envia.
- **Falha fechada.** Em Preview e Production, sem
  `WHATSAPP_INNGEST_SIGNING_KEY` ou sem o ambiente assinado do WhatsApp
  (`WHATSAPP_ENV_SIGNING_KEY`), a rota responde `503 service_unavailable`
  antes do SDK. Nesses ambientes o modo de desenvolvimento nunca liga,
  mesmo com `INNGEST_DEV`. Fora da Vercel, sem a chave própria, só
  funciona no modo de desenvolvimento explícito.
- **Sem log.** O cliente usa um logger silencioso, inclusive para as
  mensagens internas do SDK.
- **Publicação.** O publicador da B3.2c continua igual: id do evento =
  `inboxId`, payload exatamente `{ inboxId }`, chave
  `WHATSAPP_INNGEST_EVENT_KEY`. O consumidor não publica eventos.
- **Nada configurado fora do código.** Nenhuma variável foi criada na
  Vercel e nenhum app foi registrado no Inngest. Production continua sem
  `WHATSAPP_*`, e a rota responde 503 lá.

### 20.3 Contrato do consumidor

**Evento aceito**, e só ele:

```ts
{ name: "praxis/whatsapp.inbox.received", data: { inboxId } }
```

- `inboxId` é UUID; `data` com qualquer campo a mais (workspace, canal,
  routing key, provedor, ambiente) é recusado;
- o `id` do evento, quando vier, tem de ser o próprio `inboxId`;
- evento inválido → `{ outcome: "invalid_event" }`, sem `step.run` e sem
  banco.

**Um único `step.run`** (`process-inbox-entry`) chama
`processWhatsAppInboxEntry({ inboxId })`, que faz o ciclo inteiro:

1. **claim** pelo `inboxId` (B3.2d-1). Ambiente, workspace, canal,
   estado do canal, provedor, routing key, hash e cifra saem do banco;
2. **decifração** com a AAD montada só com dados da linha, e **SHA-256**
   conferido em tempo constante (no claim);
3. **hash conferido de novo** no consumidor, sobre os bytes devolvidos
   (`bodySha256` no claim);
4. **adaptador do provedor GRAVADO no canal**
   (`resolveWhatsAppProvider({ channelProvider })`), nunca o do evento;
5. **envelope**: id e tipo do evento têm de ser os da linha;
6. **normalização**: exatamente um evento normalizado, com o mesmo id;
7. **roteamento**, **estado do canal** e **decisão por tipo** (§20.4);
8. **uma finalização**: `dispose`, `fail` ou `release`.

**O claim não atravessa o `step.run`.** O retorno do step é só
`{ outcome, code }`, dado puro e serializável. O objeto do claim:
- nunca é retornado, serializado, posto em fila ou levado a outra
  execução;
- nunca é reconstruído com dados do evento;
- tem identidade em memória (`WeakMap`, §19.6), e uma cópia não
  finaliza nada.

Uma nova tentativa do Inngest começa de novo pelo claim.

**Resultados do claim:**

| Claim | Consumidor |
|---|---|
| `claimed` | segue o ciclo |
| `busy` | encerra sem finalizar |
| `already_processed` | sucesso idempotente |
| `terminal_failed` | sucesso idempotente |
| `expired` | sucesso idempotente |
| `not_found` | resultado sanitizado, sem contexto |

**Resultados da finalização**: `completed` vira `processed`;
`released`, `failed` e `claim_lost` são repassados com o código. Depois
de `claim_lost` não há nenhuma repetição nem outra finalização.

### 20.4 Roteamento, estado do canal e decisão

**Roteamento.** Uma routing key presente no evento normalizado tem de ser
**exatamente igual** à do canal da linha; senão, falha terminal
`routing_mismatch`, sem nenhum efeito. A routing key recebida nunca serve
para procurar outro canal.

| Tipo normalizado | Routing key |
|---|---|
| `message.inbound`, `message.outbound_observed`, `message.status`, `contact.identity_changed` | obrigatória (o contrato do adaptador a declara); ausente ou vazia → `event_impossible` |
| `account` de escopo `phone_number` | obrigatória; ausente → `event_impossible` |
| `account` de escopo `business_account` (WABA) | pode vir sem; o canal é o da linha |
| `ignored`, `unsupported` | podem vir sem; o canal é o da linha |

Nenhuma routing key é inventada, e nenhuma identidade é extraída de campo
não documentado.

**Estado atual do canal** (depois do roteamento: falha terminal de
conteúdo prevalece):

| Estado | Ação |
|---|---|
| `active` | segue para a decisão por tipo |
| `paused` | release `channel_paused`; a entrada fica pendente |
| `disconnected` | release `channel_disconnected`; fica pendente |
| `disabled` | release `channel_disabled`; fica pendente |

Nesta etapa nenhuma entrada é descartada só porque o canal mudou de
estado depois do recebimento. A B3.2e decide quando republicar as
entradas preservadas.

**Decisão por tipo** (canal ativo):

| Tipo | Ação |
|---|---|
| `message.inbound`, `message.outbound_observed`, `message.status`, `contact.identity_changed`, `account` | release `domain_effect_not_implemented`; fica pendente para a B3.2d-2b |
| `ignored` (`history`, `group_message`, `non_whatsapp_product`) | dispose `ignored_<motivo>` |
| `unsupported` | dispose `unsupported_event` |
| tipo ou motivo desconhecido | fail `event_impossible` |

### 20.5 Classificação das falhas

| Falha | Tipo | Código |
|---|---|---|
| corpo cifrado inválido (AAD ou cifra) | terminal (fail) | `inbox_decrypt_failed` |
| hash divergente (no claim ou na reconferência) | terminal | `inbox_integrity_failed` |
| corpo que não é JSON, envelope ou payload inválido | terminal | `payload_invalid` |
| versão de envelope não suportada | terminal | `unsupported_version` |
| lote, zero ou mais de um evento normalizado | terminal | `event_count_invalid` |
| id ou tipo do evento diferente do gravado na linha | terminal | `event_mismatch` |
| routing key de outro canal | terminal | `routing_mismatch` |
| evento estruturalmente impossível | terminal | `event_impossible` |
| provedor do canal inconsistente com o adaptador | terminal | `provider_invalid` |
| chave da inbox ausente | recuperável (release) | `inbox_crypto_not_configured` |
| versão de chave desconhecida | recuperável | `inbox_key_version_unknown` |
| adaptador não habilitado ou sem normalização | recuperável | `provider_unavailable` |
| exceção dentro do adaptador ou da decisão | recuperável | `consumer_transient_error` |
| canal pausado, desconectado ou desativado | recuperável | `channel_paused`, `channel_disconnected`, `channel_disabled` |
| efeito no domínio ainda não implementado | recuperável | `domain_effect_not_implemented` |
| banco indisponível no claim ou na finalização | nova tentativa do Inngest (até 3) | `inbox_unavailable`, `inbox_finalize_unavailable` |

- Os dois primeiros e os dois de chave são finalizados pelo próprio claim
  (B3.2d-1); o consumidor só repassa o resultado.
- Uma exceção antes da finalização leva a exatamente um release
  `consumer_transient_error`.
- Uma exceção **na própria finalização** não leva a nenhuma outra: o
  Inngest tenta de novo pelo claim, e a lease vencida devolve a entrada.
- Nunca vão para o banco, o Inngest, a resposta HTTP ou o log: erro
  bruto, pilha, payload, telefone, BSUID, segredo, chave ou credencial. O
  erro de nova tentativa leva só o código, inclusive na pilha.

### 20.6 Finalização sem efeito no domínio (`dispose`)

Migration `20261027120000_b3_2d2a_inbox_dispose.sql` (nenhuma migration
mesclada foi editada):

```sql
public.whatsapp_inbox_dispose(p_inbox_id uuid, p_claim_token uuid, p_disposition text) returns jsonb
```

- **Coluna `disposition`**, com lista fechada: `ignored_history`,
  `ignored_group_message`, `ignored_non_whatsapp_product` e
  `unsupported_event`. Só existe em `processed`.
- **Imutável.** Um gatilho só deixa a disposição nascer na transição
  `processing → processed`; depois não troca nem some, nem por escrita
  direta (`inbox_disposition_immutable`).
- **Mesma finalização de complete, fail e release.**
  `private.whatsapp_inbox_finish` foi recriada (mesma assinatura) para
  gravar a disposição na transição `processed`, então valem as mesmas
  regras:
  - linha travada, e os terminais respondem primeiro;
  - token atual e lease vigente, decididos por um único
    `clock_timestamp()`;
  - lease vencida, token antigo, inventado, ausente ou de outra entrada
    (inclusive de outro workspace ou canal) → `claim_lost`, sem mudar
    nada;
  - outro ambiente ou inexistente → `not_found`;
  - repetir → `already_processed`, sem mudar a disposição nem o horário.
- **Sem conteúdo.** A disposição recusa texto (`invalid_disposition`) e
  não gera auditoria; nada do webhook sai da inbox.
- **Permissões.** EXECUTE só para `service_role`, SECURITY DEFINER,
  `search_path` travado. A tabela continua sem privilégio direto, nem
  para `service_role`.
- **O `complete` continua existindo**, sem disposição. Ele é o caminho
  da B3.2d-2b, depois do efeito no domínio.

### 20.7 Testes

Escritos antes da implementação, contra a main `10e617f`. O commit só de
testes é `c3ec505`; a implementação é `9c58326`.

**Vermelho contra a main**
- Unitários (local): 163 dos 168 novos falham. Os 5 que passam são
  invariantes que a main já cumpre:
  - nenhum arquivo da B3 importa a A11 ou a agenda;
  - nenhum lê as variáveis genéricas do Inngest;
  - nenhuma API antiga da inbox;
  - nenhum acesso direto à tabela;
  - o claim só na inbox.
- pgTAP, na PR temporária #98:
  - 34: 31 de 43 falham. Os 12 que passam valem sem a função:
    - sem privilégio direto na tabela;
    - ninguém além de `service_role` executa;
    - nenhuma auditoria;
    - o preparo e o `complete`, que já existiam;
    - as comparações de retrato, que sem a coluna comparam o mesmo erro.
  - 33: 2 de 99 (as listas exatas de colunas e de funções).
  - 31: 1 de 94 (a lista de colunas).
- Concorrência real (#98, com os passos anteriores sem interromper o
  job): o cenário 1 para em `estado da entrada 1:` vazio, porque a coluna
  `disposition` não existe.
- No CI, typecheck e build também falham contra a main, porque os testes
  importam módulos que ainda não existem.

**Correções nos testes depois do commit de testes**, cada uma em commit
próprio:
- `26a381d`: a conferência estática "o consumidor não escreve no
  domínio" usava `/\.from\(/` e acusaria o `Buffer.from(` da
  reconferência do hash. Passou a procurar `.from("<tabela>")`, que é o
  acesso a tabela que ela quer pegar.
- `8c657bd`: o caso "assinatura adulterada" trocava o primeiro dígito da
  assinatura por `0`; quando ele já era `0`, a assinatura continuava
  válida e o teste falhava ao acaso (1 em 16). Apareceu na rodada de
  mutações. Agora o último dígito é sempre trocado.

**Verde (`9c58326` em diante)**
- Unitários: suíte inteira 1949; os 168 novos passam. Typecheck e lint
  limpos.
- No CI: comparação de tipos limpa; pgTAP 34 (43), 33 (99) e 31 (94)
  passam; concorrência real da B3.2d-1 (4 cenários) e da B3.2d-2a (3
  cenários) passam; build e E2E (76) passam.

**Cobertura**

`tests/unit/b3-2d2a-consumidor-inbox.test.ts` (banco simulado,
adaptador simulado real):
- evento interno estrito: aceita só `{ name, data: { inboxId } }`; recusa
  workspace, canal, routing key, provedor ou ambiente no `data`, UUID
  inválido, outro nome, `id` diferente do `inboxId`;
- um único `step.run`, com claim e finalização dentro; retorno só
  `{ outcome, code }`, serializável e sem token, contexto, corpo ou
  identidade; contexto passado junto com o `inboxId` é ignorado;
- resultados do claim sem posse, sem finalização;
- caminho completo: mensagem e status liberados com
  `domain_effect_not_implemented`; não suportado finalizado com
  `unsupported_event`; `claim_lost` com uma única chamada;
- routing key de outro canal, payload inválido, versão não suportada,
  id ou tipo do evento diferente do da linha, provedor não habilitado, e
  o canal YCloud nunca recebe o simulador;
- matriz dos quatro estados do canal, e a falha terminal prevalecendo
  sobre o canal pausado;
- decisão por tipo, em tabela (22 casos), e com cada estado do canal;
- tabela de falhas terminais (12) e recuperáveis (5), com listas
  disjuntas;
- hash e AAD: `bodySha256` no claim; AAD de outro workspace, canal,
  ambiente ou evento → `inbox_decrypt_failed`; hash divergente; chave
  ausente; versão de chave desconhecida com o código próprio;
- idempotência e concorrência no servidor: duas entregas simultâneas (um
  claim, um busy), execução depois de processed, reclaim com token novo,
  ignorado repetido finalizado uma vez só;
- banco indisponível no claim e na finalização: erro só com código, sem
  segunda finalização;
- em seis cenários: só RPCs da inbox, nenhum acesso a tabela, nenhum
  cliente do domínio, nada no console, nada sensível nos argumentos ou
  no resultado;
- `disposeWhatsAppInboxClaim`: argumentos exatos, lista fechada, claim
  copiado, serializado ou montado à mão recusado.

`tests/unit/b3-2d2a-consumidor-falhas.test.ts` (módulo da inbox
isolado):
- o claim é pedido só com `{ inboxId }`;
- a finalização recebe o mesmo objeto do claim;
- reconferência do hash;
- exceção antes da finalização → um release; exceção na finalização →
  nenhuma outra; `claim_lost` encerra;
- erros do claim já finalizados pelo próprio claim → resultado
  sanitizado; os outros → nova tentativa só com código.

`tests/unit/b3-2d2a-rota-inngest-whatsapp.test.ts` (SDK real, sem
rede):
- 503 sanitizado em Preview e Production sem a chave própria (com as da
  A11 presentes), com a chave vazia, sem o ambiente assinado e fora da
  Vercel sem modo de desenvolvimento;
- GET assinado com a chave do WhatsApp → autenticado, app
  `praxis-crm-whatsapp`, uma função;
- sem assinatura, com a chave da A11, com a reserva da A11 ou com
  assinatura adulterada → 401; a reserva própria funciona; `INNGEST_DEV`
  hospedado não desliga a assinatura;
- o cliente nunca usa a assinatura, a reserva ou a chave de evento da
  A11; configuração da função;
- nada no console.

`tests/unit/b3-2d2a-estatico.test.ts`:
- nenhum arquivo da B3 importa a A11 ou a agenda ou lê as variáveis
  genéricas do Inngest;
- nenhuma API antiga da inbox; nenhum acesso direto à tabela;
- consumidor e rota sem `.from("<tabela>")`, sem cliente ou módulo do
  domínio, só RPCs `whatsapp_inbox_*`;
- um único `step.run`, que chama `processWhatsAppInboxEntry`; só a inbox
  e o consumidor tocam no claim; o resultado é só `{ outcome, code }`.

`supabase/tests/database/34_b3_2d2a_inbox_dispose.test.sql` (43):
- coluna, lista fechada, imutabilidade e tabela sem privilégio direto;
- argumentos exatos, SECURITY DEFINER, só `service_role`;
- token atual e lease vigente → `completed` com a disposição; repetir →
  `already_processed` sem mudar nada; nada mais finaliza depois;
- código bruto, fora da lista, vazio ou ausente recusado;
- `complete` continua sem disposição; nenhuma auditoria;
- token substituído, inventado, ausente ou de outra entrada (outro
  workspace e canal) → `claim_lost`, sem mudar nada;
- lease vencida e fronteira → `claim_lost`; só um novo claim devolve um
  dono;
- falha terminal, Preview × Production, entrada inexistente, sem
  ambiente assinado, `authenticated` e `anon`.

`scripts/b3-2d2a-inbox-dispose-concurrency-check.sh` (passo novo do CI):
1. **Dois consumidores** pela mesma entrada, atrás de uma transação que
   segura a linha: um claim e um busy.
2. **Duas finalizações com o mesmo token** ao mesmo tempo: a segunda
   espera a trava (cerca de 3,9 s no CI) e vê `already_processed`; a
   disposição e o horário são gravados uma vez.
3. **Lease vencida de verdade** (15 s), sem novo claim: o dispose
   original recebe `claim_lost` e nada muda; um consumidor novo reclama,
   o token original segue recusado, só o novo finaliza, e repetir não
   regrava a disposição.

O pgTAP 31 e o 33 só tiveram as listas exatas de colunas e de funções
atualizadas.

### 20.8 Mutações

Uma mutação por vez, desfeita depois de cada uma.

**Servidor** (local; 18 mutações, todas detectadas)

| Mutação | Detectada por |
|---|---|
| M1 claim fora do `step.run` | claim e finalização dentro do mesmo `step.run`; estático: um único `step.run` com `processWhatsAppInboxEntry` |
| M2 estado do canal vindo do chamador no lugar do banco | contexto passado junto com o `inboxId` é ignorado (canal pausado na linha) |
| M2b contexto do chamador repassado ao claim | o claim é pedido só com `{ inboxId }` |
| M3 `routing_mismatch` ignorado | 10 testes: routing de outro canal (caminho completo e tabela), caixa diferente, falha terminal prevalecendo |
| M4 canal pausado processado | matriz do canal (`paused`), decisão com cada estado, contexto ignorado |
| M5 canal desativado descartado | matriz do canal (`disabled`), decisão com cada estado |
| M6 complete depois da lease vencida | banco, D1 abaixo |
| M7 segunda finalização depois da finalização (inclusive depois de `claim_lost`) | 29 testes, entre eles "claim_lost: uma única chamada" e "nenhuma outra finalização" |
| M8 erro bruto como código do release | adaptador falhando por dentro → `consumer_transient_error` (3 testes) |
| M9 importação da A11 | estático: nenhum arquivo da B3 importa `@/server/ingest` |
| M10a chave de evento caindo para `INNGEST_EVENT_KEY` | estático: variáveis genéricas; cliente e configuração nunca usam as chaves da A11 |
| M10b reserva de assinatura omitida (SDK cai em `INNGEST_SIGNING_KEY_FALLBACK`) | GET assinado com a reserva da A11 → 401; reserva própria aceita; chaves do cliente |
| M10c modo de desenvolvimento não forçado em ambiente hospedado | `INNGEST_DEV` hospedado não desliga a assinatura |
| M11 evento interno com campos extras aceito | recusa de workspace, canal/routing key e provedor/ambiente no `data`; evento inválido sem `step.run` |
| M12 escrita em tabela da A7 (`.from("conversations")`) | estático: consumidor sem `.from("<tabela>")` nem cliente do domínio |
| M14 hash não conferido de novo | reconferência do hash (2 testes) |
| M15 estado do canal antes do roteamento | a falha terminal prevalece sobre o canal pausado |
| M16 adaptador escolhido sem olhar o provedor do canal | canal YCloud nunca recebe o simulador |
| M17 ignorado finalizado pelo `complete`, sem disposição | 16 testes: dispose com a disposição, mesmo objeto do claim, resultados repassados |

Na rodada da M9, um teste da rota também falhou por acaso. Era o teste
instável da assinatura adulterada, corrigido em `8c657bd`; a M9 é pega
pelo teste estático.

A M12 só é pega pelo teste estático: na execução, a escrita mutante é
disparada em segundo plano, e o teste termina antes de ela chegar ao
cliente simulado. A conferência estática é a barreira para esse caso.

**Banco** (PRs temporárias #100 a #102, sobre `8c657bd`, com o pgTAP sem
interromper o job)

| Mutação | Reprovada por |
|---|---|
| D1 (M6) finalização recriada sem conferir `lease_until` | pgTAP 33, seção 13: 14 de 99 (complete, fail e release com a lease vencida, fronteira e o reclaim seguinte); pgTAP 34: lease vencida, fronteira, nada muda e o reclaim seguinte (28–31). Concorrência da B3.2d-1, cenário 4: `o complete com a lease vencida deveria ser recusado, veio: completed` (o job para ali, antes da concorrência da B3.2d-2a) |
| D2 (M13) dispose gravando direto, sem conferir token nem lease | pgTAP 34: 13 testes, entre eles token substituído, inventado, ausente e de outra entrada (22–25), só o token atual (26), lease vencida e fronteira (28–31), Production × Preview (35, 37, 40) e sem `service_role` (43). Concorrência, cenário 3: `dispose com a lease vencida deveria ser recusado, veio: completed` |
| D3 sem o gatilho de imutabilidade | pgTAP 34: a disposição só nasce na transição (2) e é imutável (16). A concorrência passa, como esperado: ela não reescreve a disposição |

As PRs temporárias #98 e #100 a #102 foram fechadas, com as branches
apagadas.

### 20.9 Limitações e o que fica para a B3.2d-2b e a B3.2e

- **B3.2d-2b — evolução do domínio reaproveitando a A7** (dividida em 2b1, 2b2 e 2b3 no §21.1), sem tabelas
  paralelas de conversa ou mensagem:
  - identidade só por BSUID, sem telefone;
  - mensagens sem texto;
  - `origin` e `sender_classification` (§15.10);
  - identidades internas;
  - custo informado pelo provedor;
  - status `accepted`;
  - idempotência do efeito pelo id estável do evento, com a RPC do efeito
    conferindo `inboxId`, token e lease vigente no banco (portão do
    §19.9);
  - criação de lead só para `inbound` + `external`; nada para chatbot,
    eco, histórico, status, identidade interna ou evento técnico.
  - Nada disso existe ainda: `send_message`, o simulador e as regras de
    lead da A7 e as tabelas de conversa, contato, lead e atividade não
    foram tocados.
- **B3.2e — reconciliador.** As entradas liberadas (canal fora de
  `active`, efeito não implementado, chave ou adaptador indisponível) e
  as `processing` com lease vencida ficam pendentes, sem republicação.
  Republicação, espera entre tentativas e teto de `claim_count` são da
  B3.2e, que continua portão obrigatório antes de qualquer webhook real.
- **Uma entrega com claim perdido** (`claim_lost`) não é repetida pelo
  consumidor; a entrada volta a ser reclamável quando a lease vence.
- **Migration não aplicada no hospedado.**
- **Nada configurado fora do código:**
  - nenhuma migration aplicada no Supabase hospedado;
  - nenhuma variável na Vercel (Production continua sem `WHATSAPP_*`);
  - nenhum app ou função registrado no Inngest;
  - nada na YCloud, na Meta ou na Cloudflare;
  - nenhuma mensagem enviada;
  - nenhuma mudança no chatbot;
  - nenhum dado real tocado; nenhum lead, contato, conversa ou atividade
    criado.

## 21. B3.2d-2b1 — modelo do domínio do WhatsApp sobre a A7 (28/10/2026)

Esta etapa prepara o domínio existente da A7 para os eventos reais. Ela
entrega schema, restrições, backfill, RLS e permissões, tipos, o serviço
de administração das identidades internas e os contratos tipados que a
próxima etapa usará.

Ficam de fora:
- RPCs que apliquem mensagens reais ao domínio;
- criação automática de contato ou lead;
- processamento de status pela inbox;
- ligação do consumidor da B3.2d-2a ao domínio;
- publicação para C1, download de mídia, reconciliador, telas e envio.

### 21.1 Nova divisão da B3.2d-2b

| Etapa | Conteúdo |
|---|---|
| **B3.2d-2b1** (esta) | Modelo do domínio: identidades, mensagens, status, custo, identidades internas, ledger, backfill e contratos |
| **B3.2d-2b2** | RPCs atômicas dos efeitos (mensagem, eco, status, conta), com o ledger e o claim vigente na mesma transação |
| **B3.2d-2b3** | Ligação do consumidor da B3.2d-2a às RPCs da 2b2 |

**Sem sistemas duplicados.** A B3 evolui as tabelas da A7: nenhuma tabela
nova de conversas ou mensagens. O chatbot não foi lido, copiado nem
alterado; nada da fila, do D1 ou do webhook dele entrou no Praxis.

### 21.2 Identidades

**Decisão:** uma tabela própria, `whatsapp_identities`, com uma
identidade por canal. A conversa aponta para ela.

| Coluna | Conteúdo |
|---|---|
| `phone_e164` | telefone E.164, opcional |
| `bsuid_blind_index`, `bsuid_ciphertext`, `bsuid_key_version` | BSUID: só índice cego (32 bytes) e texto cifrado, os três juntos |
| `workspace_id`, `channel_id`, `environment`, `provider` | os do canal (conferidos por FK e gatilho); `environment` nulo só no canal legado da A7 |

- **Telefone, BSUID ou os dois; nunca nenhum.** Uma restrição recusa a
  identidade vazia.
- **Único por canal**, pelo telefone e pelo índice do BSUID. O mesmo
  telefone em outro canal é outra identidade.
- **Imutável.** Canal, ambiente, provedor, telefone e BSUID não mudam
  depois de gravados. Um identificador que faltava pode ser acrescentado,
  por exemplo o telefone de quem só tinha BSUID.
- **Nenhum telefone é fabricado a partir do BSUID**, nem quando ele
  parece um número; o formato de um identificador nunca diz quem enviou.

**PII.**
- O telefone fica em texto, como já está em `conversations.wa_id` e em
  `contact_phones` (A3/A7). É por ele que o contato é casado; cifrá-lo
  aqui quebraria esse casamento sem proteger nada novo.
- O BSUID é PII nova e segue o padrão aprovado na A3 para CPF/CNPJ:
  AES-256-GCM decifrado só no Node e índice cego HMAC-SHA256
  (`src/server/whatsapp/identity-crypto.ts`).
- **Chaves próprias:** `WHATSAPP_IDENTITY_KEY_VERSIONS` e
  `WHATSAPP_IDENTITY_ACTIVE_KEY_VERSION`, nunca as da inbox, das
  credenciais ou dos contatos. Cada chave gera, por HKDF, uma subchave de
  cifra e outra de índice.
- **Escopo** (ambiente, workspace e canal) no índice e na AAD: o mesmo
  BSUID em outro canal, workspace ou ambiente gera outro índice, e um
  texto cifrado não decifra fora do escopo dele.
- Nenhuma dessas variáveis foi configurada em ambiente nenhum.

**Conversas.**
- `identity_id` passa a ser obrigatório e único por conversa.
- `wa_id` passa a ser opcional, para conversa só com BSUID.
- Um gatilho dá à conversa que nasce pela A7 (só com `wa_id`) a
  identidade do telefone no canal dela, e recusa telefone que diverge da
  identidade, conversa sem identidade e identidade de outro canal.

### 21.3 Mensagens

Colunas novas em `messages`, todas compatíveis com as linhas antigas:
- `body_text` opcional;
- `content_kind` (lista do contrato do adaptador, padrão `text`);
- `origin` e `sender_classification`, separados e obrigatórios;
- `origin_correlation_kind`/`_ref`: prova positiva e confiável da
  origem (`crm_outbox` ou `chatbot_request`);
- `provider`, `provider_message_id` (único por canal) e
  `provider_external_id` (valor opaco);
- custo: `provider_cost_amount`, `_currency`, `_category`, `_finality`, e
  `provider_cost_billable_amount`, calculado só com o custo final.

**Origem × classificação**:

| `origin` | Direção | `sender_classification` permitidas |
|---|---|---|
| `inbound` | recebida | `external`, `internal`, `unresolved` |
| `crm` | enviada | `internal` (com autor e chave de envio), `automation` |
| `business_app` | enviada | `internal` |
| `chatbot` | enviada | `automation` — só com correlação `chatbot_request` |
| `external_api` | enviada | `unresolved`, `automation` |
| `history` | qualquer | qualquer |

- `internal` nunca é origem.
- Sem prova, a saída por API é `external_api` + `unresolved`.
- A mensagem do advogado pelo aplicativo é `business_app` + `internal`.
- O comando vindo do número pessoal interno é `inbound` + `internal`.
- **Nenhuma classificação sai do texto da mensagem** nem do formato do
  `externalId`. O contrato `classifyWhatsAppMessage` nem recebe o texto, e
  um teste estático confere o código dele.
- Lead só para `inbound` + `external` (`whatsappMayCreateLead` e
  `private.whatsapp_may_create_lead`). Identidade interna, automação, eco,
  histórico e API sem prova nunca criam lead.

**Conteúdo.** Texto exige corpo; mídia aceita legenda ou nenhum texto.

**Compatibilidade com a A7.**
- As regras antigas "toda saída tem autor e chave de reenvio" viraram
  regras da origem `crm`: eco, chatbot e API não têm autor do CRM.
- Um gatilho classifica a mensagem que chega pela A7 pelo CAMINHO de
  inserção: recebida do simulador → `inbound`/`unresolved`; enviada por
  usuário do CRM → `crm`/`internal`. Qualquer outro caminho precisa
  informar as duas colunas.
- A classificação `unresolved` das recebidas da A7 não muda o simulador:
  ele continua criando contato e lead como antes. A regra de lead da B3
  vale para o caminho real (B3.2d-2b2).

### 21.4 Status e custo

- **`accepted`** entra no enum antes de `sent`, em migration própria (o
  Postgres não deixa usar o valor novo na mesma transação).
- **A regra da A7 não muda:** no rank dela, `accepted` fica no nível de
  `queued`, e `apply_message_status_event` é a mesma.
- **A regra da B3** fica em `private.whatsapp_message_status_should_apply`,
  igual à projeção da B3.2a:
  - avança em accepted → sent → delivered → read;
  - `failed` a partir de qualquer status antes da entrega;
  - `delivered` e `read` corrigem `failed`;
  - nada regride, e `accepted`/`sent` depois de `failed` não apagam o
    `failed`.
- **Custo:**
  - um gatilho impede que o custo final seja substituído, nem por
    estimativa nem por outro valor;
  - mensagem `failed` nunca tem custo final;
  - só o custo final entra em `provider_cost_billable_amount`;
  - a categoria é aberta e bem formada (`^[a-z][a-z0-9_]{0,63}$`), então
    uma categoria futura é preservada;
  - nenhuma tarifa da Meta ou da YCloud está no código ou no banco.

### 21.5 Identidades internas

`whatsapp_internal_identities`: números e BSUIDs do próprio escritório.

- Ligada a workspace, ambiente e canal (FK para a identidade do canal),
  com telefone e/ou BSUID (índice cego e cifra), `is_active` e datas.
- **Só owner e admin administram**, por três RPCs de `service_role` com
  ambiente autenticado. Manager e members recebem
  `insufficient_permission`.
  - `whatsapp_list_internal_identities`;
  - `whatsapp_create_internal_identity`;
  - `whatsapp_set_internal_identity_active`.
- Canal de outro workspace, de outro ambiente ou legado → `channel_not_found`.
- A listagem nunca devolve índice cego, cifra ou versão de chave.
- A auditoria leva só ambiente, provedor, canal e se há telefone/BSUID.
- Serviço no servidor sem tela:
  `src/modules/whatsapp-channels/internal-identities.ts`. Ele exige
  `channel.manage` da sessão e entrada estrita; o BSUID é cifrado antes de
  ir ao banco.
- `private.whatsapp_is_internal_identity` faz o casamento para a
  B3.2d-2b2: só identidade ativa, do mesmo canal.
- Uma identidade interna nunca cria lead.
- Nenhuma identidade real foi cadastrada.

### 21.6 Ledger técnico de efeitos

`whatsapp_effect_ledger`: um efeito por **(ambiente, canal, provedor, id
estável do evento)**.
- Não é uma segunda tabela de mensagens. Guarda só a chave, o efeito
  declarado (lista fechada), o `inbox_id` e o `message_id`.
- **Nenhuma coluna de corpo, telefone, BSUID, mídia ou payload**, e o id
  do evento tem formato restrito (um telefone com `+` é recusado).
- O ambiente, o workspace e o provedor têm de ser os do canal (FK
  composta): nenhum efeito cruza canal, workspace ou ambiente.
- **Todo efeito tem uma inbox** (`inbox_id NOT NULL`), e ela é a do
  mesmo evento. FK composta
  `(inbox_id, workspace_id, channel_id, environment, provider, provider_event_id)`
  → `whatsapp_webhook_inbox (id, workspace_id, channel_id, environment, provider, provider_event_id)`,
  sobre uma unicidade nova da inbox com essas seis colunas.
  - Sem ação na remoção (`NO ACTION`): a inbox de um efeito não pode ser
    apagada. O expurgo já preserva a inbox como tombstone; a cascata do
    workspace apaga os dois no mesmo comando.
- **A mensagem, quando há, é do mesmo workspace e do mesmo canal.** FK
  composta `(message_id, workspace_id, channel_id)` →
  `messages (id, workspace_id, channel_id)`, sobre uma unicidade nova de
  `messages`. Se a mensagem for removida, só `message_id` zera
  (`ON DELETE SET NULL (message_id)`); workspace, canal, inbox e evento
  ficam. `message_id` é nulo para efeitos que não produzem mensagem
  (conta, identidade, evento técnico).
- Só `private.whatsapp_effect_ledger_reserve(p_inbox_id, p_effect)`
  grava. O chamador informa só a entrada e o efeito; ambiente,
  workspace, canal, provedor e `provider_event_id` vêm da linha da inbox,
  buscada no **ambiente autenticado** pelo cabeçalho assinado. Devolve
  `(outcome, ledger_id)`:

  | `outcome` | Quando | `ledger_id` |
  |---|---|---|
  | `reserved` | primeira vez | a linha nova |
  | `duplicate` | a mesma inbox já reservou o mesmo efeito | a linha existente |
  | `conflict` | a chave já foi reservada com outro efeito ou por outra inbox | nulo |

  - `conflict` é integridade quebrada, nunca duplicação silenciosa.
  - Inbox inexistente, nula ou de outro ambiente: `ledger_inbox_not_found`.
    Sem ambiente autenticado: `whatsapp_environment_required`.
  - Na B3.2d-2b2, a RPC do efeito trava a inbox, confere token e lease
    vigente e chama a reserva na mesma transação; se algo falhar depois,
    a reserva é desfeita junto.
  - Ninguém, nem `service_role`, alcança a tabela ou a função
    diretamente.

### 21.7 Migrations e backfill

- `20261028120000_b3_2d2b1_message_status_accepted.sql`: o valor
  `accepted`.
- `20261028120100_b3_2d2b1_whatsapp_domain_model.sql`: o resto. Nenhuma
  migration mesclada foi editada.

**Backfill** (`private.whatsapp_domain_backfill`, chamado na migration):
1. uma identidade por (canal, telefone) já usado numa conversa, com o
   ambiente e o provedor do canal;
2. cada conversa aponta para a identidade do próprio telefone;
3. recebidas → `inbound`/`unresolved`; enviadas (sempre por usuário do
   CRM na A7) → `crm`/`internal`; todas `text`.

- É **determinístico** e **idempotente**: rodar de novo devolve zero em
  tudo.
- Não muda o `updated_at` das linhas antigas.
- Nenhuma linha vira `chatbot` e nada é classificado pelo texto.
- O backfill **cria identidades técnicas** em `whatsapp_identities`. Não
  cria nem apaga contatos, leads, oportunidades, atividades, conversas ou
  mensagens, e não altera o conteúdo nem as datas de atualização desses
  registros.
- As restrições novas recusariam um backfill que marcasse mensagem
  antiga como chatbot.

**Reversão:** apagar as três tabelas e as colunas novas, e voltar `wa_id`,
`body_text` e `wa_message_id` a `NOT NULL`. Toda linha antiga ainda tem os
três.

### 21.8 Compatibilidade com a A7

- As funções da A7 não foram alteradas: simulador, envio, status,
  vínculo, leituras e paginação.
- O pgTAP 12 (A7) e o 14 (A9) continuam passando.
- O E2E das conversas continua passando sem mudança visível. A
  interface ganhou só o rótulo "Aceita" para o status novo, que nenhuma
  mensagem antiga tem.
- **Teste de atualização** (`scripts/check-upgrade-b3-2d2b1-dominio.sh`,
  passo novo do CI):
  1. usa a A7 na versão anterior: duas conversas, três mensagens
     recebidas, consentimento, envio e status;
  2. aplica a migration;
  3. confere que as leituras da A7 devolvem exatamente o mesmo de antes;
  4. confere que nenhum contato, lead, oportunidade, atividade, conversa,
     mensagem ou evento de status foi criado ou apagado;
  5. confere as identidades e a classificação, sem chatbot;
  6. confere que o backfill de novo não muda nada;
  7. confere que o simulador e o envio continuam funcionando depois.

### 21.9 Testes

Escritos antes da implementação, contra a main `6633084`. O commit só de
testes é `ec66c8c`; a implementação é `b0457df`.

**Vermelho contra a main**
- Unitários (local): 143 dos 144 falham. O que passa é a matriz de papéis
  (`channel.manage` só para owner e admin), que já existe.
- pgTAP 35, na PR temporária #103: 75 de 82 falham. Os 7 que passam já
  valem na main: as leituras da A7 (status, listas, paginação e
  detalhe), a auditoria sem PII e "só o simulador criou contato e lead".
- Teste de atualização (#103): as leituras da A7 batem, e ele falha em
  seguida, porque `whatsapp_identities` não existe.

**Correções nos testes**, cada uma em commit próprio:
- `0d65105`: dois defeitos meus apareceram no vermelho.
  - o pgTAP 35 comparava dois literais sem tipo
    (`is(:'st_env1', 'delivered')`) e abortava o arquivo depois da 13ª
    asserção;
  - o teste de atualização lia o retrato como `authenticated`, que não
    tem acesso a ele.
  - O vermelho foi refeito com as correções.
- `99d26d3`: a mutação T19 sobreviveu (abaixo). Entraram dois testes: a
  mensagem do produto para um código conhecido e o `unknown` sem valor na
  camada do servidor.
- `465c946`:
  - o pgTAP 29 (B3.1) conta as funções `whatsapp_*` de `service_role` e
    esperava 10; as três de identidade interna têm teste próprio e
    ficaram de fora, como as da inbox;
  - um teste do 35 presumia a ordem de duas mensagens gravadas na mesma
    transação, que é a do id aleatório (instável).

**Correção na implementação durante o verde** (`750c251`): a restrição dos
ids do provedor usava `\S{1,256}`, acima do limite de repetição das
expressões regulares do Postgres (255). Todo INSERT de mensagem com id do
provedor falhava com `2201B`, e por isso 13 asserções do pgTAP 35 caíram
no primeiro CI. Corrigida na própria migration, que não foi mesclada. A
primeira rodada de mutações do banco (#105 a #114) usava essa base com
defeito, foi fechada e refeita sobre a base corrigida.

**Verde**
- Unitários: suíte inteira 2098; os 146 da etapa passam. Typecheck e lint
  limpos.
- No CI (`465c946`): comparação de tipos limpa; pgTAP inteiro, com o 35
  (82), o 12 (A7), o 14 (A9) e o 29 a 34 da B3; concorrência real;
  teste de atualização; build e E2E (76).

**Cobertura**

`tests/unit/b3-2d2b1-modelo-dominio.test.ts`:
- valores de `origin` e `sender_classification`;
- matriz de combinações (6 × 4) e direção de cada origem;
- classificação por caminho: 11 casos;
- `externalId` com cara de chatbot sem correlação continua
  `external_api` + `unresolved`;
- correlação malformada não prova nada;
- o texto nunca muda o resultado (com teste estático);
- lead só para `inbound` + `external`;
- identidade: telefone, BSUID, os dois; BSUID com cara de telefone
  continua BSUID; nove formas de identidade inválida;
- conteúdo: texto, mídia sem texto, legenda, tipo desconhecido e texto
  longo;
- status: 15 transições, com `accepted` e as correções depois de
  `failed`;
- custo: estimado × final, total cobrado, `failed` estimado, categoria
  futura, valores inválidos; nenhuma tarifa fixa (estático);
- chave do ledger: só os quatro campos, sete chaves inválidas.

`tests/unit/b3-2d2b1-identidade-cifra.test.ts`:
- índice determinístico de 32 bytes, diferente por canal, workspace,
  ambiente e canal legado;
- não é hash simples nem HMAC com a chave crua;
- cifra com IV aleatório e sem o BSUID; decifra só no próprio escopo;
- busca em todas as versões de chave, gravação na ativa; versão
  desconhecida recusada;
- BSUID e escopo inválidos recusados;
- não cai nas chaves da inbox, das credenciais ou dos contatos
  (estático); nenhum erro com o BSUID ou a chave.

`tests/unit/b3-2d2b1-identidades-internas.test.ts`:
- `channel.manage` só para owner e admin, e a recusa da sessão não chega
  ao banco;
- telefone, BSUID ou os dois; o BSUID vai só como índice e cifra do
  escopo do canal;
- nove entradas inválidas recusadas antes do banco, inclusive workspace,
  ator ou ambiente no formulário;
- sem as chaves de identidade ou sem o ambiente do WhatsApp: recusa;
- listagem segura (resposta com índice ou cifra é recusada);
- ativação;
- erros sanitizados: mensagem do produto, `unknown` sem valor, nada
  sensível no console.

`supabase/tests/database/35_b3_2d2b1_modelo_dominio.test.sql` (82):
- estrutura:
  - enums;
  - colunas exatas das três tabelas novas, inclusive o ledger sem coluna
    de conteúdo;
  - o índice único do ledger;
  - nulidade das colunas de conversas e mensagens;
  - nenhum acesso direto;
  - RLS;
  - RPCs só de `service_role` e funções privadas sem EXECUTE;
- A7 igual: status, `list_conversations`, `list_conversation_messages`
  (com paginação), `get_conversation`, identidade e classificação
  automáticas;
- identidades:
  - telefone, BSUID, os dois e vazia;
  - BSUID incompleto e telefone fora do E.164;
  - unicidade;
  - ambiente, workspace e provedor diferentes do canal;
  - imutabilidade e acréscimo;
  - conversa só com BSUID e conversa incoerente;
- mensagens: mídia sem texto, legenda, texto sem corpo, matriz de origem
  (aceitas e proibidas), chatbot só com correlação, sem id do provedor,
  unicidade;
- custo: estimado, final, final imutável, `failed` estimado, categoria,
  moeda, valor e total cobrado;
- status: as transições da regra da B3, o rank da A7 e a regra de lead;
- identidades internas:
  - owner e admin criam; manager, lawyer e viewer não;
  - outro workspace, ambiente ou canal legado não alcançam;
  - entradas inválidas e duplicadas;
  - listagem sem índice nem cifra;
  - desativação;
  - casamento interno;
  - auditoria sem valores;
  - `authenticated` sem acesso;
- ledger (ampliado no §21.13): FKs da inbox e da mensagem, remoções,
  reserva com `reserved`, `duplicate` e `conflict`, outro ambiente
  autenticado, reserva desfeita, evento malformado (inclusive um
  telefone); `service_role` sem acesso;
- backfill idempotente, nenhum chatbot; nenhum contato ou lead além do
  que o simulador da A7 sempre cria.

O teste de atualização está no §21.8. O pgTAP 12 (A7), o 14 (A9) e o E2E
continuam passando.

### 21.10 Mutações

**Servidor** (local, uma por vez; 20 mutações (T1 a T19 e T19b), todas detectadas)

| Mutação | Detectada por |
|---|---|
| T1 BSUID tratado como telefone | BSUID com cara de telefone continua BSUID (3 testes) |
| T2 identidade vazia aceita | identidades inválidas e entradas vazias do serviço (10) |
| T3 serviço pedindo outra permissão (manager/member passariam) | toda operação pede `channel.manage` |
| T4 workspace, ator ou ambiente aceitos do formulário | os três recusados antes do banco |
| T5 origem inferida pelo texto | o texto nunca muda a classificação; estático da classificação |
| T6 `external_api` vira chatbot pelo formato do externalId | os quatro externalId com cara de chatbot |
| T7 mensagem sem texto recusada | mídia sem texto aceita (10) |
| T8 `accepted` descartado | null → accepted aplica |
| T9 `failed` impedindo delivered | delivered/read corrigem failed (inclusive na projeção da B3.2a) |
| T10 custo estimado sobrescrevendo final | estimado nunca substitui o final |
| T11 custo de failed continua final | custo de failed permanece estimado |
| T12 total cobrado com estimativa | só o final entra no total |
| T13 chave do ledger sem ambiente | só os quatro campos da chave |
| T14 chave do ledger carregando conteúdo | só os quatro campos da chave |
| T15 lead para inbound sem prova | lead só para inbound + external |
| T16 BSUID em claro para o banco | o BSUID vai só como índice e cifra |
| T17 índice sem o canal no escopo | outro canal gera outro índice; AAD |
| T18 identidade caindo na chave da inbox | só as chaves da inbox: not_configured; estático |
| T19 resposta com o erro em vez da mensagem do produto | **sobreviveu** na primeira rodada; pega pelos testes de `99d26d3` |
| T19b servidor repassando a mensagem crua do banco | `unknown` sem valor na camada do servidor (`99d26d3`) |

A T19 não vazava nada (a camada do servidor já reduzia o erro a um
código), mas nenhum teste conferia a mensagem que a pessoa vê.

**Banco** (PRs temporárias #115 a #124, sobre `465c946`; os passos de
tipos, pgTAP, build e E2E só marcam a falha, para o teste de atualização
também rodar)

| Mutação | Reprovada por |
|---|---|
| D1 identidade vazia aceita | pgTAP 35: identidade vazia recusada (24) |
| D2 manager administrando identidade interna | pgTAP 35: manager não lista, não desativa; casamento e auditoria mudam (65, 67, 68, 70) |
| D3 outro workspace lendo identidade interna | pgTAP 35: o owner de outro workspace não alcança o canal (65) |
| D4 mensagem sem texto recusada | pgTAP 35: mídia sem texto aceita (35) e o que dependia dela (44) |
| D5 `accepted` descartado | pgTAP 35: accepted → sent → delivered → read (52) |
| D6 `failed` impedindo delivered | pgTAP 35: delivered e read corrigem failed (53) |
| D7 custo estimado sobrescrevendo o final | pgTAP 35: custo final nunca substituído (48) e total cobrado (51) |
| D8 ledger sem ambiente na chave | pgTAP 35: índice único por ambiente, canal, provedor e evento (7) |
| D9 ledger guardando conteúdo | pgTAP 35: colunas exatas do ledger (6); comparação de tipos |
| D10 backfill classificando mensagem antiga como chatbot | Teste de atualização: a migration é recusada sobre os dados antigos da A7 (`messages_sent_by_only_crm`). O pgTAP passa, como esperado: o banco do zero não tem mensagem antiga |

As PRs temporárias #103 e #105 a #124 foram fechadas, com as branches
apagadas (#105 a #114 eram a primeira rodada, sobre a base com a regex
inválida).

### 21.11 Revisão manual de segurança

Feita explicitamente, porque o plugin security-guidance não foi instalado
no Windows.

| Item | Resultado |
|---|---|
| RLS e GRANTs | As três tabelas novas: RLS ligada e forçada, políticas de recusa, nenhum privilégio para `anon`, `authenticated` ou `service_role` (os padrões do Supabase foram revogados explicitamente). Conversas e mensagens continuam sem acesso direto |
| SECURITY DEFINER | Só as três RPCs de identidade interna; elas revalidam papel, workspace, ambiente e canal por dentro |
| `search_path` | Vazio nas 15 funções novas, com nomes totalmente qualificados |
| Enumerações e checks | Origem e classificação em enum; conteúdo, correlação, custo, ids e efeito em listas ou regex fechadas |
| PII em texto puro | Só o telefone, como já existia na A3/A7. O BSUID só com índice cego e cifra; nenhum telefone ou BSUID em auditoria, listagem segura, ledger ou erro |
| Índices cegos | HMAC com subchave própria (HKDF) e escopo de ambiente, workspace e canal; sem correlação entre canais |
| Colisão entre ambientes | Ledger único por ambiente + canal + provedor + evento, com FK para o canal; identidades únicas por canal |
| Integridade do ledger | Todo efeito preso, pelo banco, à inbox do mesmo evento (seis colunas) e à mensagem do mesmo canal; a reserva não aceita contexto do chamador e separa duplicação de conflito (§21.13) |
| Enumeração de identidades | Só owner/admin do workspace, no ambiente e canal certos, listam. Outro workspace, ambiente ou canal legado respondem `channel_not_found` sem distinguir. O casamento interno é função privada |
| Erros sanitizados | O banco levanta só códigos fixos (violação de unicidade ou check vira código). O servidor reduz mensagem crua a `unknown`, e o serviço devolve só a mensagem do produto |
| `service_role` | Executa só as três RPCs; não lê tabela nem função privada |
| Logs e auditoria | Log só com o código e o workspace; auditoria sem valores |
| Backfill | Determinístico, idempotente, sem mudar `updated_at`, reversível |

**Riscos que ficam documentados:**
- O telefone em texto segue o padrão atual do CRM.
- A rotação da chave do BSUID vai exigir uma função própria, porque
  índice e cifra são imutáveis.
- A listagem de identidades internas mostra o telefone a owner e admin,
  de propósito.

### 21.12 Limitações e próximas etapas

- **B3.2d-2b2:**
  - RPCs que aplicam mensagem, eco, status e eventos de conta, com o
    ledger e a conferência do claim vigente (`inboxId`, token, lease) na
    mesma transação;
  - classificação pelo casamento com as identidades internas;
  - criação de contato e lead só para `inbound` + `external`;
  - status pela regra da B3;
  - custo pelo gatilho desta etapa.
- **B3.2d-2b3:** o consumidor troca o release
  `domain_effect_not_implemented` pelas RPCs da 2b2.
- **B3.2e:** reconciliador, portão antes de qualquer webhook real.
- **A interface ainda presume telefone** (`waId`). Conversa só com BSUID
  só passa a existir na 2b2, que precisa cuidar da exibição.
- **Nada configurado fora do código:**
  - nenhuma migration aplicada no Supabase hospedado;
  - nenhuma variável na Vercel (inclusive `WHATSAPP_IDENTITY_*`);
  - nada no Inngest, na YCloud, na Meta ou na Cloudflare;
  - nenhuma mensagem enviada;
  - nenhuma mudança no chatbot;
  - nenhum dado real; nenhuma identidade real cadastrada.

### 21.13 Correção: integridade referencial do ledger (antes do merge)

**Problema** (na revisão de `866afd9`, sem exploração externa possível,
porque a reserva é privada e o consumidor não a chama):
- `inbox_id` aceitava `NULL`, e a FK conferia só o id da inbox: nada
  garantia que inbox, workspace, canal, ambiente, provedor e
  `provider_event_id` fossem do mesmo evento;
- `message_id` conferia só o workspace: podia apontar para uma mensagem
  de outro canal do mesmo workspace;
- a reserva recebia do chamador os cinco campos que já estão na linha
  confiável da inbox, e tratava outro efeito na mesma chave como
  duplicação.

Exatamente a garantia de que a B3.2d-2b2 depende para os efeitos
atômicos. Corrigido na própria migration
`20261028120100_b3_2d2b1_whatsapp_domain_model.sql`, ainda não mesclada
nem aplicada; nenhuma migration corretiva, nenhuma migration da main
editada. O estado final está no §21.6.

**Testes primeiro.** Commit só de testes `9c63e8f`, sobre `866afd9`.
Vermelho na PR temporária #125:
- pgTAP 35: 20 de 101 falham. Nos casos de FK, o banco aceitava a
  gravação (`have: ok`): ledger sem inbox; inbox de outro workspace,
  canal, ambiente ou provedor; inbox com outro `provider_event_id`;
  mensagem de outro canal do mesmo workspace; remoção da inbox de um
  efeito. As reservas falham porque a assinatura nova não existe.
- O teste de concorrência do ledger falha.
- Passam já na base, como esperado: mensagem de outro workspace
  recusada, os casos positivos (inbox do mesmo contexto, mensagem do
  mesmo canal, efeito sem mensagem), o formato do evento, mensagem
  removida zerando só `message_id` e `service_role` sem acesso.

Correção em `209f882`; tipos regenerados para o ledger.

**FKs finais:**

| FK | Colunas | Referência | Na remoção |
|---|---|---|---|
| `whatsapp_effect_ledger_inbox_fkey` | `inbox_id, workspace_id, channel_id, environment, provider, provider_event_id` | `whatsapp_webhook_inbox (id, workspace_id, channel_id, environment, provider, provider_event_id)` | `NO ACTION`: a inbox de um efeito não sai |
| `whatsapp_effect_ledger_message_fkey` | `message_id, workspace_id, channel_id` | `messages (id, workspace_id, channel_id)` | `SET NULL (message_id)` |
| `whatsapp_effect_ledger_channel_identity_fkey` (já existia) | `workspace_id, channel_id, environment, provider` | `whatsapp_channels` | `RESTRICT` |

Alvos novos: `whatsapp_webhook_inbox_effect_ref_key` e
`messages_id_workspace_channel_key`, unicidades que só repetem o id com o
contexto.

**Reserva:** `private.whatsapp_effect_ledger_reserve(p_inbox_id uuid,
p_effect text, out outcome text, out ledger_id uuid)`. Resultados no
§21.6. A colisão de inbox (mesma chave, outra inbox) já é impedida pelo
banco, porque a inbox é única por canal e evento. O pgTAP exercita a
defesa da função removendo essa unicidade só dentro da transação do
teste.

**Cobertura nova** (pgTAP 35, seção 8, 27 asserções):
- FK da inbox: sem inbox; outro workspace, canal, ambiente, provedor ou
  evento; o mesmo contexto aceito;
- FK da mensagem: outro canal do mesmo workspace e outro workspace
  recusados; mesmo canal aceito; efeito sem mensagem;
- remoções: mensagem zera só `message_id`; inbox recusada;
- reserva: contexto copiado da inbox; `duplicate` com o mesmo id;
  `conflict` por efeito e por inbox; outro canal ou workspace não
  colide; inbox de outro ambiente, inexistente ou nula; autenticado em
  Production; sem ambiente; efeito fora da lista; falha depois da
  reserva desfaz a reserva;
- ledger sem conteúdo (colunas exatas, evento com cara de telefone
  recusado); nenhuma permissão direta, nem para `service_role`.

**Concorrência real** (`scripts/b3-2d2b1-ledger-concurrency-check.sh`,
passo novo do CI):
1. duas reservas do mesmo evento: `reserved` e, depois de esperar a
   primeira, `duplicate` com o mesmo id; uma linha;
2. a primeira reserva é desfeita por uma falha depois dela: a segunda,
   que esperava, `reserved`; uma linha;
3. o mesmo evento com outro efeito: a segunda espera e vê `conflict`;
   fica só o efeito da primeira.

**Mutações** (uma por PR temporária, sobre `209f882`):

| Mutação | PR | Detectada por |
|---|---|---|
| L1 `inbox_id` volta a aceitar `NULL` | #126 | pgTAP 35: ledger sem inbox (72); comparação de tipos |
| L2 FK da inbox confere só o id | #127 | pgTAP 35: outro workspace, canal, ambiente, provedor e evento (73 a 77) e FKs compostas (86); tipos |
| L3 `provider_event_id` fora da relação | #128 | pgTAP 35: outro `provider_event_id` (77) e FKs compostas (86); tipos |
| L4 `message_id` confere só o workspace | #129 | pgTAP 35: mensagem de outro canal (78) e FKs compostas (86); tipos |
| L5 reserva confia no ambiente da sessão, não no da inbox | #130 | pgTAP 35: inbox de outro ambiente (91) e autenticado em Production (92) |
| L6 outro efeito na mesma chave vira `duplicate` | #131 | pgTAP 35: conflict por efeito (89); concorrência, cenário 3 |
| L7 outra inbox na mesma chave vira `duplicate` | #132 | pgTAP 35: conflict por inbox (97) |
| L8 ledger guardando telefone (coluna nova) | #133 | pgTAP 35: colunas exatas do ledger (6); tipos |
| L9 id de evento do ledger aceita telefone | #134 | pgTAP 35: evento com cara de telefone (82) |

Todas reprovadas; o código foi restaurado (cada mutação viveu só na
própria branch, já apagada).

**Verificação final** (CI de `209f882`, repetida no HEAD com este
documento): typecheck, lint e unitários (2098); migrations do zero;
comparação de tipos; pgTAP inteiro (35 com 101); isolamento entre
workspaces; concorrência (A7, B2, B3.2d-1, B3.2d-2a e o ledger); os
dois testes de atualização; build; E2E (76); Vercel.

## 22. B3.2d-2b2a — efeito atômico de mensagem recebida (29/10/2026)

A B3.2d-2b2 foi dividida: esta etapa (**2b2a**) implementa só o efeito de
mensagem **recebida**. Eco, status, identidade alterada, eventos de conta,
mídia e saída humana ficam para a **2b2b**; a ligação do consumidor da
B3.2d-2a, para a **2b3**. O consumidor ainda não chama este efeito.

### 22.1 Contrato da RPC

`public.whatsapp_effect_inbound_message(p_inbox_id, p_claim_token,
p_provider_message_id, p_content_kind, p_body_text, p_occurred_at,
p_phone_e164, p_bsuid_lookup, p_bsuid_ciphertext, p_bsuid_key_version,
p_profile_name) → jsonb`. SECURITY DEFINER, `search_path` vazio, EXECUTE
só para `service_role`.

- **Nenhum contexto do chamador:** workspace, canal, ambiente, provedor e id
  do evento vêm da linha da inbox, buscada no ambiente autenticado pelo
  cabeçalho assinado. A assinatura não tem esses parâmetros.
- **BSUID:** `p_bsuid_lookup` é `{versão: índice cego}` para todas as
  versões de chave conhecidas (acha a identidade gravada numa versão
  anterior); a cifra e o índice gravados são os da versão ativa. Tudo
  calculado no servidor (`applyWhatsAppInboundMessage`), no escopo do
  claim. O banco nunca vê o BSUID em claro.
- **Entrada malformada** (tipo, texto, id do provedor, telefone, índices,
  cifra, nome com mais de 160 caracteres, nenhum identificador):
  `invalid_inbound_message`, antes de qualquer trava ou escrita.

| Resultado | Quando | Efeito |
|---|---|---|
| `applied` | aplicado | tudo gravado; inbox `processed` |
| `duplicate` | o mesmo efeito já está no ledger para a entrada, ou a mensagem do provedor já existe no canal | nada repetido; inbox `processed` |
| `already_processed`, `terminal_failed`, `claim_lost`, `not_found` | como na finalização da B3.2d-1 | nada muda |
| `identity_conflict` | telefone e BSUID não batem com uma identidade só | nada gravado; claim continua |
| `effect_conflict` | a chave estável já tem outro efeito | nada gravado; claim continua |
| `channel_paused`, `channel_disconnected`, `channel_disabled` | o canal foi pausado, desconectado ou desativado depois do claim | nada gravado; claim continua |

**Status do canal no momento do efeito.** O consumidor confere o estado do
canal antes de chamar o efeito, mas entre o claim e a aplicação um
administrador pode pausar, desconectar ou desativar o canal. Por isso a RPC
reconfere o status **atual** do canal da linha, depois de travar a inbox e
antes de reservar o ledger: fora de `active`, devolve o resultado do
estado, sem gravar ledger, identidade, conversa, mensagem, registro
comercial ou auditoria, e a entrada fica em `processing` com o mesmo
claim. A linha do canal é lida `for share`: uma mudança de estado
concorrente espera o efeito em andamento terminar, e o efeito seguinte já
vê o estado novo. **Quem libera o claim é a B3.2d-2b3**, ao receber esses
resultados (`whatsapp_inbox_release` com o mesmo código, como o consumidor
já faz com `channel_paused`, `channel_disconnected` e `channel_disabled`).

`applied` devolve só `message_id`, `conversation_id`,
`sender_classification`, `contact_created` e `lead_created`: nenhum
telefone, BSUID ou texto.

### 22.2 Ordem, numa transação só

1. inbox travada (`for update`) no ambiente autenticado; `processing`,
   token igual e lease vigente (um `clock_timestamp()`); canal da linha
   lido `for share` e ainda `active`;
2. `private.whatsapp_effect_ledger_reserve(inbox, 'message.inbound')`;
3. travas consultivas em ordem fixa: a mensagem do provedor no canal, o
   telefone (a mesma chave do simulador da A7) e o BSUID;
4. mensagem do provedor já existente → `duplicate`;
5. identidade (§22.3) e classificação (§22.4);
6. conversa da identidade (cria ou reutiliza; ganha o telefone quando a
   identidade ganha);
7. contato, lead, oportunidade e atividade (§22.5);
8. mensagem `inbound`, `delivered`, com provedor e id do provedor; mídia
   sem texto aceita, nenhum arquivo baixado;
9. auditoria sem ator e sem telefone, nome ou texto; ledger aponta para a
   mensagem; inbox `processed`.

Os três estados do canal voltam no passo 1, antes de qualquer escrita. Os
dois conflitos voltam como resultado depois de desfazer o bloco (ledger,
identidade, conversa, mensagem); qualquer outra falha propaga e desfaz
tudo, inclusive a reserva e a finalização.

### 22.3 Matriz de resolução de identidade

| Telefone | BSUID | Resultado |
|---|---|---|
| nenhum existe | nenhum existe | cria uma identidade com os identificadores recebidos |
| existe (X) | não informado | reutiliza X |
| existe (X, sem BSUID) | novo | reutiliza X e acrescenta o BSUID |
| existe (X, com outro BSUID) | novo | `identity_conflict` |
| não informado | existe (Y) | reutiliza Y |
| novo | existe (Y, sem telefone) | reutiliza Y e acrescenta o telefone |
| novo | existe (Y, com outro telefone) | `identity_conflict` |
| existe (X) | existe (X) | reutiliza X |
| existe (X) | existe (Y ≠ X) | `identity_conflict`, sem auto-merge |

As travas do telefone e do BSUID fazem duas transações com o mesmo par
esperarem uma pela outra: nunca nascem identidades separadas para ele.

### 22.4 Classificação do remetente

`private.whatsapp_classify_inbound_sender(canal, telefone, lookup)`, só
pelas identidades internas **ativas** do canal:
- **o canal não tem nenhuma identidade interna ativa** → `inbound` +
  `unresolved` (decisão do João): sem cadastro não há como saber se é o
  escritório, e a ausência de configuração nunca transforma um remetente
  em cliente. Identidade desativada não conta como configuração;
- casa com alguma (telefone, ou índice cego da mesma versão de chave) →
  `inbound` + `internal`;
- todas são comparáveis (ao menos um identificador do mesmo tipo dos dois
  lados) e nenhuma casa → `inbound` + `external`;
- alguma não dá para comparar → `inbound` + `unresolved`.

Nunca pelo texto, pelo nome do perfil, pelo formato de um id ou por
exclusão de outras origens.

No caso `unresolved`, identidade, conversa e mensagem são gravadas
normalmente e a conversa fica sempre para revisão; nada comercial é
criado **nem vinculado** (§22.5).

### 22.5 Contato e lead (A3, A4 e A7)

Só numa **conversa nova**, como na A7 (mensagem seguinte não reabre o
vínculo):
- `internal`: nada de contato ou lead; conversa sem revisão;
- `unresolved`: **não procura nem vincula** contato, lead ou oportunidade,
  e não cria nada comercial, mesmo que um contato do workspace tenha o
  mesmo telefone. Grava só identidade, conversa e mensagem; a conversa
  fica com `needs_link_review = true` e `contact_id`, `lead_id` e
  `opportunity_id` nulos, sem candidatos. O vínculo, se houver, é humano;
- **só `inbound` + `external`** com telefone casa um contato existente
  pelo identificador `whatsapp` (dígitos do E.164) ou por telefone único,
  e o lead/oportunidade ativos dele, como a A7;
- **só `inbound` + `external`** sem contato conhecido cria,
  atomicamente, na mesma transação da conversa, da mensagem e do ledger:
  - contato (com telefone `whatsapp_inbound` e identificador `whatsapp`);
  - lead `A definir`;
  - oportunidade na primeira etapa do pipeline padrão;
  - atividade de resposta ao primeiro contato.
  Qualquer falha desfaz todos esses registros e o ledger;
- `external` sem telefone (só BSUID): conversa para revisão humana, sem
  criar nada.

**Autoria técnica (decisão do João).** `created_by` é obrigatório nessas
tabelas e o webhook não tem usuário. Contato, lead, oportunidade e
atividade recebem o `created_by` do canal: o **responsável técnico que
configurou o canal**, nunca o autor humano da ação. Por isso:
- a auditoria grava `actor_user_id = NULL` e `metadata.source =
  whatsapp_inbound`;
- nenhum usuário vem da mensagem: a RPC não tem parâmetro de usuário;
- qualquer tela futura deve mostrar "Criado automaticamente pelo
  WhatsApp", nunca "Criado por <nome>". `create_lead` e `create_opportunity` exigem
usuário autenticado e não foram alterados: a RPC grava as mesmas linhas
com os mesmos padrões.

Nenhuma tabela nova de contato, lead, conversa ou mensagem.

### 22.6 Compatibilidade com a A7

- Nenhuma função da A7 mudou; a migration só cria funções e não altera
  dados.
- O pgTAP 12, o 14 e o E2E continuam passando; as leituras da A7 mostram
  a conversa e as mensagens aplicadas, inclusive conversa só com BSUID
  (sem telefone).
- **Teste de atualização** (`scripts/check-upgrade-b3-2d2b2a-efeito.sh`):
  A7 e uma entrada da inbox gravadas antes da migration; leituras e
  contagens idênticas depois; a entrada antiga aplica reutilizando a
  identidade e a conversa existentes, sem criar contato ou lead; o
  simulador e o envio seguem funcionando.

### 22.7 Testes

Commit só de testes `2bc00b0`, contra a main `5ba35c4`. Vermelho:
- unitários: 39 de 40 falham (passa o estático de que o consumidor não
  chama o efeito);
- pgTAP 36, na PR temporária #135: 51 de 54 falham (passam as três
  conferências de "nada mudou", verdadeiras sem a função);
- concorrência e atualização: falham (a função não existe).

**Correções nos testes**, em commits próprios:
- `da54c52`: desestruturação recusada pelo TypeScript estrito e uma regex
  estática que casava com a anotação de tipo do resultado;
- `ffdac01`: o estático da B3.2d-2a permitia o claim só na inbox e no
  consumidor; os efeitos (`src/server/whatsapp/effects/`) também o
  recebem, para a RPC conferir token e lease;
- `8cb6dfa`: o pgTAP 36 contava linhas da leitura de mensagens da A7, que
  devolve uma linha com o array.

Implementação: `5781c0a`.

**Rodada das decisões.** Testes primeiro em `518d821`, sobre `8cb6dfa`.
Vermelho na PR temporária #150: no pgTAP 36, 2 de 61 falham ("nenhuma
identidade ativa" e "só identidade desativada" davam `external`); o teste
de atualização também falha. Correção na própria migration em `50145ba`.

**Rodada do vínculo e do status do canal.** Testes primeiro em `c0a974e`,
sobre `5125812`; correção do próprio teste em `b7762e6` (o `concat_ws`
escrevia o booleano como `t`/`f`, e a conferência depois da liberação lia
a inbox ainda como `service_role`). Vermelho na PR temporária #154 (os
testes corrigidos sobre o código anterior):
- pgTAP 36: 7 de 69 falham:
  - 62 e 63: o `unresolved` vinculava o cliente já cadastrado pelo
    telefone (contato, lead e oportunidade) e, no 63, ainda acrescentava o
    identificador `whatsapp`;
  - 65 a 67: com o canal pausado, desconectado ou desativado depois do
    claim, o efeito aplicava e criava contato e lead;
  - 68: a entrada já estava processada, e o claim não podia mais ser
    liberado;
  - 69: falha em cascata do 65 (o telefone já tinha conversa);
  - o controle `external` (64) passa;
- unitários: 3 de 44 falham (os três `channel_*` davam `invalid_response`);
- concorrência, cenário 5: a pausa terminava sem esperar o efeito em
  andamento.

Correção na própria migration em `7142c29`.

**Cobertura:**
- `tests/unit/b3-2d2b2a-mensagem-recebida.test.ts` (44): argumentos
  exatos, BSUID só como índices e cifra (inclusive duas versões de chave e
  BSUID com cara de telefone), chaves ausentes, 12 entradas inválidas antes
  do banco, claim não confiável, resultados conferidos (inclusive os três
  `channel_*`, que são os mesmos códigos que o consumidor libera), erros
  sanitizados, estáticos;
- `supabase/tests/database/36_b3_2d2b2a_mensagem_recebida.test.sql` (69):
  estrutura e permissões; claim (pending, token, lease, ambiente, sem
  ambiente, inexistente); entrada inválida; aplicação completa pela A7 com
  autoria e auditoria; reentrega; matriz de identidade e versão antiga da
  chave; classificação (internal por telefone e BSUID, unresolved,
  texto e nome ignorados, inativa ignorada, outro canal); canal sem
  identidade interna ativa (unresolved sem nada comercial, desativada não
  conta, a primeira ativa torna comparável); autoria técnica (created_by
  do canal de outro usuário, auditoria sem ator e com a origem); effect_conflict,
  duplicate e mesma mensagem por outro evento; mídia; rollback integral
  depois da reserva; outro workspace e Production; leituras da A7;
  `unresolved` sem vínculo nem alteração comercial, com um cliente já
  cadastrado pelo telefone (canal sem identidade interna ativa e
  identidade incomparável), e o controle `external` que reutiliza;
  canal pausado, desconectado e desativado depois do claim (nada gravado,
  nem auditoria; claim intacto e liberável) e o controle com canal ativo;
- concorrência real (`scripts/b3-2d2b2a-inbound-concurrency-check.sh`):
  o mesmo evento duas vezes (applied e already_processed), o mesmo
  remetente novo em dois eventos (uma identidade, uma conversa, um lead),
  enriquecimento simultâneo, telefone/BSUID de identidades diferentes
  (dois identity_conflict sem efeito) e a pausa do canal com um efeito em
  andamento (a pausa espera; o claim antigo usado depois vê
  `channel_paused`, sem efeito).

### 22.8 Mutações

Banco: as 16 rodadas de novo sobre a correção `b7762e6`, uma PR temporária
por mutação (#155 a #170), todas reprovadas e fechadas. As rodadas
anteriores (M1 a M13 em #137 a #149 sobre `8cb6dfa`; M14 em #151 sobre
`50145ba`) também tinham sido reprovadas.

| Mutação | Detectada por |
|---|---|
| M1 token do claim não conferido | pgTAP 36 (recusas, aplicação) |
| M2 lease não conferida | pgTAP 36 (lease vencida e "nada escrito") |
| M3 inbox de qualquer ambiente | pgTAP 36 (outro ambiente; Production a partir de Preview) |
| M4 conflito de efeito ignorado | pgTAP 36 (effect_conflict, duplicate) |
| M5 auto-merge de telefone e BSUID de identidades diferentes | pgTAP 36 (identity_conflict) e concorrência, cenário 4 |
| M6 telefone conhecido com outro BSUID aceito | pgTAP 36 (identity_conflict) |
| M7 sem as travas do telefone e do BSUID | concorrência, cenário 2 |
| M8 identidade interna inativa conta | pgTAP 36 (a inativa não conta) |
| M9 incomparável vira external | pgTAP 36 (unresolved, inclusive com cliente cadastrado) |
| M10 unresolved cria contato e lead | pgTAP 36 (nada comercial nem vínculo para unresolved) |
| M11 internal cria contato e lead | pgTAP 36 (nada comercial para internal) |
| M12 mesma mensagem do provedor por outro evento não conferida | pgTAP 36 (duplicate) |
| M13 falha depois da reserva não desfaz o ledger | pgTAP 36 (rollback integral; conflito sem ledger) e concorrência, cenário 4 |
| M14 canal sem identidade interna ativa volta a external | pgTAP 36 (nenhuma identidade ativa; só desativada; cliente cadastrado) |
| M15 unresolved volta a procurar e vincular contato, lead e oportunidade | pgTAP 36 (62 e 63: sem vínculo nem alteração comercial) |
| M16 status atual do canal não reconferido no efeito | pgTAP 36 (65 a 69: três estados, liberação e controle) e concorrência, cenário 5 |

Na primeira execução, a M6 e a M16 não chegaram aos testes: o Supabase
local não subiu no CI (limite do registro de imagens, "Rate exceeded").
Reexecutadas, foram reprovadas. O mesmo já tinha acontecido com a M5 na
primeira rodada.

Servidor, localmente, uma de cada vez e restauradas: BSUID em claro nos
argumentos, erro cru repassado, identidade vazia aceita e workspace do
chamador nos argumentos — as quatro detectadas pelos unitários.

### 22.9 Fora do escopo

- ligação do consumidor (B3.2d-2b3);
- eco, status, identidade alterada, eventos de conta, saída humana
  (B3.2d-2b2b);
- download de mídia, reconciliador (B3.2e), telas e envio;
- a interface ainda presume telefone: conversa só com BSUID aparece sem
  número;
- `identity_conflict` não é resolvido: quem decide é o consumidor (2b3),
  e a fusão de identidades fica para uma etapa própria.

Nada configurado fora do código: nenhuma migration no Supabase hospedado,
nenhuma variável, nada no Inngest, na YCloud, na Meta ou na Cloudflare,
nenhuma mensagem enviada, nenhuma mudança no chatbot, nenhum dado real.

## 23. B3.2d-2b2b1 — efeito atômico de mensagem de saída observada (30/10/2026)

A B3.2d-2b2b foi dividida (§15.9): **2b2b1**, mensagem de saída observada
pelo WhatsApp Business App; **2b2b2**, status e custo; **2b2b3**, identidade
alterada e eventos de conta. O envio real iniciado pelo CRM continua fora
e pertence à **B3.3**.

Esta etapa só **registra** no CRM uma mensagem que o escritório já enviou
pelo aplicativo (eco `smb.message.echoes` ou `smb.message.created`). Não
envia mensagem, não chama a YCloud e não altera o chatbot. O consumidor
ainda não chama o efeito (B3.2d-2b3).

### 23.1 Contrato da RPC

`public.whatsapp_effect_outbound_observed(p_inbox_id, p_claim_token,
p_provider_message_id, p_wa_message_id, p_content_kind, p_body_text,
p_occurred_at, p_phone_e164, p_bsuid_lookup, p_bsuid_ciphertext,
p_bsuid_key_version) → jsonb`. SECURITY DEFINER, `search_path` vazio,
EXECUTE só para `service_role`.

- **Nenhum contexto do chamador:** workspace, canal, ambiente, provedor e id
  do evento vêm da linha da inbox, no ambiente autenticado. Origem,
  classificação e autor também não são parâmetros.
- **Destinatário:** telefone, BSUID ou os dois, pelo mesmo caminho da 2b2a
  (`whatsappEffectIdentityArgs`, extraído para
  `src/server/whatsapp/effects/identity-args.ts`): índices cegos de todas
  as versões de chave e a cifra da ativa, no escopo do claim. Nenhum
  telefone é derivado do BSUID; nenhuma chave da inbox é usada.
- **Entrada malformada** (id do provedor, wamid fora de `wamid.` ou com
  mais de 518 caracteres, tipo, texto, telefone, índices, cifra, nenhum
  identificador): `invalid_outbound_message`, antes de qualquer trava ou
  escrita.
- **Limite do wamid, o mesmo em todo o caminho:** o normalizador da YCloud
  aceita `wamid.` + até 512 caracteres (518 no total). A regra de tamanho
  da coluna `wa_message_id`, herdada da A7 (128), é trocada nesta
  migration por uma de 1 a 518 (`messages_wa_message_id_length`), sem
  editar a migration da A7; os ids antigos da A7 continuam válidos. O
  formato `wamid.` é do efeito, não da coluna. Na RPC, formato e tamanho
  são duas regras: no Postgres a repetição `{m,n}` vai só até 255.

| Resultado | Quando | Efeito |
|---|---|---|
| `applied` | mensagem nova gravada | tudo gravado; inbox `processed` |
| `duplicate` | o mesmo efeito já está no ledger para a entrada, ou a mensagem já existe no canal pelo id do provedor ou pelo wamid **para a mesma identidade do destinatário** | nada repetido; o identificador que faltava é acrescentado; inbox `processed` |
| `already_processed`, `terminal_failed`, `claim_lost`, `not_found` | como na finalização da B3.2d-1 | nada muda |
| `channel_paused`, `channel_disconnected`, `channel_disabled` | o canal deixou de estar ativo depois do claim | nada gravado; claim continua |
| `identity_conflict` | telefone e BSUID não batem com uma identidade só | nada gravado; claim continua |
| `message_conflict` | o id do provedor e o wamid apontam para mensagens diferentes; a mensagem existente tem outro valor para o mesmo identificador; ela não é uma saída; ou ela é de **outro destinatário** | nada gravado nem alterado; claim continua |
| `effect_conflict` | a chave estável já tem outro efeito | nada gravado; claim continua |

`applied` devolve só `message_id` e `conversation_id`. Os três estados do
canal e os conflitos ficam para a B3.2d-2b3 liberar ou decidir.

### 23.2 Ordem, numa transação só

1. inbox travada (`for update`) no ambiente autenticado; `processing`,
   token igual e lease vigente; canal da linha lido `for share` e ainda
   `active` (a mesma proteção da 2b2a, §22.1);
2. `private.whatsapp_effect_ledger_reserve(inbox, 'message.outbound_observed')`;
3. travas consultivas em ordem fixa: o id do provedor (a mesma chave da
   2b2a), o wamid, o telefone e o BSUID;
4. identificadores da mensagem: mensagens diferentes, outro valor ou
   mensagem recebida → `message_conflict` (§23.3);
5. identidade do destinatário (`private.whatsapp_resolve_inbound_identity`,
   a mesma matriz do §22.3: sem auto-merge, `identity_conflict`); a mesma
   mensagem já gravada converge só para a mesma identidade (§23.3);
6. conversa da identidade (reutilizada; ou criada, com o vínculo do §23.5);
7. mensagem; auditoria `message.observed` sem ator e sem telefone ou
   texto; ledger aponta para a mensagem; inbox `processed`.

Os conflitos voltam como resultado depois de desfazer o bloco (ledger,
identidade, conversa, mensagem); qualquer outra falha propaga e desfaz
tudo, inclusive a reserva e a finalização.

### 23.3 Identificadores da mensagem

Grava `provider_message_id` e, quando vier, `wa_message_id`.
- o mesmo id do provedor, ou o mesmo wamid, no canal → a mensagem
  existente; nada repetido (`duplicate`), e o ledger desta entrada aponta
  para ela;
- a existente sem um dos identificadores ganha o que falta, só quando não
  há conflito;
- os dois identificadores em mensagens diferentes, a existente com outro
  valor para o mesmo identificador, ou a existente sendo uma mensagem
  recebida → `message_conflict`, nada alterado;
- `smb.message.echoes` e `smb.message.created` da mesma mensagem (eventos
  diferentes, o mesmo id do provedor) convergem para uma mensagem só; a
  trava do id e a do wamid fazem os dois esperarem um pelo outro;
- **o destinatário é conferido antes de concluir `duplicate`:** a
  identidade do evento novo é resolvida e comparada com a da conversa da
  mensagem existente. Outra identidade (outro telefone, outro BSUID, ou um
  BSUID nunca visto, que sozinho não prova nada) → `message_conflict`, e o
  bloco desfaz a identidade criada ou enriquecida: nenhuma identidade,
  conversa, mensagem ou ledger fica. Telefone e BSUID complementares da
  mesma identidade convergem (e o identificador que faltava fica na
  identidade); telefone e BSUID de identidades diferentes continuam
  `identity_conflict`. Nunca pelo texto, nome, `externalId` ou formato.

### 23.4 Origem e autoria

`direction = outbound`, `origin = business_app`, `sender_classification =
internal`, `sent_by = NULL` (o CRM não sabe quem operou o aplicativo),
`status = sent`, sem chave de reenvio nem correlação. Nada é inferido do
texto, do nome, do `externalId` ou do formato de um identificador. Nunca
`chatbot`: essa origem continua exigindo correlação positiva e confiável.

### 23.5 Conversa e registros comerciais

- conversa existente para a identidade → reutilizada (ganha o telefone
  quando a identidade ganha);
- conversa nova → vínculo **só exato e único**, pelas regras da A7: contato
  pelo identificador `whatsapp` ou por telefone único; lead ativo único;
  oportunidade aberta única;
- dois contatos com o telefone, dois leads ativos ou duas oportunidades
  abertas → o que for único fica, o resto não, e a conversa vai para
  revisão humana, com os candidatos;
- destinatário desconhecido ou só com BSUID → conversa para revisão, sem
  contato;
- **nunca** cria contato, lead, oportunidade ou atividade, nem acrescenta
  identificador ao contato: mensagem enviada pelo aplicativo não prova que
  o destinatário seja um lead novo.

### 23.6 Conteúdo

Os tipos já normalizados; texto obrigatório só para `text`; imagem, áudio,
documento e as demais mídias podem ficar sem texto. Nenhuma mídia é
baixada.

### 23.7 Compatibilidade com a A7

- nenhuma função da A7 nem da 2b2a mudou no banco; a migration troca a
  regra de tamanho do `wa_message_id` (128 → 518), cria a função e não
  altera dados. No servidor, a 2b2a passou a usar o módulo comum de
  identidade, sem mudar os argumentos nem os códigos de erro;
- as leituras da A7 mostram a conversa com a mensagem recebida e a enviada
  pelo aplicativo, inclusive conversa só com BSUID;
- **teste de atualização** (`scripts/check-upgrade-b3-2d2b2b1-saida-observada.sh`):
  A7 e uma entrada de eco gravadas antes da migration; leituras e contagens
  idênticas depois; o eco antigo aplica sobre a conversa existente como
  outbound/business_app/internal, sem nada comercial; o simulador e o envio
  seguem funcionando, com os ids antigos e com um wamid de 129 caracteres.

### 23.8 Testes

Commit só de testes `2230425`, contra a main `740f0f8`.

**Correções nos testes**, em commits próprios:
- `ba13bc8`: sem a função, um `\gset` de valor nulo deixava a variável
  indefinida e o pgTAP 37 parava no meio; no cenário 3 da concorrência, o
  booleano concatenado sai `true`, não `t`;
- `322089b`: a mensagem inserida à mão no §8 do pgTAP usava uma conversa
  que, sem a função, não existe;
- `ad2ff7f`: telefone válido com BSUID malformado (e o inverso) recusados
  antes do banco — acrescentado depois de uma mutação do servidor;
- `3670ab0`: no cenário 4 da concorrência, a trava do telefone mascarava a
  falta da trava do wamid (a mutação N8 sobrevivia); agora os dois eventos
  têm destinatários identificados de jeitos diferentes e só a trava do
  wamid os põe em fila.

**Vermelho** (os testes corrigidos sobre a main, PR temporária #174):
- typecheck: o módulo do efeito não existe;
- unitários: 46 de 47 falham (passa o estático de que o consumidor não
  chama o efeito);
- pgTAP 37: 45 de 54 falham (passam as conferências de "nada mudou",
  verdadeiras sem a função);
- concorrência e atualização da 2b2b1: falham (a função não existe).

Implementação: `feb165d` (módulo comum de identidade, sem mudar a 2b2a) e
`d704aaa` (RPC, servidor e tipos).

**Rodada do destinatário e do wamid.** Testes primeiro em `81d6e85`, sobre
`650b48a`; correção do próprio teste em `1ac0172` (o estático exigia na
RPC a regex `{1,512}`, impossível no Postgres). Vermelho na PR temporária
#213 (os testes corrigidos sobre o código anterior):
- pgTAP 37: 7 de 62 falham — 41 a 43 (o mesmo id ou wamid com outro
  telefone ou outro BSUID virava `duplicate`), 44 e 45 (a identidade não
  ganhava o BSUID na convergência, e telefone + BSUID de identidades
  diferentes virava `duplicate`), 46 (129 e 518 recusados) e 48 (a coluna
  recusava 518);
- unitários: 3 de 53 falham (129, 518 e o mesmo limite do normalizador);
- atualização: a A7 não gravava um wamid de 129 caracteres.

Correção na própria migration em `6d4ca59`; a primeira versão usava
`{1,512}` na regex da RPC, que o Postgres recusa e fazia todo o efeito
falhar no CI — trocada por formato + tamanho em `49f5f29`.

**Cobertura:**
- `tests/unit/b3-2d2b2b1-saida-observada.test.ts` (53): argumentos exatos
  (nenhum contexto, origem, classificação ou autor), wamid opcional e de
  128, 129 e 518 caracteres, o mesmo limite do normalizador, mídia
  sem texto, destinatário por telefone, BSUID ou os dois (mesmos argumentos
  da 2b2a), chaves ausentes, 16 entradas inválidas antes do banco, claim
  não confiável, resultados conferidos, erros sanitizados, estáticos (não
  envia, não chama o provedor, criptografia sem cópia, consumidor não
  ligado);
- `supabase/tests/database/37_b3_2d2b2b1_saida_observada.test.sql` (62):
  estrutura e permissões; claim (pending, token, lease, ambiente, sem
  ambiente, inexistente); entrada inválida (inclusive wamid); primeira
  mensagem com destinatário desconhecido (origem, autoria, ledger,
  revisão, nada comercial, auditoria); reentrega; conversa já existente
  (criada pela 2b2a); vínculo exato pelo identificador e pelo telefone
  único; contato, lead e oportunidade ambíguos → revisão; nada comercial
  criado ou alterado; só BSUID, os dois, enriquecimento e
  `identity_conflict`; duplicação por id do provedor e por wamid; echoes +
  created; `message_conflict` (ids de mensagens diferentes, outro id,
  mensagem recebida) sem alterar nada; destinatário conferido na
  convergência (outro telefone, outro BSUID, BSUID nunca visto →
  `message_conflict` sem identidade divergente; complementares da mesma
  identidade convergem); limite do wamid (128, 129 e 518 aceitos, 519
  recusado, a coluna com 518); `effect_conflict` e efeito já reservado;
  mídia; canal pausado, desconectado e desativado depois do
  claim, liberação e controle; rollback integral depois da reserva; outro
  workspace e Production; nenhuma atividade ou criação comercial; leituras
  da A7;
- concorrência real (`scripts/b3-2d2b2b1-outbound-concurrency-check.sh`):
  o mesmo evento duas vezes; echoes e created da mesma mensagem (uma
  mensagem, com o wamid); o mesmo destinatário novo em duas mensagens (uma
  identidade, uma conversa); o mesmo wamid com ids e destinatários
  diferentes (`message_conflict` sem efeito); a pausa do canal durante o
  efeito;
- teste de atualização (§23.7).

### 23.9 Mutações

Banco: as 19 rodadas sobre a correção final `49f5f29`, uma PR temporária
por mutação (#214 a #232), todas reprovadas e fechadas. A rodada anterior
(N1 a N17 em #175 a #192) também tinha sido reprovada; a de #194 a #212
foi descartada, porque rodou sobre a versão com a regex inválida.

| Mutação | Detectada por |
|---|---|
| N1 token do claim não conferido | pgTAP 37 (recusas, aplicação, ledger, A7) |
| N2 lease não conferida | pgTAP 37 (lease vencida e "nada escrito") |
| N3 inbox de qualquer ambiente | pgTAP 37 (outro ambiente; Production a partir de Preview) |
| N4 status atual do canal não reconferido | pgTAP 37 (três estados e liberação) e concorrência, cenário 5 |
| N5 conflito de efeito ignorado | pgTAP 37 (effect_conflict, efeito já reservado) |
| N6 falha depois da reserva não desfaz o ledger | pgTAP 37 (rollback integral; conflitos sem ledger) e concorrência, cenário 4 |
| N7 sem as travas consultivas | concorrência, cenário 2 |
| N8 sem a trava do wamid | concorrência, cenário 4 |
| N9 id do provedor e wamid de mensagens diferentes não conferidos | pgTAP 37 (message_conflict) |
| N10 mensagem com outro id, ou recebida, converge | pgTAP 37 (message_conflict sem alterar nada) e concorrência, cenário 4 |
| N11 a mesma mensagem não é procurada pelo wamid | pgTAP 37 (duplicação por wamid, conflitos) e concorrência, cenário 2 |
| N12 a mesma mensagem não é procurada pelo id do provedor | pgTAP 37 (duplicação por id, echoes + created) e concorrência, cenário 2 |
| N13 com telefone, o BSUID é ignorado na identidade | pgTAP 37 (os dois identificadores, enriquecimento, identity_conflict) e concorrência, cenário 3 |
| N14 contato ambíguo vinculado ao primeiro | pgTAP 37 (dois contatos com o telefone) |
| N15 lead ambíguo vinculado ao primeiro | pgTAP 37 (dois leads ativos) |
| N16 destinatário desconhecido sem revisão | pgTAP 37 (desconhecido; só BSUID) |
| N17 origem external_api/unresolved | pgTAP 37 (mensagem campo a campo) |
| N18 destinatário não conferido na convergência | pgTAP 37 (41 a 43: outro telefone, outro BSUID) |
| N19 limite antigo de 128 caracteres no wamid | pgTAP 37 (46 e 48: 129 e 518; a coluna) |

Na rodada anterior, a N4, a N5 e a N17 não chegaram aos testes na
primeira execução (o Supabase local não subiu no CI, "Rate exceeded") e
foram reprovadas na reexecução; a N8 sobreviveu à primeira versão do
cenário 4 (a trava do telefone serializava os dois eventos) e foi
reprovada com o cenário corrigido em `3670ab0`. Na rodada final, em dois
lotes, todas chegaram aos testes.

Servidor, localmente, uma de cada vez e restauradas, todas detectadas
pelos unitários: BSUID em claro nos argumentos; erro cru do banco
repassado; campo extra aceito (origem ou autor do chamador); workspace e
origem do chamador nos argumentos; destinatário inválido passado ao banco
como veio; wamid fora do formato. Uma primeira versão desta última
mutação de identidade (só tirar a conferência) era equivalente: o
`whatsappContactIdentity` já recusa qualquer identificador malformado e o
efeito falha fechado do mesmo jeito.

### 23.10 Fora do escopo e riscos

- ligação do consumidor (B3.2d-2b3); status e custo (2b2b2); identidade
  alterada e eventos de conta (2b2b3); envio iniciado pelo CRM (B3.3);
  download de mídia; telas;
- **decisão aceita:** ids do provedor diferentes com o mesmo wamid →
  `message_conflict` (fica para a 2b3 decidir), nunca uma segunda
  mensagem, até o webhook real comprovar outro comportamento;
- **decisão aceita:** a saída observada não acrescenta identificador
  comercial ao contato;
- um BSUID nunca visto, sozinho, para uma mensagem já gravada dá
  `message_conflict`: ligar os dois seria auto-merge;
- `identity_conflict` e `message_conflict` não são resolvidos aqui.

Nada configurado fora do código: nenhuma migration no Supabase hospedado,
nenhuma variável, nada no Inngest, na YCloud, na Meta ou na Cloudflare,
nenhuma mensagem enviada, nenhuma mudança no chatbot, nenhum dado real.

## 24. B3.2d-2b2b2 — efeito atômico de status e custo (30/10/2026)

Esta etapa aplica um `NormalizedStatusUpdate` (`whatsapp.message.updated`)
a uma mensagem de saída **já gravada**: projeta o status sem regressão,
grava o código de erro do provedor e o custo informado por ele, e preserva
o `externalId` como correlação opaca. Não cria mensagem, conversa,
identidade, contato, lead, oportunidade ou atividade. Não envia mensagem,
não chama a YCloud e não altera o chatbot. O consumidor ainda não chama o
efeito (B3.2d-2b3).

### 24.1 Contrato da RPC

`public.whatsapp_effect_message_status(p_inbox_id, p_claim_token,
p_provider_message_id, p_wa_message_id, p_external_id, p_status,
p_error_code, p_occurred_at, p_phone_e164, p_bsuid_lookup,
p_bsuid_ciphertext, p_bsuid_key_version, p_cost_amount, p_cost_currency,
p_cost_category, p_cost_finality) → jsonb`. SECURITY DEFINER,
`search_path` vazio, EXECUTE só para `service_role`.

- **Nenhum contexto do chamador:** workspace, canal, ambiente, provedor e id
  do evento vêm da linha da inbox, no ambiente autenticado. Origem,
  classificação, autor e correlação não são parâmetros.
- **Destinatário opcional:** telefone e/ou BSUID pelo mesmo caminho da 2b2a
  (`whatsappEffectIdentityArgs`); sem destinatário, os quatro argumentos
  vão nulos e a aplicação segue.
- **Entrada malformada** (status fora de accepted/sent/delivered/read/
  failed, id do provedor, wamid fora de `wamid.` ou com mais de 518
  caracteres, `externalId` vazio, com mais de 512 caracteres ou com
  caractere de controle, código de erro fora de
  `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`, horário ausente ou infinito,
  telefone, índices, cifra, custo parcial ou incoerente):
  `invalid_status_update`, antes de qualquer trava ou escrita.

| Resultado | Quando | Efeito |
|---|---|---|
| `applied` | a mensagem mudou: status, erro, custo ou um identificador que faltava | gravado; ledger na mensagem; inbox `processed` |
| `duplicate` | o mesmo efeito já está no ledger para a entrada, ou a projeção não muda nada | nada alterado; ledger na mensagem; inbox `processed` |
| `message_not_found` | nenhuma mensagem do canal com esse id do provedor ou wamid ainda | **nada gravado** (nenhum ledger, placeholder ou identidade); inbox em `processing`; claim continua; reaplicável depois |
| `message_conflict` | o id do provedor e o wamid apontam para mensagens diferentes; a mensagem tem outro valor para um identificador ou para o `externalId`; não é uma saída; ou o destinatário é outra identidade (inclusive telefone e BSUID de identidades diferentes) | nada gravado nem alterado; claim continua |
| `cost_conflict` | a mensagem já tem custo final e o evento traz outro custo final (valor, moeda ou categoria) | nada gravado nem alterado; claim continua |
| `effect_conflict` | a chave estável já tem outro efeito | nada gravado; claim continua |
| `already_processed`, `terminal_failed`, `claim_lost`, `not_found` | como na finalização da B3.2d-1 | nada muda |
| `channel_paused`, `channel_disconnected`, `channel_disabled` | o canal deixou de estar ativo depois do claim | nada gravado; claim continua |

`applied` devolve só `message_id`. `message_not_found`, os conflitos e os
três estados do canal ficam para a B3.2d-2b3 liberar ou decidir.

### 24.2 Ordem, numa transação só

1. inbox travada (`for update`) no ambiente autenticado; `processing`,
   token igual e lease vigente; canal da linha lido `for share` e ainda
   `active`;
2. `private.whatsapp_effect_ledger_reserve(inbox, 'message.status')`;
3. travas consultivas em ordem fixa, as mesmas dos outros efeitos: o id do
   provedor, o wamid, o telefone e o BSUID. O status espera a saída
   observada (ou a recebida) da mesma mensagem que ainda está sendo
   gravada, e dois status da mesma mensagem esperam um pelo outro;
4. a mensagem do mesmo canal, travada (`for update`) pelo id do provedor e
   pelo wamid; nenhuma → `message_not_found`;
5. identificadores, `externalId` e destinatário (§24.3 e §24.7);
6. projeção do status, do erro e do custo (§24.4 a §24.6);
7. mensagem atualizada (só se algo muda); ledger aponta para a mensagem;
   inbox `processed`.

`message_not_found` e os conflitos voltam como resultado depois de desfazer
o bloco (reserva, identidade criada ou enriquecida, mensagem); qualquer
outra falha propaga e desfaz tudo. Não há auditoria por status: o ledger e
a inbox são o registro (nenhum custo ou destinatário vai para
`audit_logs`), e `message_status_events` (o log do simulador da A7) não é
usado.

### 24.3 Localização da mensagem

- Só no canal da entrada, pelo id do provedor e, quando vier, pelo wamid.
  Nunca pelo `externalId` sozinho, e nunca em outro canal ou workspace.
- Os dois encontram mensagens diferentes, a mensagem é **recebida**, ou ela
  já tem outro id do provedor ou outro wamid: `message_conflict`.
- Um identificador ausente na mensagem é acrescentado (alteração efetiva:
  `applied`).
- Nenhuma mensagem: `message_not_found`, recuperável. O status pode chegar
  antes do eco; a mesma entrada, com o mesmo claim, aplica depois que a
  mensagem existir.

### 24.4 Status

A regra do banco é `private.whatsapp_message_status_should_apply` (B3.2d-2b1),
a mesma de `projectWhatsAppMessageStatus`:
- accepted → sent → delivered → read, sem regredir;
- failed substitui accepted ou sent; delivered e read corrigem failed;
  failed nunca substitui delivered ou read; accepted e sent tardios não
  apagam failed;
- status repetido é no-op.

O pgTAP 38 prova a matriz inteira (status atual × status recebido), e um
teste unitário confere que cada linha dela é a de
`projectWhatsAppMessageStatus`. `queued` (da A7) avança como accepted.

`status_updated_at` só muda quando o status efetivo muda, e nunca volta:
fica o maior entre o horário gravado e o do evento.

### 24.5 Erro do provedor

- Só código opaco e bem formado. No servidor, o código que não tem esse
  formato (texto livre, espaço, longo demais) vira `unrecognized`; nunca a
  mensagem do provedor.
- O código só vai junto de `failed`. Ao entrar em failed, ele é gravado em
  `error_reason`; ao ser corrigido por delivered/read, o erro é limpo.
- Status tardio que não muda a projeção não troca o erro gravado, mesmo
  quando o evento grava outra coisa (um custo novo).

### 24.6 Custo

A regra de `projectWhatsAppProviderCost`:
- custo ausente preserva o atual; estimativa nova substitui a antiga;
  final substitui estimativa;
- o final nunca volta a estimativa, nunca some e nunca é substituído. O
  mesmo final de novo (com ou sem categoria) é `duplicate`; **outro** final
  (valor, moeda ou categoria) é `cost_conflict`, nunca `duplicate`;
- só `provider_cost_finality = final` entra em
  `provider_cost_billable_amount` (coluna gerada da B3.2d-2b1);
- custo de failed é estimativa, mesmo se vier como final (a decisão do
  §21); final de accepted ou sent é incoerente e recusado;
- categoria aberta, mas validada pela regra do domínio
  (`sanitizeWhatsAppProviderCost`: malformada vira nula sem perder o
  valor); moeda ISO 4217; valor finito, não negativo e que cabe na coluna
  (`numeric(18, 6)`, arredondado a 6 casas);
- custo parcial é recusado antes da escrita.

Um delivered tardio sobre um read não muda o status nem o horário, mas o
custo final que ele traz é aplicado.

### 24.7 externalId e destinatário

- **externalId** é correlação opaca: preenche `provider_external_id`
  quando está nulo; o mesmo valor de novo não muda nada; outro valor é
  `message_conflict`. Não localiza a mensagem sozinho, não é lido pelo
  formato e não muda `origin`, `sender_classification`, `sent_by` nem a
  correlação de autoria: uma saída de API com o formato do chatbot
  continua `external_api`/`unresolved`.
- **Limite do externalId, o mesmo em todo o caminho:** o normalizador
  preserva até 512 caracteres sem caractere de controle (§16.6); a regra
  da coluna (B3.2d-2b1) parava em 255 sem espaço. Esta migration troca
  `messages_provider_ids_format` pela mesma regra, com as regras do id do
  provedor intactas, sem editar a migration anterior.
- **Destinatário**, quando vier, é resolvido pelas mesmas regras e pela
  mesma criptografia dos efeitos anteriores e tem de ser a identidade da
  conversa da mensagem. Outro telefone ou outro BSUID (inclusive um nunca
  visto): `message_conflict`. Telefone e BSUID complementares da mesma
  identidade convergem (e o identificador que faltava fica na
  identidade). Telefone e BSUID de identidades diferentes:
  `message_conflict`, sem auto-merge. A identidade criada ou enriquecida
  numa tentativa conflitante é desfeita. Sem destinatário, a aplicação
  segue.
- **Id do provedor, o mesmo contrato em todo o caminho (255):** o
  adaptador YCloud aceitava de 1 a 256 caracteres no id da mensagem, e o
  domínio (os efeitos, as RPCs e a coluna `provider_message_id`) recusa
  256 — um evento podia ser normalizado só para falhar no efeito. O
  contrato interno desta fase ficou alinhado em 255: um padrão só,
  `WHATSAPP_PROVIDER_MESSAGE_ID_PATTERN` em `provider/contract.ts` (módulo
  neutro; os efeitos não dependem do adaptador), de 1 a 255 caracteres, o
  primeiro alfanumérico e os demais em `A-Za-z0-9._:=+/-`. O adaptador e
  os efeitos de mensagem recebida, saída observada e status usam esse
  padrão: 255 é aceito; 256 termina como `invalid_payload` já na
  normalização e nunca chega ao banco. Nenhum SQL mudou (a coluna e as
  RPCs já paravam em 255). É o contrato interno atual, não uma garantia
  da YCloud: o limite pode ser reavaliado com o webhook real.

### 24.8 Compatibilidade com a A7 e com os dados anteriores

- nenhuma função da A7, da 2b2a ou da 2b2b1 mudou; a migration troca uma
  regra de formato da coluna (`provider_external_id`: 255 → 512) e cria a
  função, sem alterar dados;
- a atualização a partir da 2b2b1 (CI) grava antes da migration a A7 em
  uso (simulador, envio, status), uma saída observada, uma mensagem de API
  com custo estimado e `externalId`, e uma entrada de status; depois:
  leituras da A7, a linha inteira de cada mensagem e as contagens são
  idênticas; a entrada antiga aplica (delivered com custo final cobrado,
  origem e autoria intactas, inbox `processed`, nada criado); o simulador,
  o envio e o status da A7 seguem funcionando.

### 24.9 Testes

Testes primeiro, sobre a main `7159941`: `5fca69e` (só testes), reforçado
antes da implementação em `394728e` (três regras que outra regra também
pegava passam a ter um teste só delas: o id do provedor de uma mensagem
sem wamid com o wamid de outra; failed tardio com outro código e um custo
novo; delivered tardio com custo final sobre um read, com o horário) e
corrigido em `1fe9b70` (sem a RPC, um resultado nulo deixava uma variável
do psql indefinida e o arquivo parava no teste 26).

- `supabase/tests/database/38_b3_2d2b2b2_status_custo.test.sql` (64):
  estrutura e permissões; claim (pending, token, lease, outro ambiente, sem
  ambiente, inexistente); entrada inválida (status, ids, wamid de 519,
  horário infinito, erro com texto livre, `externalId` de 513 ou com
  controle, índices, telefone, dez formas de custo inválido); accepted →
  sent → delivered → read com ledger e horário; tardios e repetidos;
  failed, a correção por delivered/read e o erro; horário que não volta; a
  matriz inteira; wamid de 518; identificador acrescentado; conflitos de
  identificadores e mensagem recebida; `externalId` que não localiza;
  outro canal; `message_not_found` recuperável com o mesmo claim;
  `externalId` preenchido, repetido, conflitante, de 512 e no formato do
  chatbot; destinatário igual, diferente, complementar, de identidades
  diferentes e ausente, com o rollback do BSUID; custo estimado ×
  estimado, estimado × final, final × estimado, final repetido, final
  conflitante, failed com custo, custo ausente, só o final cobrado; canal
  pausado/desconectado/desativado; ledger; rollback depois da reserva;
  isolamento por workspace e por ambiente; nada comercial nem auditoria; a
  coluna do `externalId`; `authenticated` sem EXECUTE;
- `tests/unit/b3-2d2b2b2-status-custo.test.ts` (73): argumentos exatos,
  limites do normalizador, código de erro sanitizado e só com failed,
  custo (completo, zero, categoria malformada, failed estimado, dez
  inválidos), destinatário opcional, dezesseis entradas inválidas,
  resultados e respostas inesperadas, erros sem dado pessoal, e estáticos
  (a matriz do pgTAP 38 é a de `projectWhatsAppMessageStatus`; a regra
  compartilhada no banco; os limites do wamid e do `externalId`; nada de
  envio, origem, criação ou ligação do consumidor);
- `scripts/b3-2d2b2b2-status-concurrency-check.sh`: os cinco cenários de
  sessões reais (read e delivered com a linha segurada; failed tardio
  contra read nas duas ordens; final contra estimativa tardia; o status
  esperando a saída observada em gravação; a pausa do canal);
- `scripts/check-upgrade-b3-2d2b2b2-status-custo.sh`: a atualização a
  partir da 2b2b1 (§24.8);
- `tests/unit/b3-2d2b2b2-provider-message-id.test.ts` (15) e a seção 20
  do pgTAP 38: o id do provedor com 255 caracteres é aceito pelo
  adaptador (recebida, eco e status), pelos três efeitos, pelas três RPCs
  e pela coluna; com 256, o adaptador devolve `invalid_payload`, sem
  evento para o domínio, e os efeitos, as RPCs e a coluna recusam; o
  adaptador e os três efeitos importam o mesmo padrão do contrato, e os
  efeitos não importam o adaptador.

**Vermelho** (PR temporária #236, os testes corrigidos sobre o código sem
a RPC): pgTAP 38 com 60 de 64 falhando (passam só as quatro provas de
"nada mudou", vazias sem a função); unitários com 71 de 73 falhando;
typecheck falha (o módulo não existe); a concorrência e a atualização
falham porque a função não existe. As rodadas #233 e #234 foram
substituídas pelos reforços acima.

**Vermelho do id do provedor** (testes em `f7545f1`, sobre `7eb4be6`, na
PR temporária #260): falham 5 dos 15 testes novos — o adaptador
normaliza um id de 256 caracteres em mensagem recebida, eco e status, o
contrato compartilhado não existe e o adaptador e os efeitos não o usam;
os outros 10 (255 aceito em todo o caminho, 256 recusado pelos efeitos,
os efeitos sem depender do adaptador) já passavam. Correção em `06304ca`.

**Verde** (no HEAD, depois da correção do id do provedor): typecheck,
lint e unitários (2287); tipos em dia; pgTAP inteiro (38 com 66);
isolamento; todas as concorrências; as cinco atualizações; build; E2E
(76); Vercel.

### 24.10 Mutações

Uma PR temporária por mutação sobre `1fe9b70` (#237 a #259), em dois
lotes; todas reprovadas e fechadas. A N8 não chegou aos testes na
primeira execução (o Supabase local não subiu no CI) e foi reprovada na
reexecução.

| Mutação | Reprovada por |
|---|---|
| N1 token do claim não conferido | pgTAP 38 (5, 10, 15) |
| N2 lease não conferida | pgTAP 38 (6, 10, 15) |
| N3 inbox de qualquer ambiente | pgTAP 38 (7, 61) |
| N4 status atual do canal não reconferido | pgTAP 38 (53 a 55) e concorrência 5 |
| N5 canal lido sem FOR SHARE | concorrência 5 (a pausa não esperou o efeito) |
| N6 sem a reserva do ledger | pgTAP 38 (18, 20, 35, 56, 57) e concorrência 1 |
| N7 conflito de efeito ignorado | pgTAP 38 (56, 57) |
| N8 falha depois da reserva não desfaz o ledger (rollback) | pgTAP 38 (32, 34, 35, 40, 43, 48, 58, 59) |
| N9 mensagem localizada sem trava (nem consultiva nem da linha) | concorrência 1 (o delivered calculado sobre leitura velha também aplicou) |
| N10 sem as travas consultivas (só a da linha) | concorrência 2 (o status não espera a trava da mensagem) |
| N11 id do provedor e wamid de mensagens diferentes não conferidos | pgTAP 38 (30) |
| N12 mensagem recebida aceita como saída | pgTAP 38 (31, 32) |
| N13 destinatário não conferido | pgTAP 38 (40, 41, 44, 58, 59) |
| N14 sem a proteção contra regressão do status | pgTAP 38 (20, 21, 23, 27, 51) e concorrência 1 |
| N15 delivered/read não corrigem failed | pgTAP 38 (24, 25, 27, 50, 52) e concorrência 2 |
| N16 sem a proteção do custo final | pgTAP 38 (47, 48) e concorrência 3 |
| N17 custo final de failed não vira estimativa | pgTAP 38 (49) |
| N18 custo final aceito antes da entrega | pgTAP 38 (14, 15) |
| N19 externalId conflitante aceito | pgTAP 38 (37) |
| N20 externalId sozinho localiza a mensagem | pgTAP 38 (33) |
| N21 message_not_found finaliza a inbox e grava o ledger | pgTAP 38 (34, 35) |
| N22 erro trocado por status tardio | pgTAP 38 (23) |
| N23 horário do status pode voltar | pgTAP 38 (26) |

Na N16, a proteção do banco (`provider_cost_final_immutable`, B3.2d-2b1)
também barrou a escrita: o efeito falhou em vez de sobrescrever.

As 23 mutações do banco valem sem alteração: a correção do id do
provedor não muda SQL. Mutação nova, no servidor: o normalizador de volta
a aceitar 256 caracteres reprova 4 testes de
`b3-2d2b2b2-provider-message-id.test.ts` (o id de 256 normalizado em
mensagem recebida, eco e status, e o padrão compartilhado); restaurado o
código, os 15 passam.

### 24.11 Fora do escopo, decisões e riscos

Fora desta PR: a ligação do consumidor (B3.2d-2b3); identidade alterada e
eventos de conta (B3.2d-2b2b3); envio pelo CRM (B3.3); mídia; o chatbot;
configuração real de YCloud, Meta, Inngest, Vercel ou Supabase hospedado;
migrations hospedadas; mensagens reais.

Decisões:
- custo final conflitante tem resultado próprio, `cost_conflict`, fechado
  e documentado, em vez de `message_conflict`: a mensagem e os
  identificadores batem, só o valor cobrado diverge;
- a alteração efetiva de qualquer campo (inclusive só um identificador
  que faltava ou o `externalId`) é `applied`; nada mudou é `duplicate`;
- o código de erro fica em `error_reason`, a coluna que a A7 já mostra,
  sem coluna nova;
- nenhuma auditoria por status (o ledger e a inbox registram cada evento).

Riscos e divergências:
- **custo final divergente trava o status junto:** num `cost_conflict`, o
  status que veio no mesmo evento também não é aplicado (o evento inteiro
  fica com o claim, para a B3.2d-2b3 decidir);
- **BSUID nunca visto** num status de uma mensagem já gravada é
  `message_conflict`, como na 2b2b1: ligar os dois seria auto-merge;
- **arredondamento do custo:** valores com mais de 6 casas são
  arredondados para a coluna; dois finais que só diferem depois da 6ª casa
  são o mesmo custo.

## 25. B3.2d-2b2b3a — efeito atômico de identidade alterada e troca de número (30/10/2026)

A antiga B3.2d-2b2b3 foi dividida (§15.9): **2b2b3a**, identidade alterada
e troca de número; **2b2b3b**, eventos operacionais da conta e do número;
depois, a **B3.2d-2b3**, ligação do consumidor.

Esta etapa aplica um `NormalizedIdentityChange` (mensagem de sistema
`user_changed_number` → `phone_number`; `user_identity_changed` →
`identity`) à identidade que o canal **já conhece**. Não envia mensagem,
não chama a YCloud e não altera o chatbot. O consumidor ainda não chama o
efeito (B3.2d-2b3).

### 25.1 Contrato da RPC

`public.whatsapp_effect_identity_change(p_inbox_id, p_claim_token,
p_change, p_occurred_at, p_previous_phone_e164, p_previous_bsuid_lookup,
p_previous_bsuid_key_version, p_next_phone_e164, p_next_bsuid_lookup,
p_next_bsuid_ciphertext, p_next_bsuid_key_version) → jsonb`. SECURITY
DEFINER, `search_path` vazio, EXECUTE só para `service_role`.

- **Nenhum contexto do chamador:** workspace, canal, ambiente, provedor e id
  do evento vêm da linha da inbox. Contato, lead, usuário e origem não são
  parâmetros.
- **Materiais separados, pelo módulo comum** (`whatsappEffectIdentityArgs`):
  a identidade anterior vai só com telefone e índices cegos de cada versão
  de chave (o banco só a procura, nunca a grava, então não recebe cifra);
  a nova vai com telefone, índices e a cifra da versão ativa, no escopo do
  claim (ambiente, workspace e canal). Nenhum BSUID em claro; nenhuma chave
  da inbox ou da agenda.
- **Validação fechada** (`invalid_identity_change`, antes de qualquer trava
  ou escrita): mudança desconhecida; `phone_number` sem a nova ou sem
  telefone novo; `identity` com a nova (o normalizador nunca a informa);
  anterior vazia; telefone fora do E.164; índice cego, versão ou cifra
  incompletos ou malformados; horário ausente ou infinito; no servidor,
  campos extras.

| Resultado | Quando | Efeito |
|---|---|---|
| `applied` | o telefone (e o BSUID que faltava) da mesma identidade mudou | identidade e conversa atualizadas; auditoria; ledger; inbox `processed` |
| `review_required` | `identity` sem a nova | conversa marcada para revisão (auditoria só se a marca mudou); identidade intacta; ledger; inbox `processed` |
| `duplicate` | o mesmo efeito já está no ledger para a entrada, ou nada precisa mudar (inclusive a mesma troca já aplicada por outro evento) | nada alterado; ledger; inbox `processed` |
| `identity_not_found` | nenhuma identidade anterior no canal | **nada gravado** (nenhum ledger nem identidade); inbox em `processing`; claim continua; reaplicável |
| `identity_conflict` | §25.3 | nada gravado nem alterado; claim continua |
| `effect_conflict` | a chave estável já tem outro efeito | nada gravado; claim continua |
| `already_processed`, `terminal_failed`, `claim_lost`, `not_found` | como na finalização da B3.2d-1 (`claim_lost` também quando a lease vence durante a espera por uma trava, consultiva ou de linha; §25.9) | nada muda |
| `channel_paused`, `channel_disconnected`, `channel_disabled` | o canal deixou de estar ativo depois do claim | nada gravado; claim continua |

`applied` e `review_required` devolvem só `identity_id`.

### 25.2 Ordem, numa transação só

1. inbox travada (`for update`) no ambiente autenticado; `processing`,
   token igual e lease vigente; canal da linha lido `for share` e ainda
   `active`;
2. `private.whatsapp_effect_ledger_reserve(inbox, 'contact.identity_changed')`;
3. travas consultivas em ordem fixa, com as mesmas chaves dos outros
   efeitos: telefone anterior, BSUID anterior, telefone novo e BSUID novo;
   depois da espera, a lease é reconferida;
4. identidade anterior, só lida (§25.3), e travada (`for update`) com a
   conversa dela; a chave do workspace (que a auditoria referencia) travada
   `for key share`;
5. **a lease é conferida de novo**, com um relógio novo, logo depois dessas
   travas de linha e antes da primeira escrita, nos dois caminhos
   (`phone_number` e `identity`); esse horário é o `processed_at` (§25.9);
6. telefone e BSUID novos (§25.3); identidade e conversa atualizadas;
   auditoria; inbox `processed`.

`identity_not_found`, os conflitos e a lease vencida na espera voltam como
resultado depois de desfazer o bloco (reserva, identidade, conversa,
auditoria); qualquer outra falha propaga e desfaz tudo.

### 25.3 Identidades

- **Anterior:** uma resolução própria, só de leitura (não reaproveita a
  função que cria ou enriquece identidade). Telefone e BSUID, quando
  vierem, apontam para a mesma identidade; senão `identity_conflict`. Um
  BSUID que não é o da identidade do telefone também é `identity_conflict`.
  Nenhuma: `identity_not_found`. Se o telefone anterior já não existe mas o
  BSUID reconhece a identidade e ela já está com o telefone novo, a troca
  já foi aplicada por outro evento: `duplicate`.
- **Telefone novo** (obrigatório em `phone_number`): livre → substitui o
  telefone **na mesma identidade**; já é dela → idempotente; de outra
  identidade → `identity_conflict`. Nunca uma segunda identidade; nunca
  telefone derivado do BSUID.
- **BSUID novo:** livre e a identidade sem BSUID → enriquece; o mesmo →
  idempotente; de outra identidade → `identity_conflict`; a identidade já
  tem **outro** BSUID → `identity_conflict`, nunca substituído.
- **Nunca auto-merge:** telefone e BSUID de identidades diferentes, antes
  ou depois, são sempre `identity_conflict`.
- **A guarda das identidades** (B3.2d-2b1) continua proibindo trocar
  telefone ou BSUID. Esta migration a substitui por uma versão com uma
  única exceção: o telefone trocado por este efeito, que marca a própria
  identidade na transação (`praxis.whatsapp_identity_phone_change`, local
  à transação e limpa logo depois). Telefone nunca é apagado. Nenhum papel
  escreve direto na tabela.

### 25.4 Conversa e cadastro comercial

- A identidade continua ligada à **mesma conversa**. Quando o telefone
  muda, `conversations.wa_id` passa a ser o novo.
- `contact_id`, `lead_id`, `opportunity_id` e os candidatos de revisão são
  preservados. Se a conversa está vinculada a algum registro comercial,
  `needs_link_review = true`: o cadastro pode continuar com o telefone
  antigo.
- Nada comercial é criado, apagado ou alterado: nem contato, nem telefone
  do contato, nem `contact_identifiers`, lead, oportunidade ou atividade. O
  telefone do contato **não** é atualizado automaticamente.
- `identity` sem a nova: nada é inventado nem apagado; a conversa vai para
  revisão; os vínculos ficam.

### 25.5 Auditoria

Só numa alteração efetiva: `whatsapp.identity.changed` (troca) ou
`whatsapp.identity.review_required` (identity, quando a marca de revisão
muda), `actor_user_id` nulo, recurso `whatsapp_identity`, metadados
`source = whatsapp_webhook`, o tipo da mudança, o resultado, ids técnicos
(canal, conversa) e indicadores (telefone trocado, BSUID acrescentado,
revisão marcada). Nunca telefone, BSUID, payload ou material cifrado.
Reentrega e `duplicate` não auditam de novo.

### 25.6 Testes

- `supabase/tests/database/39_b3_2d2b2b3a_identidade_alterada.test.sql`
  (pgTAP, 47): estrutura e permissões; claim (token, lease, ambiente,
  estados); validação fechada; troca simples e auditoria; idempotência;
  conflitos (telefone novo, BSUID novo, BSUID substituído, anterior
  dividida); variantes da anterior e `identity_not_found` recuperável;
  vínculos comerciais preservados com revisão; `identity` →
  `review_required`; status do canal; ledger; rollback (falha simulada na
  conversa depois do ledger, do telefone e do BSUID); a guarda ainda
  bloqueia fora do efeito; isolamento; nada comercial e auditoria sem dado
  pessoal; `authenticated` sem EXECUTE; a lease conferida logo depois da
  última trava e antes da primeira escrita (47, §25.9).
- `tests/unit/b3-2d2b2b3a-identidade-alterada.test.ts` (47): validação do
  servidor, materiais separados (anterior sem cifra), AAD no escopo do
  claim, nenhum BSUID em claro nos argumentos, mapeamento de resultados e
  erros, resposta inesperada.
- `scripts/b3-2d2b2b3a-identity-concurrency-check.sh`: sete cenários com
  sessões Postgres reais — (1) duas trocas da mesma identidade para o mesmo
  telefone: `applied` + `duplicate`; (2) duas identidades para o mesmo
  telefone: `applied` + `identity_conflict`; (3) duas identidades para o
  mesmo BSUID novo: telefone e BSUID de identidades diferentes →
  `identity_conflict`; (4) pausa do canal durante o efeito: a pausa espera,
  e o claim usado depois vê `channel_paused`; (5) falha depois do ledger e
  antes da conversa: nada sobrevive; (6) lease vencida durante a espera
  por uma trava consultiva: `claim_lost`, nada escrito; (7) lease vencida
  durante a espera pela trava de linha da conversa: `claim_lost`, nada
  mudou (§25.9).
- `scripts/check-upgrade-b3-2d2b2b3a-identidade.sh`: atualização a partir
  da `20261030140000`.

Vermelho (PR temporária #263, só os testes sobre a main + a correção do
pgTAP): pgTAP 39 falhou 38 de 46; unitários, 46 dos 47 novos;
concorrência e atualização falharam porque a função não existia. Duas correções só de
teste vieram depois: o pgTAP comparava a liberação do claim sem tipo
(`f900218`) e o cenário 3 comparava o booleano como `t` em vez de `true`
(`2758413`). Verde: todo o CI na `2758413` (typecheck, lint, 2335
unitários, pgTAP inteiro, isolamento, e2e, as concorrências e as
atualizações).

### 25.7 Mutações

Cada mutação numa PR temporária, com o CI completo; todas fechadas sem
merge.

| Mutação | Pega por |
|---|---|
| M1 token do claim não conferido | pgTAP 5, 10, 14–16 |
| M2 lease não conferida (só a primeira) | sobreviveu: equivalente — a reconferência depois das travas devolve o mesmo `claim_lost`; substituída pela M2b (depois da §25.9, de novo equivalente; ver M24) |
| M2b lease ignorada antes e depois das travas consultivas | antes da §25.9: pgTAP 6, 10, 14–16, 18; concorrência 6. Depois: sobrevive — a conferência tardia devolve o mesmo `claim_lost` |
| M3 inbox de qualquer ambiente | pgTAP 7, 43 |
| M4 status do canal não reconferido | pgTAP 34, 36; concorrência 4 |
| M5 canal sem `FOR SHARE` | concorrência 4 (a pausa não esperou) |
| M6 sem a reserva do ledger | pgTAP 16, 32, 37–40 |
| M7 anterior inexistente criada | pgTAP 25, 26 |
| M8 telefone novo cria outra identidade | pgTAP (vários); concorrência 1 |
| M9 telefone de outra identidade aceito | pgTAP 21; concorrência (violação de unicidade) |
| M10 BSUID de outra identidade aceito | pgTAP 21, 22; concorrência 3 |
| M11 BSUID existente substituído | pgTAP 21 |
| M12 auto-merge (anterior dividida) | pgTAP 27, 28 |
| M13 vínculos comerciais apagados | pgTAP 30 |
| M14 telefone do contato atualizado | pgTAP 31, 44 |
| M15 conversa vinculada sem revisão | pgTAP 30 |
| M16 falha depois da reserva não desfaz | pgTAP 21, 25, 26, 39, 40; concorrência 5 |
| M17 telefone na auditoria | pgTAP 17, 44 |
| M18 `identity` aceita com a nova | pgTAP 11, 14–17, 19, 21, 22 |
| M19 `phone_number` aceito sem a nova | pgTAP 11 |
| M20 conflito de efeito ignorado | pgTAP 37–40 |
| M21 lease não reconferida depois das travas consultivas | antes da §25.9: concorrência 6. Depois: sobrevive — a conferência tardia devolve o mesmo `claim_lost`; **não** prova a proteção das travas de linha |
| M22 sem as travas consultivas | concorrência (as sessões não esperaram) |
| M23 lease não reconferida depois das travas de linha (as duas anteriores mantidas) | pgTAP 47; concorrência 7 (veio `applied`) |
| M24 nenhuma das três conferências da lease | pgTAP 6, 10, 14–16, 18, 47; concorrência 6 |

### 25.8 Fora do escopo, decisões e riscos

Fora desta PR: eventos de conta e a mudança automática do status do canal
por eles (B3.2d-2b2b3b); a ligação do consumidor (B3.2d-2b3); o
reconciliador; envio; mídia; interface; configuração externa; o chatbot;
migrations hospedadas.

Decisões:
- a guarda das identidades ganha uma exceção controlada, em vez de uma
  segunda identidade para o telefone novo;
- a identidade anterior não recebe cifra (só é procurada);
- `review_required` é resultado próprio e grava o ledger: o provedor
  confirmou uma mudança, mas sem informação para uma alteração segura;
- auditoria só quando algo muda.

Riscos e divergências:
- **o telefone do contato comercial não é atualizado automaticamente:**
  a conversa vai para revisão, e um humano decide;
- **evento `identity` sem a nova** exige revisão humana;
- **`identity_not_found`** fica para reconciliação (B3.2e): o claim é
  liberado pela B3.2d-2b3 e a entrada volta a ser tentada;
- **não existe fusão automática de identidades;**
- **formatos reais da YCloud ainda a confirmar:** em especial, se o
  `user_changed_number` sempre traz o telefone novo. O normalizador hoje
  pode produzir um `phone_number` cuja nova identidade só tem BSUID (sem
  `wa_id`/`new_wa_id`); o efeito recusa esse caso (`invalid_identity_change`),
  e o alinhamento fica para quando o webhook real mostrar o formato;
- **a mesma troca por outro evento** só é reconhecida como `duplicate`
  quando o BSUID anterior identifica a identidade; só pelo telefone antigo
  (que já saiu), ela vira `identity_not_found`.

### 25.9 Revisão: lease vencida na espera por uma trava de linha

**Janela encontrada na revisão da PR #262.** A lease era conferida antes e
depois das travas consultivas, mas depois disso ainda vinham os `FOR
UPDATE` da identidade anterior e da conversa. Essas travas de linha podem
esperar uma transação que não passa pelas travas consultivas (qualquer
outra escrita na conversa, por exemplo), e a lease pode vencer nessa
espera. Ao receber as linhas, o efeito alterava identidade, conversa,
auditoria e inbox com a lease já vencida. A M21 e o cenário 6 só provavam
a espera na trava consultiva.

**Teste primeiro (`a58deaa`), vermelho na PR temporária #287:**
- concorrência, cenário 7: uma sessão segura a linha da conversa com
  `SELECT id FROM public.conversations WHERE id = <conversa> FOR UPDATE`
  e dorme 5 s, sem trava consultiva; a lease da entrada passa a vencer em
  2 s; o efeito (`phone_number` para um telefone e um BSUID novos, numa
  conversa vinculada a contato, lead e oportunidade fictícios) começa e o
  script confirma que ele espera uma trava de linha (`wait_event_type =
  Lock`, `transactionid` ou `tuple`) bloqueado justamente por essa sessão
  (`pg_blocking_pids`), e que a lease vence enquanto ele ainda espera; só
  então a linha é solta. Sem a correção veio `applied`;
- pgTAP 47 (estrutural, sobre o corpo da função sem comentários): a
  identidade e a conversa são travadas; o comando logo depois da **última**
  aquisição de trava da função é `v_now := clock_timestamp()` seguido da
  conferência da lease; nenhuma escrita entre essa trava e a conferência,
  e há escrita depois. Uma comparação com `lease_until` em qualquer outro
  ponto não basta. Sem a correção: `true false false`.

**Correção (`5d6eb5f`), na própria migration nova:** depois de travar a
identidade e a conversa, a chave do workspace é travada `for key share` (a
auditoria a referencia, e assim nenhuma escrita abaixo espera depois da
conferência); em seguida, um ponto comum aos dois caminhos (`phone_number`
e `identity`) faz `v_now := clock_timestamp()` e, com a lease nula ou
vencida, `claim_lost`. O resultado desfaz o bloco (reserva do ledger e
qualquer alteração intermediária); a lease não é renovada, nenhum claim
novo é obtido e a entrada não é finalizada nem liberada. O `processed_at`
das execuções válidas passa a usar esse horário, e não o de antes de uma
espera longa.

**Depois do `claim_lost` do cenário 7, nada ficou:** a linha da
identidade e a da conversa (com contato, lead, oportunidade e revisão)
iguais às de antes, byte a byte (`row_to_json`); nenhuma auditoria da
identidade ou da conversa; nenhum ledger da entrada; a entrada em
`processing` com o mesmo token, `claimed_at` e `lease_until`; o telefone e
o BSUID novos em nenhuma identidade; o cadastro comercial com as mesmas
contagens.

**Mutação específica:** a M23 tira só a conferência tardia e mantém a
inicial e a de depois das travas consultivas: o pgTAP 47 e o cenário 7
(`applied`) a pegam. Com a conferência tardia, a M2, a M2b e a M21
passaram a sobreviver (ela devolve o mesmo `claim_lost`); a M24, que tira
as três, é pega pelo pgTAP 6, 10, 14–16, 18 e 47 e pelo cenário 6.

**Verde (`5d6eb5f`):** CI completo — typecheck, lint, 2335 unitários,
pgTAP inteiro (o 39 com 47), isolamento, e2e, todas as concorrências
(cenários 1 a 7) e todas as atualizações. As regressões continuam
cobertas pelos mesmos testes: a anterior nunca é criada (pgTAP 25, 26),
nenhuma fusão (27, 28), o telefone novo na mesma identidade (15),
conflitos atômicos (21; concorrência 2 e 3), o telefone do contato
intacto (31, 44), a conversa vinculada em revisão (30), `identity` só
marcando revisão (32, 33), auditoria sem dado pessoal (17, 44), a pausa
esperando o efeito (concorrência 4) e a falha depois do ledger desfazendo
tudo (39, 40; concorrência 5).


## 26. B3.2d-2b2b3b — eventos operacionais da conta e do número (30/10/2026)

A **B3.2d-2b2b3a** (§25) foi mesclada na PR #262 (merge `ff13405`, pais
`d8f7357` e `9a73c41`). Esta etapa aplica um `NormalizedAccountEvent`
(`kind: "account"`, escopo `business_account` ou `phone_number`) ao canal da
entrada da inbox: **registra** o evento operacional da conta WhatsApp e do
número e **reflete no estado do canal só as desconexões inequívocas**. Não
envia mensagem, não configura nem chama a YCloud, não cria canal real, não
altera o chatbot e **não liga o consumidor** (B3.2d-2b3). Nada desta etapa
liga a YCloud real.

### 26.1 O que é observado e o que desconecta

| Tipo do provedor | Escopo | Efeito no canal |
|---|---|---|
| `whatsapp.phone_number.deleted` | `phone_number` | **desconecta** (§26.7) |
| `whatsapp.business_account.deleted` | `business_account` | **desconecta** (§26.7) |
| `whatsapp.business_account.updated` | `business_account` | só observado |
| `whatsapp.business_account.reviewed` | `business_account` | só observado |
| `whatsapp.phone_number.name_updated` | `phone_number` | só observado |
| `whatsapp.phone_number.quality_updated` | `phone_number` | só observado |
| `whatsapp.phone_number.business_username_updated` | `phone_number` | só observado |
| qualquer outro tipo com o prefixo do escopo | — | só observado (lista aberta) |

- **Só os dois tipos de exclusão mudam o canal.** O `code` do provedor é um
  valor **opaco**: nada o interpreta para ativar, reconectar, bloquear envio
  ou decidir qualidade (um evento de qualidade "vermelha", de nome recusado
  ou com o código `DISCONNECTED` não muda nada).
- **Não existe reativação automática** nesta PR: nenhum evento religa o
  canal, e `disabled` nunca é reativado nem rebaixado.
- O tipo precisa ter o prefixo do escopo (`whatsapp.phone_number.` para
  `phone_number`, `whatsapp.business_account.` para `business_account`), e
  só vale o tipo gravado na entrada da inbox: um tipo de exclusão com o
  escopo trocado (que passaria só pela conferência da conta, sem routing
  key) é recusado.

### 26.2 Referência técnica da conta no canal

`whatsapp_channels.provider_account_ref text` (anulável), uma referência
**neutra** da conta do provedor.

- **Imutável depois da criação:** a guarda do canal passa a barrar qualquer
  troca (valor → outro, valor → nulo e também nulo → valor). Um canal real
  deverá gravá-la **quando for criado**; esta etapa não cria canal real nem
  tela.
- **Nunca derivada da routing key:** o domínio não divide nem interpreta a
  routing key da YCloud (`<waba>:<telefone>`); a referência vem à parte.
- **Formato neutro:** letras, dígitos, ponto, sublinhado e hífen, até 64
  caracteres, sem espaço nem controle; e só canal da B3 (com ambiente) a
  tem, de modo que a linha legada da A7, legível por SELECT direto, nunca a
  carrega.
- **Canais legados e simulados continuam com `NULL`**; a migration não
  altera nenhum canal existente.
- **Nunca exposta** em resposta pública, erro, log ou auditoria: a leitura
  segura do canal (`whatsapp_channel_safe_row`) continua montada campo a
  campo e não a inclui.
- **Necessidade de uma referência confiável:** sem ela o canal não tem como
  confirmar de qual conta vem o evento; ver `account_reference_unverified`
  (§26.6).

### 26.3 Datas operacionais do canal

- `last_event_at`: o maior `occurredAt` de qualquer evento operacional
  **aceito** (registrado, inclusive `stale_event`).
- `provider_status_event_at`: o horário, no relógio do **provedor**, do
  último evento que efetivamente **decidiu** o estado do canal (a exclusão
  que o desconectou).
- **Nenhuma das duas regride nem volta a nulo:** a RPC só as avança, e a
  guarda do canal barra (`channel_clock_regression`) até a escrita direta.
- `status_changed_at` continua sendo o relógio do **CRM**; não ordena evento
  do provedor.

### 26.4 `whatsapp_channel_events` (modelo final)

Deny-all (RLS ligada e forçada, nenhum privilégio para `anon`,
`authenticated` nem `service_role`, quatro políticas que negam
`authenticated`); só a RPC do efeito escreve.

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` | chave interna |
| `inbox_id` | `uuid` | única: um evento operacional por entrada |
| `workspace_id` | `uuid` | `ON DELETE CASCADE` com o workspace |
| `channel_id` | `uuid` | |
| `environment` | `whatsapp_environment` | |
| `provider` | `whatsapp_provider` | |
| `provider_event_id` | `text` | mesmo formato do ledger |
| `provider_type` | `text` | tipo bruto, formato conferido, até 128 |
| `scope` | `text` | `business_account` ou `phone_number` |
| `code` | `text` nulo | opaco, 1 a 64 caracteres, sem caractere de controle |
| `occurred_at` | `timestamptz` | horário do provedor, finito |
| `result` | `text` | `applied`, `recorded` ou `stale_event` |
| `created_at` | `timestamptz` | |

- **FKs compostas:** `(workspace_id, channel_id, environment, provider)` →
  canal (`ON DELETE RESTRICT`) e `(inbox_id, workspace_id, channel_id,
  environment, provider, provider_event_id)` → inbox (sem ação na remoção,
  como o ledger). Inbox, workspace, canal, ambiente, provedor e id do
  evento são do **mesmo evento**; a remoção da inbox de um evento
  preservado é impedida, e o expurgo do corpo cifrado só deixa o tombstone,
  que continua referenciado.
- **Não grava:** telefone, routing key, referência da conta, payload,
  texto, BSUID, segredo, credencial nem cifra da inbox. O telefone do
  escritório (`businessPhoneE164`) é só validado no servidor e **nem chega
  ao banco**.

### 26.5 A RPC e a ordem, numa transação só

`public.whatsapp_effect_account_event(p_inbox_id, p_claim_token, p_scope,
p_provider_type, p_provider_account_ref, p_routing_key, p_occurred_at,
p_code) → jsonb`. SECURITY DEFINER, `search_path` vazio, EXECUTE só para
`service_role`. Nenhum usuário, workspace, canal, papel ou ambiente vem do
chamador; a resposta é só `{"outcome": ...}`.

1. validação fechada (`invalid_account_event`, antes de qualquer trava:
   escopo, tipo e prefixo, conta, data, `code`, routing key obrigatória no
   escopo do número e proibida no da conta);
2. inbox do ambiente autenticado `FOR UPDATE`; `processing`, token e lease
   vigentes; o tipo informado tem de ser o gravado na entrada;
3. canal da linha `FOR UPDATE`, em **qualquer** estado (pausado,
   desconectado e desativado não bloqueiam este efeito);
4. workspace protegido (`FOR KEY SHARE`), porque as gravações referenciam a
   chave dele;
5. **a lease é conferida de novo**, com o relógio de agora, logo depois da
   última trava e antes da primeira escrita; o `processed_at` e o
   `status_changed_at` usam este horário (§25.9: a mesma lição da B3.2d-2b2b3a);
6. reserva do ledger com o efeito estável **`account`**;
7. validação do destino (§26.6);
8. gravação do evento operacional e avanço de `last_event_at`;
9. eventual transição do canal (§26.7);
10. auditoria **somente se o estado do canal realmente mudou**;
11. inbox `processed` na mesma transação.

As divergências de destino e o `effect_conflict` voltam como resultado
depois de desfazer o bloco (ledger incluído); qualquer outra falha propaga e
desfaz tudo. A lease vencida na espera por uma trava de linha devolve
`claim_lost` sem ter escrito nada. O ledger usa o efeito `account` (o mesmo
nome do `kind` do contrato neutro e já presente no vocabulário do ledger
desde a B3.2d-2b1) em vez de um nome novo: nenhuma constraint existente é
alterada.

### 26.6 Validação do destino

| Escopo | Regra | Divergência |
|---|---|---|
| `phone_number` | `routingKey` obrigatória e **exatamente igual** à `routing_key` do canal (maiúsculas e espaço contam) | `routing_mismatch` |
| ambos | `providerAccountRef` **igual** à `provider_account_ref` do canal | `account_reference_mismatch` |
| ambos | canal **sem** `provider_account_ref` confiável | `account_reference_unverified` |
| `business_account` | `routingKey` e `businessPhoneE164` **nulos**; a conta nunca é deduzida da routing key | — |

A routing key é conferida antes da conta. Nas três divergências nada é
gravado, nenhum ledger permanece e a inbox continua em `processing` com o
mesmo claim: a B3.2d-2b3 decide falhar ou liberar. O módulo do servidor **não
compara** routing key nem conta: repassa ao banco, que decide.

### 26.7 Regras finais de transição do canal

Resultados do evento de **exclusão** (os dois tipos), na ordem em que são
avaliados:

| # | Condição | Resultado | Canal |
|---|---|---|---|
| 1 | `provider_status_event_at` existe e `occurredAt` ≤ ele | `stale_event` | inalterado, sem auditoria |
| 2 | canal `active` ou `paused` | `applied` | `disconnected`, `send_enabled = false`, `provider_status_event_at = occurredAt`, `status_changed_at` = horário do CRM, auditoria |
| 3 | canal `disconnected` ou `disabled` | `recorded` | inalterado (`disabled` nunca é reativado nem rebaixado), sem auditoria |

Todo evento aceito grava a linha em `whatsapp_channel_events` e avança
`last_event_at` (sem regredir). Os tipos só observados dão sempre
`recorded`, qualquer que seja o estado do canal e o `code`. Um evento
antigo nunca regride o estado nem as datas, mesmo que o canal tenha sido
religado depois por outro meio (reconexão futura): o antigo é `stale_event`
e um mais novo volta a desconectar, com nova transição auditada.

### 26.8 Resultados (contrato fechado)

| Resultado | Quando |
|---|---|
| `applied` | exclusão válida: o canal passou para `disconnected` |
| `recorded` | evento gravado sem mudar o status |
| `stale_event` | exclusão antiga demais para decidir o estado: gravada |
| `duplicate` | o efeito já estava no ledger para esta entrada: inbox `processed` |
| `routing_mismatch`, `account_reference_mismatch`, `account_reference_unverified` | §26.6; nada gravado; claim continua |
| `effect_conflict` | a chave estável já tem outro efeito ou entrada; nada gravado |
| `already_processed`, `terminal_failed`, `claim_lost`, `not_found` | como na finalização da B3.2d-1; nada muda |

Não há resultado `channel_*`: o estado do canal não bloqueia este efeito.
O módulo `src/server/whatsapp/effects/account-event.ts` conhece só o
contrato neutro (`NormalizedAccountEvent`), valida o evento (e o telefone
do escritório, que não vai ao banco), confere que o evento é o da entrada do
claim e devolve o resultado conferido campo a campo; erros saem só como
código.

### 26.9 Auditoria

Só quando o canal realmente muda: `whatsapp.channel.disconnected`, recurso
`whatsapp_channel`, `actor_user_id` nulo, metadados `source =
whatsapp_webhook`, `environment`, `provider`, `scope`, `provider_type`,
`from_status`, `to_status` e `send_enabled_before`. Nunca a referência da
conta, a routing key, telefone, `code` ou cifra. Reentrega, `recorded`,
`stale_event` e `duplicate` não auditam.

### 26.10 Testes

- `supabase/tests/database/40_b3_2d2b2b3b_eventos_conta.test.sql` (pgTAP,
  65): assinatura, SECURITY DEFINER e EXECUTE só para `service_role`; a
  tabela de eventos (colunas exatas, deny-all, quatro políticas,
  `service_role` sem SELECT direto, FKs compostas, unicidade, CHECKs de
  tipo, escopo, resultado e `code`, remoção da inbox e do canal impedida);
  a referência imutável, o formato e a leitura segura sem a referência;
  datas que não regridem; claim (token, lease, ambiente, estados);
  validação fechada (30 entradas, mais o tipo de um escopo com o escopo do
  outro); destino (routing key exata, conta, `unverified`, conta nunca
  deduzida da routing key, nada gravado, entrada reaproveitável); as
  exclusões (ativo, pausado, já desconectado, desativado, `stale_event`,
  sequência, canal religado, só o canal da inbox); os tipos só observados e
  o `code` opaco; o que fica gravado e a auditoria sem dado pessoal; a
  resposta só com o `outcome`; reentrega, `duplicate` e `effect_conflict`;
  rollback (falha ao gravar o evento e ao desconectar o canal); nada
  comercial; ambiente oposto; `authenticated` e `anon` sem EXECUTE; A7
  intacta; o corpo da função (a lease conferida logo depois da última trava
  e antes da primeira escrita; a ordem das travas; nada de dividir a routing
  key, tocar dado comercial ou bloquear por estado do canal).
- `tests/unit/b3-2d2b2b3b-eventos-conta.test.ts` (78): argumentos exatos
  (sem workspace, canal, ambiente, provedor, id do evento nem telefone do
  escritório); eventos reais normalizados pelo adaptador YCloud (só no
  teste) aceitos pelo contrato neutro; entrada inválida nunca chega ao
  banco; contrato fechado de resultados; erros sanitizados; o módulo não
  importa o adaptador, não divide a routing key e não registra log; o
  consumidor, a rota do webhook e o chatbot não chamam o efeito.
- `scripts/b3-2d2b2b3b-account-event-concurrency-check.sh`: seis cenários
  com sessões Postgres reais, uma delas segurando a linha do canal
  (`SELECT ... FOR UPDATE`) para que as execuções esperem juntas, em ordem
  de chegada — ver §26.11.
- `scripts/check-upgrade-b3-2d2b2b3b-eventos-conta.sh`: atualização a partir
  da `20261030160000`; leituras da A7, linhas e contagens idênticas, canais
  antigos sem referência nem datas, tabela de eventos vazia; a entrada de
  conta gravada antes é recusada (`account_reference_unverified`) sem gravar
  nada; um canal novo, criado com a referência, desconecta só ele; a guarda
  continua.

**Vermelho** (PR temporária #294, só os testes sobre a main
`ff13405`): unitários, 76 dos 78 novos falharam; pgTAP 40, 61 de 64
(função, tabela e colunas inexistentes); concorrência e atualização
falharam por a coluna e a função não existirem. Depois vieram só ajustes
dos próprios testes (`b21331f`), a correção dos tipos gerados do CI
(`0ad3d5e`) e um teste a mais, por causa da mutação X03 (`72bf4cf`).
**Verde:** CI completo na `72bf4cf` (run 41154398049): typecheck, lint, 2414 unitários
em 114 arquivos, tipos gerados em dia, pgTAP inteiro (40 arquivos, 2020
testes; o 40 com 65 de 65), isolamento, e2e (76), todas as concorrências
(inclusive os nove cenários desta etapa) e todas as atualizações; Vercel
verde.

### 26.11 Concorrência real

Cada cenário com sessões Postgres separadas; uma segura a linha do canal
(ou do workspace) para as demais esperarem juntas.

| # | Cenário | Resultado |
|---|---|---|
| 1 | o mesmo evento duas vezes | `applied` + `already_processed`; uma linha operacional, um ledger, uma auditoria |
| 2 | duas exclusões simultâneas (entradas diferentes) | `applied` + `recorded`; `disconnected`, `send_enabled=false`; duas linhas operacionais e **uma** auditoria da transição |
| 3 | evento antigo depois de um de estado mais novo | `applied` + `stale_event`; estado e datas não regridem; o antigo fica preservado |
| 4a | pausa administrativa antes da exclusão | a exclusão vê `paused` e desconecta; as duas auditorias existem |
| 4b | exclusão antes da pausa | a pausa vê `disconnected` e é recusada (`invalid_channel_state`); sem deadlock |
| 5a | a lease vence na espera pela linha do **canal** | `claim_lost`; nenhum evento, ledger, auditoria ou mudança no canal; a entrada segue em `processing` com o mesmo claim |
| 5b | a lease vence na espera pela linha do **workspace** | idem |
| 6a | falha depois do ledger (ao gravar o evento) | nada sobrevive; sem a falha, a mesma entrada aplica |
| 6b | falha depois do evento (ao desconectar o canal) | nada sobrevive; sem a falha, a mesma entrada aplica |

Nos cenários 5a e 5b o script confirma que o efeito espera uma trava **de
linha** (`wait_event_type = Lock`, `transactionid` ou `tuple`) bloqueado
justamente pela sessão que a segura (`pg_blocking_pids`), que a lease vence
enquanto ele ainda espera, e só então solta a linha. O efeito usado é um
tipo só observado: sem a conferência tardia ele gravaria o evento
(`recorded`).

### 26.12 Mutações

Cada mutação altera só a migration, numa execução própria, e é desfeita
depois. Rodadas **localmente** (Postgres real, o pgTAP 40 e, para as de
trava e lease, a concorrência) e em **PRs temporárias** com o CI completo
(#295 a #318), todas fechadas sem merge.

| Mutação | PR temporária | Pega por (CI) |
|---|---|---|
| M01 referência da conta não conferida | #295 | pgTAP 29–32, 50 |
| M02 routing key não conferida | #296 | pgTAP 29–32 |
| M03 conta deduzida da routing key (`split_part`) | #297 | pgTAP 29–31, 65; atualização |
| M04 exclusão não desliga `send_enabled` | #298 | pgTAP 32, 33, 35, 40–42, 55, 57, 59; concorrência 1; atualização |
| M05 evento que não é exclusão desconecta o canal | #299 | pgTAP 43–45 |
| M06 canal `disabled` vira `disconnected` | #300 | pgTAP 37, 38, 40; concorrência 2 |
| M07 evento antigo decide o estado (sem `stale_event`) | #301 | pgTAP 39–41; concorrência 3 |
| M08 `last_event_at` regride (na RPC e na guarda) | #302 | pgTAP 16, 40, 41, 44; concorrência 3 |
| M09 `provider_status_event_at` regride (sem `stale_event` e sem a guarda) | #303 | pgTAP 16, 39–41; concorrência 3 |
| M10 status alterado sem auditoria | #304 | pgTAP 33, 35, 36, 40, 41, 48, 49, 51, 57; concorrência 1; atualização |
| M11 auditoria com conta, routing key e `code` | #305 | pgTAP 48, 49 |
| M12 tabela operacional guarda a routing key | #306 | pgTAP 4, 47; tipos gerados |
| M13 FK da inbox confere só `inbox_id` | #307 | pgTAP 8, 11; tipos gerados |
| M14 token do claim ignorado | #308 | pgTAP 19, 24, 26–28 |
| M14b lease ignorada (as duas conferências) | #309 | pgTAP 20, 24, 27, 28, 63, 64; concorrência 5 |
| M15 só a conferência tardia da lease removida (a inicial mantida) | #310 | pgTAP 63, 64; concorrência 5 |
| M16 canal sem `FOR UPDATE` | #311 | pgTAP 64; concorrência 2 |
| M17 efeito aplica no ambiente oposto | #312 | pgTAP 21, 59, 64 |
| M18 divergência de destino deixa o ledger | #313 | pgTAP 29–32; atualização |
| M19 função liberada para `authenticated` | #314 | pgTAP 3, 60 |
| M20 tabela liberada para `service_role` (SELECT) | #315 | pgTAP 5, 6 |
| X01 workspace sem a trava da chave | #316 | pgTAP 63, 64; concorrência 5 |
| X02 tipo do evento não conferido com a inbox | #317 | pgTAP 26–28 |
| X03 tipo e escopo sem o prefixo | #318 | pgTAP 28 |

M14b e X01 a X03 são acréscimos às vinte pedidas. Outras seis (X04 a X09: referência mutável na guarda, `code` interpretado, resposta que devolve a conta, ledger com outro efeito, inbox não finalizada, evento só registrado que não avança `last_event_at`) foram rodadas só localmente, no Postgres real, e todas pegas pelo pgTAP 40 (14; 44; 50; 34, 52, 63; 34, 38, 51; 37, 38, 40, 43–45). **Nenhuma mutação sobreviveu.** A conferência tardia da lease e a trava do canal são provadas pelo pgTAP 63 e 64 e pela concorrência (5a, 5b e 2).

### 26.13 Fora do escopo, decisões, riscos e divergências

Fora desta PR: a ligação do consumidor (B3.2d-2b3), o reconciliador e o
batimento do canal (B3.2e), configuração real da YCloud, criação real de
canal (e a tela para isso), reconexão automática, alertas, retenção, C1,
envio, mídia, interface, chatbot e migrations hospedadas.

Decisões:
- o ledger usa o efeito **`account`**, já existente no vocabulário (igual ao
  `kind` do contrato neutro), em vez de um nome novo: nenhuma constraint do
  ledger é alterada;
- o telefone do escritório (`businessPhoneE164`) é validado no servidor e
  **não vai ao banco**: o domínio não precisa dele, e ele nunca chega a uma
  tabela, log ou auditoria;
- o tipo informado só vale se for o gravado na inbox, e o prefixo do tipo
  tem de ser o do escopo;
- a lista de tipos é aberta para o registro (só os dois de exclusão
  decidem o estado);
- o canal é travado `FOR UPDATE` (não `FOR SHARE`): é a única forma de duas
  exclusões, ou de uma pausa e uma exclusão, esperarem uma pela outra e a
  segunda reler o estado final;
- uma exclusão que chega com o canal **já desconectado** é só registrada e
  **não** avança `provider_status_event_at` (ele marca o evento que
  decidiu o estado).

Riscos e divergências:
- **canal sem `provider_account_ref`** (todo canal simulado e legado): todo
  evento volta `account_reference_unverified`, nos **dois** escopos. A
  especificação só nomeia o escopo da conta; estendi o mesmo resultado ao
  escopo do número, porque a routing key sozinha não prova de qual conta o
  evento vem;
- **a referência é imutável, inclusive de nulo para um valor:** um canal
  real tem de gravá-la na criação; o canal criado sem ela não pode ganhá-la
  depois (o criador do canal real da YCloud deve registrá-la desde o
  início);
- **`occurredAt` é o relógio do provedor:** um horário muito à frente
  tornaria atrasadas as exclusões seguintes (viram `stale_event`). O
  evento chega autenticado pela assinatura e o contrato não define teto;
  um limite fica como decisão futura;
- **os testes 63 a 65 do pgTAP 40 leem o texto do corpo da função** (sem
  comentários e com o espaço normalizado): uma reescrita do corpo exige
  atualizá-los junto;
- **a B3.2d-2b3 precisa decidir** o que fazer com `routing_mismatch` e
  `account_reference_*` (falhar ou liberar) e mapear `stale_event`,
  `recorded` e `applied` como entrada finalizada.
