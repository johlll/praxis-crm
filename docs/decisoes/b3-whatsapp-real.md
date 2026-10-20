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
| Número desconhecido = cliente novo (§6) | Eventos de histórico, ecos do celular e contatos já atendidos pelo chatbot não podem criar lead nem atividade |
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
| `whatsapp_webhook_inbox` (nova) | Corpo cifrado (chave própria, §7.1), hash, id do evento, tipo, estado, tentativas, prazo de retenção; única por `(channel_id, provider_event_id)` |
| `conversations` | `wa_id` passa a opcional; `wa_user_id` (BSUID) opcional; ao menos um dos dois; unicidade por canal e identidade; `last_inbound_at` (janela) |
| `contact_identifiers` | Novo provedor `whatsapp_bsuid`; vínculo de troca de número pelos eventos de sistema |
| `messages` | `origin` (`crm`, `business_app`, `chatbot`, `history`, `inbound`, `internal`; decisões 11 e 14); `provider_message_id`; `wa_message_id` opcional até a aceitação; `body_text` opcional com mídia; `sent_by` e `client_dedupe_key` exigidos só para `origin = 'crm'`; `template_name`, `template_language`, `template_category` (a final, conferida no envio); custo devolvido pelo provedor (categoria, modelo, valor, moeda, `cost_is_final`); `content_purged_at` |
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
- O CRM **exibe** as mensagens do chatbot com `origin = 'chatbot'` e o
  rótulo "chatbot/automação" (decisão 11), de preferência pelo evento
  que a YCloud entrega ao endpoint do CRM (portões P3/P4, §6.7), sem nunca
  interpretá-las nem criar lead a partir delas.
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
21. Nenhum evento do chatbot, do histórico ou do eco do celular cria lead,
    atividade ou automação comercial.
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
| 11 | Leads e mensagens do chatbot | **Aprovada** (20/10/2026) | O Praxis **exibe** as mensagens enviadas pelo chatbot, com origem visual e técnica "chatbot/automação". **Só mensagem recebida de pessoa externa** pode criar lead, e só depois de procurar contato, lead ou cliente existente, sem duplicar. Identidade ambígua, BSUID não resolvido ou possível número interno viram **pendência de identificação**, sem criação por palpite. Mensagem do chatbot, eco do celular, histórico, status, comando interno ou evento técnico nunca criam lead nem atividade. Automação do status comercial fica na C1. As mensagens do chatbot vêm de preferência do evento da YCloud no segundo endpoint (P3/P4); se ele não existir, a alternativa é documentada antes de implementar, sem trabalho síncrono no webhook do chatbot (§15.10) | Conversa completa no CRM, sem lead duplicado nem lead criado por evento técnico | — |
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
| Classificação de origem: cliente, celular, chatbot (`chatbot`), histórico e identidade interna | Criar | Praxis (B3.2) |
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

**Chatbot → Praxis** (fase posterior, decisão 12; fora da primeira PR da
B3.2):
- **Mensagens, ecos, status e mídia** chegam ao Praxis direto da YCloud
  (opção 1); o chatbot não repassa conteúdo.
- **Estado da conversa:** o chatbot só avisa as mudanças de estado
  (`handoff_pending`, `human_active`, `ai_active`, pausa geral), com
  `event_id` (idempotência), `state_version` monotônica e envio por outbox
  no chatbot, com reentrega.
- **Ack:** o Praxis responde 200 só depois de gravar.
- **Mensagens do bot (só se o P3 falhar):** o chatbot avisa os ids das
  mensagens que enviou (origem `chatbot`), sem texto. Exige a alternativa
  documentada e aprovada antes (§15.10).
- **Resumo e qualificação (decisão 12):** só depois de a entrada real
  ficar estável. Vão apenas dados estruturados necessários, com contato ou
  lead identificado, origem "chatbot", versão, data e chave de
  idempotência. Nunca prompt, raciocínio interno, logs internos ou a
  conversa completa sem necessidade.

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
  bot (P3). Mitigação: aviso do chatbot com os ids (§15.6) ou
  reconciliação pela API da YCloud.
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
| B3.2a | Adaptador YCloud puro: assinatura sobre bytes (`t=,s=`), normalização de entrada, eco, status, histórico (ignorado) e eventos de conta a partir de exemplos oficiais; identidade telefone e/ou BSUID; sem rede | — |
| B3.2b | `whatsapp_webhook_inbox` cifrada (chave e AAD próprias), única por (canal, id do evento), com prazo de retenção; RPC de gravação; pgTAP | B3.2a |
| B3.2c | Rota `/api/webhooks/whatsapp/[provider]`: bytes → assinatura → canal pela resolução do webhook (§14.6) → inbox → 2xx → Inngest; 404 sem provedor | B3.2b |
| B3.2d | Função Inngest e RPCs de serviço: mensagem, eco, status, eventos de conta; origem `contact`, `business_app`, `chatbot` (automação), `history` ou `internal`; cadastro de identidades internas (telefone e BSUID; owner/admin); busca antes de criar lead; pendência de identificação; nada de lead ou atividade para bot, eco, histórico, status, comando interno ou evento técnico; teste de concorrência | B3.2c |
| B3.2e | Reconciliador da inbox parada e batimento do canal (`last_event_at`) | B3.2d |
| Fora do Praxis | Contrato do §15.6 no chatbot (rota, tabela de pedidos, testes), em branch/PR própria do chatbot, desligado e sem deploy | Decisão 15; implantação real com nova autorização; necessário antes da B3.3 no número do chatbot |
| Posterior | Resumo e qualificação estruturados do chatbot (decisão 12) | Entrada real estável |

Ligar um endpoint real da YCloud continua dependendo de P1–P4 e de
autorização.

### 15.10 Regras aprovadas para a B3.2 (decisões 10 a 15)

**Exibição das mensagens do chatbot (decisão 11):**
- origem técnica `chatbot` e rótulo visual "chatbot/automação";
- fonte preferida: o `message.updated` entregue pela YCloud ao endpoint
  do Praxis (portões P3/P4);
- se esse evento não chegar ao segundo endpoint, a alternativa é
  documentada e aprovada **antes** de implementar. Ela nunca acrescenta
  trabalho síncrono ao webhook do chatbot nem faz o chatbot repassar o
  tráfego que recebe (decisão 10).

**Criação de lead (decisão 11):**
- só por mensagem recebida, ao vivo, de pessoa externa identificada;
- antes de criar, busca de contato, lead ou cliente existente por
  telefone normalizado e BSUID, sem duplicar;
- identidade ambígua, BSUID não resolvido ou possível identidade interna
  viram **pendência de identificação** para decisão humana;
- nunca criam lead nem atividade:
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
- mensagens, comandos, ecos e status dessas identidades ficam registrados
  como internos, sem contato, lead ou atividade de cliente;
- testes e documentos usam só números fictícios.

**Passagem e vencimento (decisões 13 e 15):** ver §15.6. O CRM não envia no
número do chatbot até o portão P7 fechar.

**Resumo e qualificação (decisão 12):** fase posterior, fora da primeira PR
da B3.2.
