# B2 — Integração com Google Agenda: plano consolidado

Status: **plano aprovado para consolidação documental; nada implementado.**
Não há credencial criada, usuário criado, licença contratada nem serviço
externo configurado. Escopo: B2 do plano (§10 e marco B). A B1 não é
reaberta; o chatbot é um projeto separado e fica fora.

Data das verificações na documentação oficial: 08/10/2026. O que não foi
confirmado está marcado como **a validar**.

## 1. Decisões já tomadas

1. Primeira conexão: a conta do Henrique (`j.henrique@vizentiniadvocacia.com.br`,
   Google Workspace), autorizada por ele via OAuth. Ele escolhe a agenda.
2. Sincronização nos dois sentidos, **só para compromissos vinculados ao
   CRM**: criação, reagendamento e cancelamento. Eventos pessoais ou externos
   nunca viram lead nem atividade; só bloqueiam disponibilidade.
3. Google Meet opcional ao criar o compromisso.
4. Cada usuário com permissão apropriada conecta a própria conta (§8).
5. Preview e Production isolados em conexões, tokens, canais, tarefas e
   efeitos sobre compromissos, mesmo compartilhando o Supabase (§7).
6. Validação inicial com conta e calendário **dedicados de teste**; a agenda
   real do Henrique entra numa etapa controlada posterior.
7. Convidados desativados por padrão (§6.6).

## 2. O que a documentação oficial confirma

| Tema | Fato (fonte: developers.google.com/workspace/calendar) |
|---|---|
| Webhook | Endereço HTTPS com certificado SSL válido. A notificação **não tem corpo**: só cabeçalhos (`X-Goog-Channel-ID`, `X-Goog-Resource-State`, `X-Goog-Message-Number`, `X-Goog-Channel-Token` se definido). Nenhuma verificação de domínio é citada. |
| Canal | Sem renovação automática: é preciso criar outro com `watch` antes do vencimento. A duração vem do pedido ou do limite interno do Google, o mais restritivo; **não há TTL fixo documentado**, vale sempre o `expiration` devolvido. |
| Primeira mensagem | `sync` com `X-Goog-Message-Number: 1` ao criar o canal. |
| `syncToken` | **Incompatível** com `iCalUID`, `orderBy`, `privateExtendedProperty`, `q`, `sharedExtendedProperty`, `timeMin`, `timeMax`, `updatedMin`. Parâmetros idênticos do sync inicial em diante, senão `400`. `showDeleted` não pode ser `false`: eventos apagados vêm sempre. `nextSyncToken` só vem na última página. `410` = descartar o estado local e refazer o sync completo. |
| Escritas | `If-Match` com o `etag`: se mudou, `412`; a orientação é reler e reaplicar. |
| Meet | `conferenceData.createRequest` com `requestId` novo e `conferenceDataVersion=1`; criação assíncrona (`pending` → `success`). Antes de habilitar conferência em app que guarda eventos, fazer sync completo. |
| Escopos | Mais estreitos: `calendar.events.owned` (eventos de agendas **das quais o usuário é dono**), `calendar.freebusy`, `calendar.calendarlist.readonly`. O escopo amplo `calendar` não é necessário. Agenda compartilhada da qual o usuário não é dono exige `calendar.events`: **a validar** na primeira conexão. |
| Público OAuth | "Interno" exige projeto dentro de uma **Organização do Google Cloud**; ter conta Workspace não basta. Em modo de teste (público externo): até 100 usuários e autorização que **expira em 7 dias**. Externo em produção exige verificação para escopos sensíveis. Dispensa de verificação para app interno: **a validar** no console. |

## 3. Google Cloud, público OAuth e acessos administrativos

- **Dois projetos Google, isolados:**
  - *Teste*: público externo em modo de teste, conta de teste e agenda
    dedicadas; a expiração de 7 dias é aceitável. Serve ao Preview.
  - *Vizentini*: público **interno**, dentro da organização
    `vizentiniadvocacia.com.br`. Serve ao Production.
- **Público interno** faz sentido para o piloto (só contas do domínio; sem
  verificação e sem o limite de 7 dias, a confirmar). Não presumo que basta
  ter Workspace: exige organização do Google Cloud e quem a crie.
- **Acessos administrativos necessários** (pendentes, §12): um super
  administrador do Workspace para (a) criar/confirmar o recurso de
  organização do Google Cloud, (b) conceder a um responsável o papel de
  criação de projetos, (c) conferir, no Admin, a política de acesso de apps a
  APIs do Google e liberar o app se estiver restrita, (d) criar um usuário de
  teste no domínio.
- **Sem antecipar um segundo escritório:** um cliente OAuth por ambiente,
  configurado por variáveis de ambiente. Não se cria configuração por cliente
  agora; se um segundo escritório vier, o app interno não serve a ele e a
  decisão (app externo verificado) é tomada nesse momento.

## 4. Modelo de dados (resumo)

Tudo com `workspace_id`, RLS forçada, acesso por RPC `SECURITY DEFINER`
(padrão da B1) e `environment` obrigatório onde indicado.

- `calendar_connections`: usuário, `environment`, conta Google, escopos
  concedidos, `calendar_id` escolhido, token de refresh e de acesso **cifrados
  com chave do ambiente** + `key_version`, status (`active`, `needs_reauth`,
  `disconnected`).
- `calendar_event_links`: `activity_id`, `connection_id`, `environment`,
  `calendar_id`, `event_id`, `generation`, status (`linked`, `missing_in_google`,
  `cancelled_in_google`, `unlinked`, `needs_attention`), **base da última
  sincronização** (`base_etag`, `base_title`, `base_start`, `base_end`,
  `base_cancelled`, `base_meet`, `base_crm_version` = `lock_version` da
  atividade), `meet_request_id`, `meet_status`, `last_synced_at`.
- `calendar_sync_state`: por conexão/calendário, `sync_token`,
  `pending_sync_token`, `full_sync_started_at`, `last_run_at`.
- `calendar_watch_channels`: `channel_id`, `resource_id`, `token_hash`,
  `environment`, `created_at`, `expires_at` (efetivo, devolvido pela API),
  `renew_at`, `renewing_until` (trava), status (`creating`, `active`,
  `retiring`, `stopped`, `polling_only`).
- `calendar_sync_conflicts`: campo, valor do CRM, valor do Google, resolução,
  quem/quando — **nunca descarta o valor perdedor sem registro**.
- `calendar_effect_intents`: intenção de escrita externa registrada **antes**
  da chamada (§6.7).
- `calendar_scheduler_heartbeat`: `last_run_at` por agendador e ambiente.

Eventos externos **não são persistidos**: sem título, descrição, convidados ou
horários de eventos sem vínculo local (§6.2).

## 5. Escopo previsto e reaproveitamento

- **Atividades (A6):** `activities` já tem `due_at` com fuso explícito
  (`America/Sao_Paulo`), `has_time`, tipo `meeting`, responsável e
  `lock_version`. Compromisso = atividade `meeting` com horário
  (`has_time = true`); não se cria entidade paralela nem se reabre a máquina
  de estados da A6 (só `pending`/`done`; excluir é `DELETE`). Estados novos
  (cancelado no Google etc.) ficam **no vínculo**, não na atividade.
- **Agenda `/agenda`:** exibe os compromissos; a navegação entre semanas
  (hoje inexistente, A6 §11) passa a ser necessária e entra na B2.
- **Cifra:** padrão de `src/server/crypto` e `ingest/payload-crypto.ts`
  (AES-256-GCM, chaves versionadas, uma chave por finalidade).
- **Webhook e fila:** padrão da A11 (rota pública idempotente, resposta
  rápida, processamento fora da requisição).
- **E-mail de alerta:** Resend, já configurado.
- **Cliente admin isolado:** padrão de `src/server/proposals/admin/supabase.ts`
  (validar só o que o módulo usa).

## 6. Sincronização

### 6.1 Princípio de vínculo
Só vira evento o compromisso criado ou vinculado pelo CRM. O evento carrega
marca privada (`extendedProperties.private`: `crmAppointment`, `crmEnv`) **e**
o vínculo local por `(calendar_id, event_id)`. A marca ajuda a reencontrar; o
vínculo local é a fonte para reconhecer o evento mesmo quando a resposta não
traz a marca (exclusões, p. ex.).

### 6.2 Sync incremental respeitando as incompatibilidades
`syncToken` não pode ser combinado com `privateExtendedProperty`. Logo, a
listagem incremental devolve mudanças de **todos** os eventos da agenda
escolhida, e a filtragem é nossa, **em memória, durante o processamento**:

1. A lista usa `fields` mínimo:
   `nextPageToken,nextSyncToken,items(id,etag,status,updated,start,end,extendedProperties/private)`.
   Sem `summary`, `description`, `attendees`, `location`.
2. Para cada item: se `(calendar_id, event_id)` está em `calendar_event_links`,
   ou se traz a marca de **este** ambiente (reconexão), é processado; senão é
   **descartado**: não é gravado, não é logado, não vai para erro, fila nem
   observabilidade. Logs carregam só IDs internos e códigos.
3. **Só depois** de o evento ser identificado como vinculado ao CRM — pelo
   registro local `(calendar_id, event_id)` (ou, na reconexão, pela marca do
   ambiente) e pelas verificações pertinentes (ambiente, conexão e calendário
   coerentes com o vínculo, marca coerente quando presente, evento não
   recorrente) — buscam-se com `events.get` os detalhes necessários à
   sincronização: **título** e **conferência/Meet**, além de início, fim e
   status. Esses são os **campos sincronizados** (§6.3). Descrição, local e
   convidados não são lidos. Para evento **não** identificado como vinculado
   nada é buscado, persistido nem logado: o conteúdo de eventos externos nunca
   é guardado, nem em log, erro, fila ou observabilidade.
4. Disponibilidade para agendar vem de `freebusy` (intervalos ocupados, sem
   título), consultada na hora, sem persistir.
5. **Avanço do token:** o `nextSyncToken` só é gravado como `sync_token` depois
   de **todas as páginas** terem sido processadas com sucesso e as mudanças
   confirmadas no banco. Falha em qualquer página: o `sync_token` anterior
   permanece e a execução é refeita (processamento idempotente).
6. **`410`:** reinicia o estado de sincronização (descarta `sync_token`, faz
   listagem completa com os mesmos parâmetros e reconstrói) e **nunca apaga
   atividades, compromissos ou histórico de negócio**. Vínculo ausente numa
   listagem completa vira `missing_in_google` e é confirmado com `events.get`
   antes de ser tratado como cancelamento.
7. Eventos recorrentes ou instâncias de série não são suportados no vínculo:
   ficam `needs_attention` e não são alterados.

### 6.3 Concorrência: base de sincronização, `If-Match` e `412`
Não se decide conflito por `updated`/`updated_at`. O estado de cada vínculo
guarda a **base da última sincronização** (campos e `etag`). Para cada campo
(`título`, `horário` = início+fim juntos, `cancelamento`, `Meet`):

| CRM vs base | Google vs base | Resultado |
|---|---|---|
| mudou | igual | aplica CRM no Google (`If-Match: base_etag`) |
| igual | mudou | aplica Google no CRM |
| mudou | mudou, valores iguais | nada a fazer; atualiza a base |
| mudou | mudou, valores diferentes | **conflito identificado** → regra 6.4 |

- Toda escrita no Google usa `If-Match` com o `etag` conhecido. `412`: reler
  (`events.get`), refazer a comparação com a nova base e repetir, no máximo 3
  vezes; esgotado, o vínculo vira `needs_attention` e alerta.
- A comparação com a base é a regra; o `etag` é a proteção contra a corrida
  entre ler e escrever. O eco das nossas próprias escritas é reconhecido
  porque o estado resultante é igual à base atualizada (não é tratado como
  mudança externa), evitando loops; o `etag` guardado é só uma otimização.
- No CRM, a escrita continua protegida pelo `lock_version` da atividade.

### 6.4 Regra de conflito: "Google prevalece" sem perda silenciosa
Em **conflito identificado** (os dois lados mudaram o mesmo campo para valores
diferentes), o valor do Google é aplicado, e o valor do CRM é **gravado em
`calendar_sync_conflicts`** com entrada na timeline do lead
("Horário alterado no Google durante edição no CRM; valor do CRM preservado
no histórico"). Há ação explícita de **restaurar o valor do CRM**, que passa
pelo mesmo caminho de escrita com `If-Match`. Por campo:

- **Título:** Google prevalece; título do CRM no registro de conflito.
- **Horário:** Google prevalece (início e fim juntos, nunca meio a meio).
- **Cancelamento:** cancelado no Google + editado no CRM → o compromisso fica
  `cancelled_in_google`; a edição do CRM fica no registro de conflito; a
  atividade **não é apagada**. Excluído no CRM + editado no Google (a escrita
  de exclusão leva `If-Match` e recebe `412`) → o evento é **mantido**, o
  vínculo vira `unlinked` e a exclusão do CRM fica registrada na auditoria.
- **Meet:** se o Google já tem conferência, ela é adotada e o pedido do CRM é
  descartado com registro; conferência removida no Google não é recriada
  sozinha (só por ação explícita); `createRequest` fica acompanhado por
  `meet_request_id` até `success` ou falha, com estado visível.

### 6.5 Cancelar e desconectar
- **Cancelar no CRM** (excluir a atividade): apaga o evento no Google **só se
  tiver a nossa marca e o vínculo local**, com `If-Match` (6.4).
- **Cancelar no Google:** compromisso `cancelled_in_google` + timeline.
- **Desconectar:** encerra canais (`channels.stop`), revoga o token, para o
  sync. **Não apaga eventos do Google nem compromissos do CRM**; os vínculos
  viram `unlinked`. Reconectar faz sync completo e reencontra os eventos pela
  marca e pelo `event_id`.
- Token inválido (`invalid_grant`): conexão `needs_reauth`, aviso ao usuário
  ("Autorizar novamente"). Reconhecido em QUALQUER renovação — sob demanda,
  ações e manutenção agendada (§6.14).

### 6.6 Convidados e Meet
- **Convidados desativados por padrão**: sem `attendees`, e `sendUpdates=none`.
- A opção de convidar é **explícita por compromisso**, só aparece para quem
  pode editar a atividade, mostra quem receberá e avisa que o Google enviará
  e-mail, e só então grava `attendees` com `sendUpdates` escolhido. Nunca é
  ligada em lote nem por automação.
- Meet opcional, por compromisso, independente de convidados.

### 6.7 Idempotência e resultado incerto
- Evento criado com **id determinístico** (derivado do id da atividade, do
  `generation` e do ambiente; alfabeto base32hex exigido pelo Google).
- **`409` na criação não é sucesso por si só.** Faz-se `events.get` do id e
  confere-se: calendário esperado, marca `crmAppointment`/`crmEnv` iguais aos
  do compromisso, e status. Correspondendo: adota-se o evento (grava `etag`,
  reconcilia campos pela base). Marca diferente: **não adota**, falha com
  `id_conflict` e alerta. Evento existente já cancelado: não é recriado;
  incrementa-se `generation` e cria-se novo id só por ação explícita.
- **Timeout ou resultado incerto:** antes de chamar o Google, grava-se a
  intenção em `calendar_effect_intents` (operação, estado esperado, base).
  Após timeout/erro de rede, **não se repete às cegas**: consulta-se o estado
  — criação: `events.get` do id (200 e confere → sucesso; 404 → pode repetir,
  uma vez, dentro da mesma tentativa; depois disso, só a verificação da
  intenção original conclui — §6.9);
  atualização: relê e compara com o estado pretendido (igual → sucesso; igual
  à base → repete com `If-Match`; outro → reaplica a regra 6.3); exclusão:
  `events.get` (404/cancelado → sucesso). Intenção sem desfecho vira alerta.

### 6.8 Regras fixadas na revisão da etapa 2
Quatro pontos da revisão da PR #25 foram reproduzidos com teste e passaram a
ser regra (duas decisões de produto fecharam a revisão):

- **O vínculo manda na conexão; a agenda selecionada afeta só compromissos
  novos.** Reagendar, adicionar Meet e cancelar só valem para a conexão que
  criou o vínculo — conferido antes de abrir intenção e de qualquer chamada ao
  Google (`link_connection_mismatch`; no banco, `calendar_link_mismatch`).
  Conexão de outro usuário é recusada. Trocar a agenda selecionada **não move
  nem desvincula** nada: o compromisso existente continua operando no
  `calendar_id` original do vínculo, pela mesma conexão autorizada.
- **Perda de acesso é pendência explícita, nunca "evento apagado".** `401`/`403`
  — ou um `get` que volta "não existe" com a agenda já inacessível
  (`calendarAccessible` = falso) — encerra a operação como `access_lost`: o
  vínculo vira `needs_attention` (auditado), nada é cancelado nem desvinculado,
  e a próxima operação, com o acesso restabelecido, devolve o vínculo a
  `linked`. "Não existe" com a agenda acessível continua sendo cancelamento no
  Google.
- **Aplicar o valor do Google exige a versão lida da atividade.**
  `apply_google_values_to_activity` compara `lock_version`; se o CRM mudou
  depois da leitura, não aplica nada, não grava conflito e devolve `null`. O
  orquestrador relê a atividade pela sessão e reavalia tudo. O valor do CRM
  que perdeu é gravado na **mesma transação** da aplicação.
- **Meet: chave ausente preserva, `null` remove.** No estado enviado a
  `resolve_calendar_effect`, `meetStatus`, `meetUrl` e `meetRequestId` só
  mantêm o valor guardado quando a chave não vem; com `null`, o Google
  informou que o Meet foi removido.
- **Duração real, sem clamp.** Padrão de 60 min; o campo editável da interface
  aceita 15–480 (validado na aplicação, sobre o que o usuário digita). O CRM só
  conhece o início: sem duração pedida, o evento mantém a que tem no Google, e
  uma mudança só de duração no Google não conflita com o CRM remarcar. Quando o
  horário é reconciliado, a duração do vínculo é a **real** do evento que
  ficou, inclusive de evento externo fora de 15–480 (a constraint do banco
  exige apenas `> 0`).

### 6.9 Interface de atividades (etapa 2b)
As ações de atividade que já existiam passaram a levar o compromisso ao
Google, e as telas ganharam os controles. Tudo com o provedor **simulado**.

- **Integração desligada = tela idêntica à anterior.** Sem provedor
  configurado (hoje, em Preview e Production), nenhuma função de B2 é chamada
  pelas telas de atividade: a lista não lê vínculos, o layout não lê conexões e
  as ações de atividade não tocam em nada de calendário. Por isso o código
  pode ser publicado antes das migrations de B2.
- **Recusa ANTES de qualquer escrita (CRM ou Google)** — decisões de produto
  da revisão da PR #26, válidas enquanto não houver fluxo de delegação ou
  reconciliação:
  - compromisso vinculado à conexão de **outra pessoa**: título, horário,
    duração, tipo e exclusão ficam bloqueados; notas e prioridade continuam
    editáveis, sem disparar sincronização;
  - compromisso vinculado (qualquer dono): mudar o tipo ou tirar o horário
    exige resolver o vínculo antes (remover da agenda);
  - inclusão no Google com resultado incerto: título, horário, duração, tipo e
    exclusão aguardam a verificação;
  - a duração digitada (15–480) é conferida no servidor.
- **Nada é desvinculado nem abandonado no Google automaticamente.** Evento
  editado no Google desde a última sincronização não é apagado nem desvinculado
  ("Remover da agenda" diz que não removeu), e a atividade não é excluída.
- **Excluir atividade vinculada à minha agenda: Google primeiro.** Só
  "removido" ou "já não existia" deixam a exclusão seguir; acesso perdido,
  falha ou resultado incerto impedem a exclusão, com o motivo.
- **Depois de salvar no CRM**, o resultado no Google volta como aviso e, se não
  deu certo, fica **gravado no vínculo** (`sync_state`), visível depois de
  recarregar:
  - `pending` — temporário (Google não respondeu, 429/5xx, leitura falhou,
    concorrência esgotada, conexão a reautorizar, acesso perdido): "Sincronizar";
  - `failed` — recusa definitiva do Google (ex.: 400) ou evento editado no
    Google ao pedir remoção: precisa de alguém;
  - `uncertain` — não se sabe se o Google aplicou: "Verificar" **consulta o
    estado antes de repetir** qualquer efeito.
  Uma conferência com desfecho definitivo encerra só as intenções abertas do
  **mesmo alvo** — mesmo ambiente, conexão, agenda e evento (`superseded`);
  pertencer à mesma atividade não basta, e intenção sem alvo registrado nunca
  é encerrada assim. Falha de leitura antes de qualquer escrita é pendência,
  não incerteza.
- **Identidade imutável da tentativa.** Antes da chamada ao Google, a intenção
  grava ambiente, workspace, conexão, `calendar_id` e `event_id` efetivamente
  usados: na inclusão, a agenda selecionada naquele momento (se ela mudar entre
  a leitura e o registro, `calendar_selection_changed`) e o id determinístico;
  nas demais operações, a agenda e o evento do vínculo. Um gatilho impede
  trocar a identidade depois. Só existe **uma inclusão sem desfecho por
  atividade e ambiente** (índice único): enquanto ela não for verificada, uma
  nova inclusão é recusada antes de qualquer chamada (`create_outcome_uncertain`)
  — o evento pode existir, talvez em outra agenda.
- **Inclusão incerta** (ainda sem vínculo) aparece para a tela e tem
  "Verificar inclusão", que resolve a **intenção original**
  (`get_open_calendar_create`) — nunca abre uma intenção nova nem usa a agenda
  selecionada depois. Só consulta, com a conexão e na agenda da tentativa, o
  evento da tentativa:
  - existe e é este compromisso → é adotado e vinculado **na agenda da
    tentativa** (se ela não é mais a selecionada, a mensagem diz isso);
  - não existe, com o acesso à agenda confirmado → "não foi criado", e uma nova
    inclusão volta a ser possível (na agenda selecionada agora);
  - sem acesso à agenda, conexão original indisponível (trocada, desconectada,
    a reautorizar) ou Google sem resposta → **a pendência continua aberta**:
    nada disso prova que o evento não foi criado, e nenhuma nova tentativa fica
    liberada;
  - tentativa de outra pessoa → recusada sem consultar nem alterar nada;
  - aberta há menos de 2 minutos → pode estar em andamento, nada é consultado;
  - intenção sem agenda/evento registrados → nenhuma conclusão é inventada.
  Repetir a verificação nunca cria evento, envia convite ou duplica vínculo.
- **Mensagens fiéis ao resultado concreto:** removido ≠ mantido no Google; Meet
  pronto ≠ Meet em criação; conflito explica que o Google prevaleceu; incerto
  aparece como incerto.
- **Vínculo nunca escondido:** a leitura e os controles de agenda não filtram
  por tipo ou horário quando o vínculo existe.
- **Leitura do vínculo pela tela:** `list_activity_calendar_links` devolve só
  estado, se é do usuário, duração, Meet e sincronização — nunca título, etag,
  ids de agenda/evento, e-mail da conta nem token.

### 6.10 Google → CRM (etapa 3)
Primeira parte (**3a**), implementada com o provedor **simulado** (migration
`20261011100000_b2_google_to_crm_sync`, não aplicada ao hospedado).

- **Só eventos vinculados.** A listagem (`events.list`, `fields` mínimo, sem
  título) traz a agenda inteira; cada item é reconhecido pelo vínculo local
  `(agenda, evento)` do ambiente e da conexão. Sem vínculo: descartado em
  memória — não é lido em detalhe, gravado, logado nem contado. Só o evento
  vinculado é lido com `events.get` (título e Meet).
- **Por (conexão, agenda) com vínculo ativo**, inclusive agendas que não são
  mais a selecionada (o compromisso continua na agenda em que nasceu).
- **Uma execução por vez** (`claim_calendar_sync`, trava com validade). O
  `syncToken` novo só é gravado por quem ainda detém a trava, depois de
  **todas** as páginas e de todos os itens vinculados aplicados; qualquer
  falha mantém o anterior e a execução é refeita — o processamento é
  idempotente (o eco e o já aplicado são reconhecidos pela base).
- **Trava conferida em toda escrita.** `reset_calendar_sync_token`,
  `apply_google_inbound_change` e `finish_calendar_sync` recebem a trava e,
  antes de gravar, bloqueiam a linha do estado (`private.lock_sync_lease`,
  `for update`) e conferem que ela ainda é desta execução, desta conexão e
  agenda e não venceu (relógio de agora). O bloqueio vale até o fim da
  transação: nenhuma outra execução assume entre a conferência e a escrita.
  Ordem de bloqueio estado → vínculo nas duas funções que tocam os dois.
  Quem perdeu a trava não altera atividade, vínculo, conflito, token nem
  auditoria, e o orquestrador para no ato (`lease_lost`). Provado em
  sequência no pgTAP e sob concorrência real no CI
  (`scripts/b2-sync-lease-concurrency-check.sh`: duas sessões com
  transações abertas ao mesmo tempo).
- **Paginação:** a consulta inicial (`syncToken`, `showDeleted`,
  `singleEvents`, `maxResults`) é repetida em **todas** as páginas; só o
  `pageToken` é acrescentado. O simulador recusa página de consulta
  diferente (400), como o Google.
- **`410`, em qualquer página:** o token é descartado na hora e a listagem
  completa é refeita; nada do CRM é apagado, e o que as páginas anteriores
  já aplicaram é reconhecido pela base (não é reaplicado nem duplica
  conflito). Na listagem completa, vínculo ausente é confirmado com `get` e
  com o acesso à agenda antes de virar `missing_in_google`.
- **Eco e reconciliação parcial.** O `etag` igual, sozinho, não prova que
  todos os campos foram reconciliados. Por isso: (a) a saída (etapa 2) só
  grava na base o `etag` do evento quando **todos** os campos sincronizados
  da base conferem com ele; se algum ficou para a entrada (ex.: o Google
  mudou o título enquanto o CRM remarcava), a base mantém o `etag` anterior,
  o que obriga a entrada a ler o detalhe; (b) a entrada só trata um item
  como eco se o `etag` **e** o que a listagem traz (estado, início e fim)
  batem com a base.
- **Regra por campo contra a base** (§6.3/6.4), aplicada por
  `apply_google_inbound_change` numa única transação (atividade, conflitos
  e base), só se a base e a versão da atividade são as lidas — senão relê e
  reavalia (até 3 vezes; depois, o token não avança):
  - mudou só no Google → aplicado no CRM; nos dois para valores diferentes →
    o Google prevalece e o valor do CRM fica gravado; só no CRM → o CRM não é
    sobrescrito e a base desse campo não avança;
  - horário: o CRM recebe o início; a duração do vínculo é a real;
  - cancelado no Google → vínculo `cancelled_in_google`, atividade mantida;
  - Meet: o do Google é adotado (removido lá, removido aqui; nunca recriado);
  - série/instância de série ou marca de outro compromisso/ambiente →
    `needs_attention`, nada aplicado.
- **Autorização:** tudo roda em nome do **dono da conexão**; se ele não
  alcança mais a atividade (papel ou lead), nada é aplicado e o vínculo vai
  para atenção (`owner_lost_access`). **Isolamento:** todas as RPCs exigem o
  ambiente autenticado; a atividade passa pelo gatilho de ambiente.
- **Perda de acesso** (401/403/404 na listagem): pendência explícita nos
  vínculos da agenda, token mantido; a próxima listagem bem-sucedida prova o
  acesso e os devolve a `linked`. **Refresh token inválido:** conexão
  `needs_reauth`, sem novas tentativas em laço.
- **Canais:** linha `creating` com o **hash** do segredo gravada antes do
  `watch`; `renew_at` pela vida efetiva (§9.4); trava atômica de renovação;
  o novo é criado antes de o velho (`retiring`) ser parado, o que acontece
  depois da primeira mensagem do novo ou de 10 min; vida < 45 min →
  `polling_only`, sem laço por 24 h; resposta do `watch` perdida → a primeira
  mensagem revela o recurso e o canal é ativado (sem criar outro), ou é
  abandonado depois de 10 min; canal de agenda sem vínculo ou vencido é
  encerrado. Desconectar encerra os canais no Google (enquanto há token) e
  no banco.
- **Webhook** (`/api/calendar/webhook`, público no proxy): só cabeçalhos;
  canal do ambiente + segredo + recurso conferidos no banco; só marca a
  agenda para sincronizar (`dirty_at`). 200 aceito/encerrado, 404
  desconhecido, 400 malformado. Sem provedor configurado: 404 sem tocar no
  banco.
- **Manutenção** (`/api/cron/calendar`, segredo dos crons da A11): por alvo
  do lote, cuida do canal e sincroniza com dica do webhook, a cada 15 min
  (polling) e com listagem completa a cada 24 h. Idempotente e segura em
  paralelo. Responde só contagens. Sem provedor configurado, não toca em
  nada.
- **Lote justo** (`claim_calendar_maintenance_batch`, padrão 25, teto 200):
  até metade das vagas para agendas com dica do webhook ainda não atendida;
  o resto para as visitadas há mais tempo. A visita é marcada na própria
  reserva, então a rodada seguinte começa pelas outras e toda agenda é
  atendida em poucas rodadas, mesmo com mais agendas que vagas (e mesmo
  quando a conexão de alguma não abre). Os canais vêm do lote, mais os sem
  vínculo ou vencidos de qualquer agenda (até 200), cada um com `hasLinks`
  calculado no banco: **agenda fora do lote não está sem vínculo**, e o
  canal dela não é encerrado. Duas rodadas simultâneas podem reservar a
  mesma agenda; as travas de sincronização e renovação impedem trabalho
  duplicado.
- **Endereço do webhook:** `CALENDAR_WEBHOOK_URL` (https) por ambiente; sem
  ela, só polling. Não configurada.

**Checklist da B2 depois da 3a** (estado atualizado na 3b, §6.11):

| Item | Etapa | Estado |
| --- | --- | --- |
| Agendador principal: função agendada do Inngest, a cada 15 min, por ambiente (§9.2.1), e sincronização sob demanda ao abrir a agenda ou criar/editar um compromisso (§9.2.3) | **3b**; ligar e medir frequência e consumo na **4** | feito na 3b, **desligado** (`CALENDAR_SCHEDULER_ENABLED`) |
| Recuperação adicional: workflow próprio no GitHub Actions (§9.2.2); o workflow da A11 não muda | **3b**; agendar e disparar de verdade na **4** | feito na 3b, **só disparo manual** e segredo próprio ainda inexistente |
| Cron diário da Vercel como recuperação adicional | **4**, se o plano da conta permitir | não feito: um cron em `vercel.json` passaria a chamar Production sozinho |
| Batimento do agendador e alertas: batimento, e-mail do Detector 1, aviso na tela do Detector 2 (§9.3) | **3b**; medição do §9.8 na **4** | feito na 3b, e-mail **desligado** (`CALENDAR_ALERTS_ENABLED`) |
| Reconexão reencontra os vínculos pela marca (critério 12) | **3b** | feito |
| Restauração do valor do CRM que perdeu num conflito (critério 7) | **3b** | feito (título e horário) |
| Conflito e restauração na timeline do lead (critério 7) | **3b** | feito |
| Adaptador Google real e fluxo OAuth (§6.12) | **4a** | feito, **desligado** sem configuração completa; só respostas HTTP simuladas |
| `CALENDAR_WEBHOOK_URL` e liberação da proteção do Preview para o webhook | **4** | pendente |
| Comportamento real do Google (token, paginação, `410`, vida dos canais, cabeçalhos) e metas do §9.8 | **4** | pendente |
| Pendências do administrador do Workspace e da conta de teste (§12) | **4** (validação externa) | pendente |

### 6.11 Agendadores, alertas, reconexão e restauração (etapa 3b)
Implementado com o provedor **simulado** (migration
`20261012100000_b2_scheduler_alerts_restore`, não aplicada ao hospedado).
**Tudo o que roda sozinho ou envia algo para fora começa desligado, e
continua desligado depois do merge.**

- **Agendador principal** (`src/server/calendar/inngest.ts`): função do
  Inngest a cada 15 min (`TZ=UTC */15 * * * *`), uma por vez, sem novas
  tentativas em laço, num app PRÓPRIO (`praxis-crm-agenda`, rota
  `/api/inngest/calendar`) — separado do app da A11 (`praxis-crm`,
  `/api/inngest`), cuja validação exige toda a configuração da A11. Só é
  oferecida ao Inngest com `CALENDAR_SCHEDULER_ENABLED=true` (só o valor
  exato liga); sem ela a lista de funções volta vazia e nada é agendado.
  Mesmo ligada, sem provedor configurado a rodada não toca em nada. Rodada
  `failed` vira FALHA da execução no Inngest (§9.7).
- **Sob demanda** (§9.2.3): abrir a Agenda, criar ou editar um compromisso
  sincroniza as agendas da PRÓPRIA conexão cuja última execução tem mais de
  5 min — depois da resposta (`after`), com a mesma trava da manutenção, no
  máximo 5 agendas por vez. Não depende de chave: sem provedor, nada.
- **Recuperação adicional** (`.github/workflows/b2-calendar-recovery.yml`):
  só `workflow_dispatch`, sem `schedule`, sem endereço padrão (quem dispara
  informa), com segredo próprio `B2_CALENDAR_CRON_SECRET` (mesmo valor do
  `CRON_SECRET` do ambiente; ainda não existe). Chama
  `/api/cron/calendar?source=github`. Agendá-lo é decisão da etapa 4.
- **Autenticação da rota** (`src/server/calendar/cron-auth.ts`): só o
  `CRON_SECRET` do ambiente, no cabeçalho `Authorization: Bearer`. Falha
  fechada com segredo ausente ou com menos de 16 caracteres; segredo na URL
  não vale; nada é registrado. Até a correção (16/10/2026, preparação do
  webhook) a rota lia o segredo por `getIngestConfig()`, que exige TODA a
  configuração da A11 (Turnstile, Upstash, chaves A11, Inngest): num
  ambiente só com a agenda — o Preview de validação — a chamada correta
  recebia 401 e a manutenção nunca rodava. As rotas da A11 não mudaram.
- **Batimento** (`calendar_scheduler_heartbeats`): toda rodada — Inngest,
  recuperação adicional ou chamada manual — grava quando rodou, o desfecho
  e só contagens (o banco descarta qualquer valor que não seja número).
  "Executou recentemente" (`last_run_at`) e "sincronizou com sucesso"
  (`last_success_at`, só rodada `ok`) são datas separadas. Desfecho:
  - `ok`: toda agenda tentada sincronizou;
  - `partial`: parte das agendas falhou (`failed > 0` e `synced > 0`);
  - `failed`: a rodada lançou erro, ou houve falha e nenhuma agenda
    sincronizou.
  Agenda ocupada por outra execução, sem acesso ou conexão a reautorizar
  NÃO é falha da rodada: é situação daquela conexão, que já aparece nela
  (vínculo para atenção, conexão a reautorizar). Rodada que falha também
  grava ("rodou e falhou" ≠ "não rodou"). A rota `/api/cron/calendar`
  devolve o desfecho e as contagens; rodada `failed` responde 503 (o job
  manual do GitHub fica vermelho e mostra o corpo).
- **Detector 1** (§9.3): a recuperação adicional confere o batimento do
  Inngest. Agendador principal desligado → nada a vigiar. Rodou dentro do
  prazo, mas a última rodada falhou → `last_run_failed`; parte falhou →
  `last_run_partial` (nenhum dos dois é "saudável", nem "atrasado"; só a
  resposta, sem e-mail — o e-mail continua só para atraso). Atrasado (> 60
  min sem EXECUÇÃO, qualquer que tenha sido o desfecho, ou nunca rodou) com
  `CALENDAR_ALERTS_ENABLED` desligado → apurado e respondido, sem e-mail
  nem reserva. Ligado → reserva atômica
  (`claim_calendar_scheduler_alert`, no máximo um alerta a cada 6 h; falha
  não conta), um e-mail por destinatário (owner/admin dos workspaces com
  vínculo no ambiente; ninguém vê o endereço dos outros), sem conteúdo de
  evento, pelo Resend já usado nas propostas.
- **Detector 2** (§9.3): na Agenda e em Integrações, owner/admin veem aviso
  quando há compromissos vinculados e a sincronização automática está
  atrasada (nenhuma execução automática em 60 min, ou nunca rodou), quando
  ela roda mas a última execução falhou (com quando foi a última sem
  falhas), quando parte das agendas falhou (as demais foram atualizadas) ou
  há canal com menos de 25% da vida — cada caso com a sua mensagem.
  Com o agendador desligado, o aviso é informativo ("desligada neste
  ambiente; atualizada ao abrir a agenda e ao editar compromissos").
- **Reconexão** (§6.5, critério 12): desconectar desfaz os vínculos; ao
  conectar de novo (com a agenda escolhida) ou pelo botão "Reencontrar
  compromissos", o banco lista os vínculos desfeitos de conexões
  desconectadas do MESMO usuário, workspace e ambiente, cuja atividade
  existe e não tem outro vínculo ativo. Cada evento é conferido no Google:
  existe, não está cancelado, não é série e tem a marca deste compromisso e
  ambiente — senão não é adotado (nem recriado). O vínculo volta com a base
  preservada e a recuperação fica **pendente** nele (`recovery_pending_at`,
  independente do `sync_error`, que a saída reescreve); depois, listagem
  completa de cada agenda com recuperação pendente (Google → CRM) e saída de
  cada compromisso (CRM → Google), com as regras normais de conflito.
  - Entrada que não termina (Google indisponível, outra execução com a
    trava, sem acesso): a saída daquela agenda não roda e tudo fica
    pendente.
  - Saída: só `updated`, `unchanged`, `conflict_resolved` ou evento
    cancelado no Google concluem (`finish_calendar_link_recovery`);
    pendente, falha, incerto, sem acesso ou para atenção deixam pendente.
  - A próxima tentativa ("Reencontrar compromissos", ou reconectar) retoma
    as pendências da própria conexão (`list_pending_calendar_recoveries`),
    inclusive depois de uma interrupção logo após revincular. Nada cria
    evento ou vínculo: a saída só atualiza o evento vinculado.
  - A tela mostra o que de fato terminou: reencontrados, retomados,
    concluídos, pendentes (com o motivo) e sem acesso.
- **Restauração** (`restore_calendar_conflict`, critério 7): só título e
  horário em que o Google prevaleceu; só pelo dono da conexão do vínculo
  (é ele quem leva ao Google), com `activity.edit` e alcance ao lead; só se
  a atividade ainda tem o valor que prevaleceu (senão `outdated`: restaurar
  sobrescreveria algo mais novo); vínculo precisa estar `linked`. Horário =
  início **e** duração do valor do CRM: o início volta à atividade e a
  duração, ao vínculo; mudar só a duração depois do conflito (no CRM ou no
  Google) também torna a restauração `outdated`. O vínculo fica pendente
  (`conflict_restored`) até a saída concluir. Na saída, sem duração pedida,
  vale a duração que o Google mudou desde a base; se ele não a mudou, vale
  a do vínculo — assim a duração restaurada chega ao Google mesmo numa nova
  tentativa depois de falha. A
  atividade passa pelo gatilho de ambiente; o conflito fica marcado
  (quando, quem, versão); auditoria só com o nome do campo. Em seguida a
  saída normal leva o valor ao Google — se o Google mudou de novo, vale a
  regra de conflito outra vez, com registro. Cancelamento não se restaura.
- **Timeline do lead**: tipo "Agenda" — o conflito (o que prevaleceu e o
  valor do CRM guardado, com "Restaurar valor do CRM" para quem pode) e a
  restauração como fato próprio. Só conflitos do ambiente autenticado da
  requisição; sem ambiente, nenhum.

### 6.12 Adaptador Google real e OAuth (etapa 4a)
Implementado e testado só com respostas HTTP **simuladas** (migration
`20261013100000_b2_google_oauth`, não aplicada ao hospedado). Nenhuma
credencial foi criada e nada chama o Google enquanto a configuração não
estiver completa.

- **Liga só completa** (`src/server/calendar/google/config.ts`):
  `CALENDAR_PROVIDER=google`, `GOOGLE_OAUTH_CLIENT_ID`,
  `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `CALENDAR_TOKEN_*`
  válidas e `CALENDAR_ENV_SIGNING_KEY` (≥ 32). Faltando qualquer uma, o
  provedor é `null` e a tela diz "não configurada". O simulado continua
  impossível em Preview e Production.
- **Endereço de retorno** só o configurado: https, caminho exato
  `/api/calendar/oauth/callback`, sem query, fragmento ou credencial (http só
  em `localhost`, fora da Vercel). Nada da requisição define para onde se
  volta; depois do retorno, sempre `/configuracoes/integracoes?agenda=<desfecho>`
  com mensagem fixa.
- **Início** (`GET /api/calendar/oauth/start`, link "Conectar com Google";
  GET porque o `form-action 'self'` do CSP barraria um formulário seguindo
  para o Google): exige `calendar.connect_own`; recusa chamada de outro site
  (`Sec-Fetch-Site: cross-site`) e outra origem que não a do retorno.
  Gera `state` (32 bytes), `nonce` do OpenID Connect, verificador PKCE (S256)
  e um cookie do navegador (httpOnly, Secure, SameSite=Lax, só no caminho do
  OAuth, 10 min). O banco (`calendar_oauth_states`) guarda só os **hashes**
  do state, do nonce e do cookie, e o verificador **cifrado** com a chave de
  tokens do ambiente — com usuário, workspace e ambiente autenticado.
  Escopos: `openid email` + os três de agenda; `access_type=offline`,
  `prompt=consent select_account`, `include_granted_scopes=false`.
- **Retorno** (`GET /api/calendar/oauth/callback`): o state é **consumido**
  primeiro (uso único, mesmo quando o Google devolveu erro); só então se
  conferem prazo (10 min), ambiente, sessão (mesmo usuário e workspace) e
  navegador (mesmo cookie). Depois: troca do código com PKCE e o retorno
  configurado; **ID token** (`iss` do Google, `aud` = este cliente, `exp`,
  `nonce` desta autorização, `sub`, e-mail verificado — sem conferir a
  assinatura, porque o token vem direto do endpoint de token por TLS,
  OpenID Connect Core §3.1.3.7 item 6); **escopos concedidos** (faltando
  algum de agenda: nada é guardado e nada é revogado — revogar derrubaria uma
  autorização anterior ainda válida da mesma conta). Cookie apagado sempre.
- **Identidade da conta**: o `sub` do ID token (estável; o e-mail pode
  mudar), nunca o id da agenda principal. A conexão
  (`connect_calendar_identity`) guarda `google_subject` e `oauth_client_id`:
  - refresh token ausente numa conexão NOVA, a reautorizar, de outro cliente
    ou outra versão de chave → `refresh_missing` (novo consentimento);
  - refresh token ausente na reautorização da MESMA conta e cliente → mantém
    o existente (não apaga);
  - outra conta sobre a conexão existente → `account_mismatch` (desconectar
    antes); a mesma conta por outra pessoa do workspace → `account_in_use`;
  - a função antiga (`connect_calendar_account`) nunca sobrescreve conexão já
    identificada.
- **Adaptador** (`google/calendar-api.ts`, `google/http.ts`): campos mínimos
  (a listagem nunca pede título); `If-Match` nas escritas; `sendUpdates`
  explícito; id do cliente (409); 410 de evento = inexistente (404), 410 da
  listagem = token inválido; horários em UTC; mesmos parâmetros em todas as
  páginas; vencimento EFETIVO do canal; `calendarAccessible` e demais
  detalhes abaixo; `calendarAccessible` por `calendarList.get` (escopo
  `calendarlist.readonly`). Erros pelo código **e pelo motivo**: limite de
  chamadas (403 `rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded`,
  `dailyLimitExceeded`… ou 429) → 429 temporário, nunca perda de acesso; API
  desligada no projeto (403 `accessNotConfigured`) → 503; demais 401/403 →
  perda de acesso; prazo (15 s) ou rede → resultado incerto (a saída consulta
  antes de repetir). Renovação: `invalid_grant` → a reautorizar (no ponto
  único `loadFreshTokens`, §6.14). Revogação
  pelo endpoint do Google. Token de acesso vencido é renovado também ao listar
  agendas e ao desconectar.
- **Meet** (tradução explícita no adaptador): na leitura, o
  `createRequest.status.statusCode` do Google (objeto) vira a string do
  contrato (`pending`/`success`/`failure`; outro valor = sem pedido), e o
  endereço vem só do entryPoint `video` com https — telefone, `more` ou SIP
  podem vir antes e são ignorados. Na escrita, o corpo leva só
  `createRequest.requestId` e `conferenceSolutionKey: {type: "hangoutsMeet"}`;
  `status` e `entryPoints` são somente leitura e nunca são enviados. O
  orquestrador também escolhe o entryPoint de vídeo, nunca o primeiro.
- **Disponibilidade desconhecida não é livre**: resposta malformada, sem
  `calendars`, agenda pedida ausente, `busy` que não é lista, intervalo com
  data ilegível ou `errors` por agenda (com ou sem motivo) → erro (503; 404
  para `notFound`). Só a agenda presente, sem erro e com `busy: []` é livre.
  Com `requireFree`, o erro acontece antes de qualquer criação: zero chamadas
  de inclusão de evento (testado com o orquestrador real).
- **Logs**: só desfecho e código interno; nunca código OAuth, token, state,
  segredo, e-mail ou `sub` (testado).
- **Por que a assinatura do ID token não é conferida** (exceção conferida,
  sem ampliar o OAuth): OpenID Connect Core 1.0 §3.1.3.7, item 6 — no fluxo
  de código, quando o ID token é recebido por comunicação direta entre o
  cliente e o endpoint de token, a validação do servidor por TLS PODE
  substituir a verificação da assinatura; a documentação do Google ("Obtain
  user information from the ID token") diz o mesmo para o canal HTTPS direto
  com o segredo do cliente. As condições valem aqui e estão no código
  (`google/oauth.ts`): `response_type=code`; o ID token só é lido da resposta
  do POST a `https://oauth2.googleapis.com/token` (endereço fixo, TLS
  verificado pelo runtime), autenticado com o segredo do cliente e o
  verificador PKCE; nunca de parâmetro do navegador. As demais declarações
  (`iss`, `aud`, `exp`, `iat`, `nonce`, `sub`, e-mail verificado) continuam
  conferidas. Se um ID token um dia vier por outro caminho (navegador,
  fluxo implícito ou híbrido), a assinatura passa a ser obrigatória.

**Roteiro externo (etapa 4b, nada feito)** — Preview primeiro:

1. **Organização do Google Cloud:** conferir se a Vizentini já tem uma
   (Cloud Console → seletor de projetos → "Todos"; ou Admin do Workspace →
   conta → Google Cloud) **antes** de propor criar outra. Só Production
   (app interno) depende dela.
2. **Contas separadas:**
   - *Preview:* uma conta **Gmail dedicada** (não do domínio), com uma agenda
     secundária só para teste, usuária de teste do projeto externo em modo
     de teste;
   - *Production (app interno):* uma conta **do domínio**
     `vizentiniadvocacia.com.br` criada pelo administrador do Workspace,
     também com agenda só de teste. A conta do Henrique só na etapa
     controlada, com autorização expressa.
3. **Branch de validação** `validacao-b2`, com alias estável
   `https://praxis-crm-git-validacao-b2-johllls-projects.vercel.app`; o
   **endereço de retorno exato** do cliente OAuth do Preview é
   `https://praxis-crm-git-validacao-b2-johllls-projects.vercel.app/api/calendar/oauth/callback`
   (o de Production será
   `https://praxis-crm-eight.vercel.app/api/calendar/oauth/callback`).
4. **Reautorização sem esperar 7 dias:** revogar a autorização da conta de
   teste em `myaccount.google.com/permissions` (ou pelo "Desconectar" do
   CRM) e conectar de novo; a renovação seguinte devolve `invalid_grant` e a
   conexão fica a reautorizar (§6.14: só quando o token de acesso guardado
   vence e é renovado, até ~1 h depois).
5. **Acesso revogado ≠ falha de comunicação:** acesso revogado = tirar a
   permissão da agenda ou revogar a autorização (espera-se "a reautorizar" ou
   vínculo para atenção); falha de comunicação = simulada no código (prazo,
   5xx, limite de chamadas; coberta pelos testes) — nunca deve virar perda
   de acesso.

### 6.13 Validação controlada no Preview (etapa 4b, em andamento)
Preview da branch `validacao-b2`, conta Google de teste, agenda secundária
"Praxis — Testes B2.", workspace "Escritório Demonstração (A10)". Production
sem variáveis de agenda; agendamentos e alertas desligados.

- **10/10/2026 — conexão:** OAuth completo (5 escopos), agenda escolhida e
  conexão salva.
- **10/10/2026 — criação (CRM → Google):** "QA B2 — Primeiro compromisso",
  13/10 10h–11h, 60 min, sem Meet e sem convidados; um único evento, uma
  única tentativa, vínculo `preview` em dia.
- **10/10/2026 — edição e reagendamento:**
  - CRM → Google: título trocado para "QA B2 — Compromisso reagendado" e
    reagendamento para 14h–15h; mesmo id de evento, sem duplicação;
  - Google → CRM: remoção do Meet e mudança para 15h–16h30, aplicadas pela
    sincronização sob demanda (Meet some do vínculo e da tela; início 15h,
    90 min; mesma atividade e mesmo evento; sem conflito).
- **Desvio de execução (10/10/2026):** durante a validação, um clique
  automatizado acertou o botão "Criar link do Meet" no lugar de "Reagendar"
  e criou um Meet no evento de QA (sem convidados, nenhum e-mail enviado). O
  Meet foi removido pelo Google com autorização e a remoção chegou ao CRM.
  Isto **não** substitui o teste planejado de Meet, que continua pendente.
  Medida: cada botão passa a ser localizado pelo rótulo exato e conferido
  antes do clique.
- **Observado:** a sincronização sob demanda respeita o intervalo mínimo de
  5 min; uma segunda abertura da Agenda dentro desse prazo não busca nada
  (esperado).
- **11/10/2026 — Meet planejado (CRM → Google):** um único clique em
  "Criar link do Meet" no compromisso de 13/10 15h–16h30. Concluído na
  primeira tentativa (tentativa `meet` registrada como concluída, sem
  repetição). Vínculo com Meet `success` e link `meet.google.com/…`; no
  Google, o mesmo evento passou a ter a videoconferência, com título e
  horário preservados e sem convidados; a busca encontra 1 evento; a tela
  mostra "Entrar no Meet" depois de recarregar. Limitação: confere o link de
  vídeo pelo formato `meet.google.com`; a escolha do entryPoint de vídeo
  entre vários (telefone antes) só está coberta pelos testes automatizados.
- **11/10/2026 — Disponibilidade (somente consulta):** pelo "Verificar
  disponibilidade" do diálogo de nova atividade, fechado sem criar nada.
  13/10 15h30–16h → "Ocupado na sua agenda: 15:30–16:00." (o Google recorta
  o ocupado à janela pedida); 13/10 10h–11h → "Horário livre na sua
  agenda.". Nenhuma atividade, vínculo ou tentativa nova. Limitação: a
  consulta olha só a agenda vinculada ("Praxis — Testes B2."), não as
  demais agendas da conta; os casos de resposta desconhecida do Google
  (agenda ausente, erro) só estão cobertos pelos testes automatizados.
- **11–12/10/2026 — Conflito de título e restauração:**
  - 1ª tentativa NÃO validada: entre a mudança no Google ("QA B2 — Título
    Google") e a edição no CRM, a aba do CRM estava na página Agenda e foi
    recarregada; a sincronização sob demanda trouxe o título do Google sem
    conflito (o CRM ainda não tinha mudado). Erro de execução, não defeito.
  - 2ª tentativa, validada: base "QA B2 — Título Google" em dia; no Google,
    título → "QA B2 — Título Google 2"; sem sincronização no meio (página do
    lead), no CRM título → "QA B2 — Título CRM". Resultado: "o Google
    prevaleceu"; atividade e base com "Título Google 2"; conflito `title`
    `google_prevails` com o valor do CRM guardado; timeline "Conflito com o
    Google Agenda (título)" com "Restaurar valor do CRM".
  - Restauração pela ação oficial: atividade, base e Google com "QA B2 —
    Título CRM"; conflito com `restored_at`/`restored_by` (o próprio usuário)
    e versão da atividade; timeline "Valor do CRM restaurado (título) —
    restaurado por Demo Proprietária (A10)" e o conflito "Já restaurado".
    Horário (15h–16h30), 90 min, Meet, sem convidados, mesmo evento, 1
    vínculo e 1 evento na busca do Google, persistentes após recarregar.
  - **Observação de usabilidade (não corrigida):** depois de clicar em
    "Restaurar valor do CRM", nenhuma confirmação aparece: a mensagem fica no
    estado do próprio botão, que some quando a página é revalidada (a
    entrada deixa de ser restaurável). O resultado só aparece na timeline.
- **16/10/2026 — Transferência para data futura:** reagendado pelo CRM de
  13/10 para 27/10/2026 15h–16h30 (90 min), mesmo evento, Meet preservado,
  sem convidados, 1 evento e 1 vínculo.
- **16/10/2026 — Conflito de horário e restauração (validado):** base 27/10
  15h–16h30; no Google, 16h–18h (120 min); sem sincronização no meio (página
  do lead), no CRM "Reagendar" para 17h com 90 min, enviado uma vez.
  Resultado: "o Google prevaleceu (horário)"; atividade e vínculo 16h–18h,
  120 min; conflito `schedule` com valor do CRM 17h–18h30 (início e fim) e
  do Google 16h–18h; timeline "Conflito com o Google Agenda (horário)".
  "Restaurar valor do CRM" uma vez: CRM e Google 17h–18h30, 90 min, vínculo
  em dia; conflito com `restored_at`, autor e versão; timeline "Valor do CRM
  restaurado (horário)". Mesmo evento, atividade e vínculo; Meet presente;
  sem convidados; 1 evento.
- **16/10/2026 — Confirmação da PR #30 no ambiente real:** "Valor do CRM
  restaurado. Google Agenda atualizado." em verde (`synced`), visível 3 s e
  13 s depois do clique, já com a timeline atualizada sozinha (entrada de
  restauração presente, botão removido), sem recarga manual.
- **16/10/2026 — "Só criar se o horário estiver livre" (validado):** nova
  reunião "QA B2 — Bloqueio por horário ocupado", 27/10 17h30–18h30, 60 min,
  sem Meet e sem convidados, enviada uma vez. Recusa: "O horário está ocupado
  no Google Agenda…". Antes/depois: 133/133 atividades no workspace, 0/0 com
  o título, 1/1 vínculo, 10/10 tentativas de escrita (1/1 de criação); no
  Google, o dia 27/10 continua só com o compromisso original e a busca por
  "Bloqueio" não encontra nada. Compromisso original intacto.
- **16/10/2026 — Intervalo completo na timeline (PR #31) conferido:** no
  Preview, com o conflito histórico real e sem nova escrita (só a página do
  lead; nenhuma sincronização, conflito, restauração ou escrita no Google),
  a timeline mostra "o Google prevaleceu: 27/10/2026, 16:00–18:00 (120 min).
  Valor do CRM guardado: 27/10/2026, 17:00–18:30 (90 min). Já restaurado." e
  "restaurado por Demo Proprietária (A10): 27/10/2026, 17:00–18:30 (90 min)",
  sem botão de restaurar.
- **16/10/2026 — Desconexão pelo CRM, reconexão da mesma conta e
  recuperação (validado):**
  - Antes: conexão `953c3361-d1f8-4176-a31e-64ae8999e941` ativa; evento
    `epkf8gohljlt6hj5rknrf7vsr8q3p15m`, atividade `5e044c2a-…`, vínculo
    `ac694db5-2a8b-4746-b8b5-de56c33edeb4`; "QA B2 — Título CRM", 27/10
    17h–18h30, 90 min, Meet, sem convidados; 1 evento, 1 vínculo, 2 conflitos
    restaurados; 133 atividades, 10 tentativas de escrita (1 de criação).
  - "Desconectar" (uma vez): conexão `disconnected`, sem token de acesso nem
    de renovação (só presença conferida); vínculo `unlinked` (mesmo id);
    atividade e conflitos intactos; auditoria `calendar.connection.disconnected`;
    evento intacto no Google. A ação revoga o token no Google por melhor
    esforço e ignora a resposta: o resultado dessa revogação não é observável
    e NÃO foi validado.
  - Durante a desconexão, no Google: título → "QA B2 — Reconexão validada";
    o CRM manteve o título anterior.
  - Reconexão pela mesma conta, com novo consentimento: o banco criou uma
    conexão NOVA, `61af033c-263f-4654-8cc2-d88cd4640ee1` (a antiga continua
    `disconnected`); agenda escolhida pelo id salvo.
  - Recuperação automática ao "Vincular": vínculo reencontrado (mesmo id,
    agora na conexão nova), listagem completa trouxe o título do Google para
    o CRM, uma tentativa `update` do mesmo evento com valores já iguais
    (nenhuma criação), recuperação concluída, vínculo em dia. Resultado: CRM
    e Google "QA B2 — Reconexão validada", 27/10 17h–18h30, 90 min, Meet,
    sem convidados.
  - "Reencontrar compromissos" duas vezes: "Nenhum compromisso de uma
    conexão anterior para reencontrar."; contagens idênticas (1 vínculo, 11
    tentativas, 1 de criação, 133 atividades, 2 conflitos, versão 13, 36
    registros de auditoria de agenda). 1 evento no Google.
  - **Limitação de usabilidade observada:** o relatório da recuperação não
    aparece para o usuário: o formulário de "Vincular" só mostra erros e some
    depois que a agenda é escolhida (mesmo padrão corrigido na PR #30).
  - Fora deste teste: revogação externa pelo painel do Google, expiração do
    consentimento e recuperação interrompida.
- **16/10/2026 — publicação da correção de reautorização (PR #32, §6.14):**
  - Migration `20261017100000_b2_reauth_if_current` aplicada no
    `praxis-crm-dev` (`rgoeppjwnltcbeqipovh`) depois de dry-run com ela como
    única pendente; novo dry-run sem pendências. `EXECUTE` da função nova:
    `service_role` sim; `PUBLIC`, `anon` e `authenticated` não. A função não
    foi chamada contra a conexão real.
  - PR #32 mesclada em `67e2dc6` (pais `9990ba5` e `e66024a`); Production
    `dpl_JD4iXqHDzLJYqtB73YigSytCLktA` sem variáveis de agenda, sem testes
    funcionais lá. `main` incorporada nesta branch em `e621351` (conflito só
    neste documento, §6.13 e §6.14 preservados); Preview
    `dpl_FuBq6UH3pLj4kygzBUPyHaDqfFeY` no endereço estável.
  - Conferência limitada, sem abrir a Agenda: conexão `61af033c` ativa, agenda
    "Praxis — Testes B2.", vínculo `linked`/`in_sync` com o mesmo evento e
    Meet, compromisso "QA B2 — Reconexão validada" intacto, nenhuma auditoria
    `needs_reauth`; Integrações sem erro de função ausente, e abri-la não
    alterou conexão nem vínculo.
  - Divergência de texto: o aviso de Integrações diz que a agenda "é
    atualizada quando você abre esta tela", mas a sincronização sob demanda
    roda pela página Agenda (e nas edições), não por Integrações.
  - Pronto para o teste de revogação externa (ainda **não** validado):
    passar por `needs_reauth` e "Autorizar novamente", sem
    desconectar/reconectar como atalho.
- **16–17/10/2026 — revogação externa e reautorização (horários em UTC):**
  - Antes (00:57): conexão `61af033c` `active`/`preview`, agenda conferida
    pelo id (`acd0bd23…@group.calendar.google.com`), token de acesso guardado
    já vencido desde 23:52 (sem espera). Compromisso "QA B2 — Reconexão
    validada", 27/10/2026 17h (São Paulo), 90 min, Meet `wai-vuvn-vte`;
    vínculo `ac694db5` `linked`/`in_sync`, evento `epkf8gohljlt6hj5rknrf7vsr8q3p15m`;
    1 vínculo, 1 conexão não desconectada, 4 atividades no lead.
  - **Revogação — comprovada (01:01:35):** no painel de apps vinculados da
    conta de teste havia uma única entrada "Praxis CRM — Teste", com acesso
    concedido a `praxis-crm-git-validacao-b2-johllls-projects.vercel.app` e os
    mesmos escopos da conexão. Google: "Remover o acesso que você concedeu a
    Praxis CRM — Teste?" → Confirmar; o app saiu da lista (contagens 94→93
    e 8→7: só ele).
  - **Detecção — comprovada (01:02:45):** ao abrir a Agenda, a renovação
    falhou e a conexão passou a `needs_reauth`; uma única auditoria
    `calendar.connection.needs_reauth` com `reason: refresh_token_invalid`,
    pelo dono. Compromisso, vínculo, evento, Meet e histórico iguais aos de
    antes; a única escrita foi a transição de status. Integrações: "A conexão
    precisa ser autorizada novamente." com "Autorizar novamente" e
    "Desconectar".
  - **Reautorização — pendente (bloqueio):** "Autorizar novamente" levou à
    escolha de conta do Google às 01:04:38; o retorno chegou depois do limite
    de 10 minutos do fluxo e o CRM mostrou "A autorização demorou mais de 10
    minutos e expirou. Comece de novo." (`?agenda=expired`). Às 01:18 a
    conexão seguia `needs_reauth`, sem nova auditoria, sem duplicação
    (contagens iguais) e sem concessão nova no painel do Google. Estado
    preservado.
  - **Reautorização — comprovada (01:31:56, segunda tentativa):** novo
    "Autorizar novamente" concluído a tempo. A MESMA conexão `61af033c` voltou
    a `active`, mesma conta e mesma agenda (id conferido), sem nova escolha de
    agenda (`calendar_selected` continua 1); tokens presentes e cifrados
    (`key_version` p1, valores não lidos), novo vencimento 02:31:55. Auditoria:
    `calendar.connection.connected` 1→2. Contagens iguais: 1 conexão não
    desconectada, 1 vínculo da atividade, 1 vínculo do evento, 4 atividades
    no lead.
  - **Acesso funcionando — comprovado (01:32:57):** abrir a Agenda rodou a
    sincronização sob demanda sem erro (`calendar_sync_state.last_run_at` e
    novo `sync_token_at`; `last_error` vazio). Escritas do fluxo: a
    reautorização gravou tokens/estado da conexão e a sincronização gravou o
    estado incremental; nenhuma intenção de escrita no Google
    (`calendar_effect_intents` = 0 desde 01:00), nenhuma auditoria de efeito,
    compromisso e vínculo sem alteração (`lock_version` 13, `base_etag` e
    `last_synced_at` iguais).
  - Conferência no Google (só leitura): "QA B2 — Reconexão validada", terça,
    27/10, 17:00–18:30, agenda "Praxis — Testes B2.", Meet
    `meet.google.com/wai-vuvn-vte`, organizador a própria agenda, nenhum
    convidado; um único evento com esse título na semana.
  - Observado: o fluxo OAuth expira em 10 minutos e o aviso é claro; a
    primeira tentativa (concluída depois do limite) não deixou efeito.
- **17/10/2026 — preparação do webhook (interrompida antes de criar recursos):**
  - PR #33 (autenticação da manutenção só com `CRON_SECRET`) mesclada em
    `f5272ad` (pais `67e2dc6` e `6b11c24`); Production
    `dpl_2QZXYHaGNNddHaX8NGnhQC9UwUY3`, integração desligada. `main`
    incorporada nesta branch em `f0196d4`, sem conflito; Preview
    `dpl_4Ee6RcahuTGfCVP94Tf6iqjYWAUd` no endereço estável.
  - Executor local de encerramento do canal preparado (adaptador
    `stopChannel` + `stop_calendar_channel`, motivo `validation_end`), mas
    NÃO executável: as variáveis Sensitive do Preview voltam do
    `vercel env pull` como marcadores de 11 caracteres, não os valores.
    Faltam localmente `CALENDAR_TOKEN_KEY_VERSIONS`/`CALENDAR_TOKEN_ACTIVE_KEY_VERSION`
    (gerada só para o Preview, sem cópia local) e `CALENDAR_ENV_SIGNING_KEY`.
    Por isso não foram criados bypass, variáveis nem canal.
- **17/10/2026 — webhook: transporte e processamento manual (UTC):**
  - Migration `20261018100000_b2_channel_for_stop` aplicada no
    `praxis-crm-dev` (única pendente, sem drift; dry-run final sem
    pendências); `EXECUTE` só `service_role`. PR #34 mesclada em `7e053e1`
    (pais `f5272ad` e `0e639f8`); Production `dpl_CyQxZQJj5qjGAT1EHbrbhFxCoPcK`,
    agenda desligada. `main` incorporada aqui em `faf31d3`, sem conflito.
  - Configuração temporária: bypass de automação dedicado "webhook B2 teste"
    (criado em `1792205344234`, alcance do projeto inteiro; os 3 anteriores
    intactos); `CRON_SECRET` novo e `CALENDAR_WEBHOOK_URL` só em Preview
    (`validacao-b2`); redeploy `dpl_HyfztSKA3xgZs2kjgQmczgijXeLX`. Rota de
    encerramento no deployment real: sem Bearer 401; UUID inexistente 404,
    zero canais e zero auditorias.
  - Alcance conferido antes de cada rodada: um único alvo (`61af033c`,
    "Praxis — Testes B2.", preview).
  - **Transporte autenticado — comprovado.** Manutenção nº 1 (02:52:41):
    `ok`, `targets 1`, `synced 1`, `full 0`, `channelsCreated 1`. Canal
    `72690d92-bc11-4cd0-847b-0464b0f4cc52` `active`, recurso gravado,
    vencimento 24/10 02:52:43 (7 dias, `renew_at` 22/10 00:28). Mensagem
    inicial do Google aceita pelo webhook (canal, segredo e ambiente
    conferidos no banco): `sync_received_at` 02:52:44, mensagem nº 1.
  - **Processamento manual — comprovado.** Título alterado no Google para
    "QA B2 — Webhook" (salvo 02:55:01; a 1ª tentativa ficou presa num aviso
    informativo do Meet, sem salvar). Notificação 02:55:02 → `dirty_at`
    02:55:02, depois da última sincronização (02:52:44). Manutenção nº 2
    (02:55:34, dentro dos 15 min — o polling não estava vencido, então só a
    marcação justificava a sincronização): `synced 1`; CRM com o novo título,
    `calendar.inbound.applied` 5→6, versão 13→14, horário/duração/Meet
    iguais, `dirty_at` limpo. CRM mantido fora da Agenda no intervalo.
  - **Restauração do título — comprovada.** Google de volta a "QA B2 —
    Reconexão validada" (02:56:53); notificação 02:57:00 → `dirty_at`
    depois da sincronização de 02:55:36; manutenção nº 3 (02:57:28): `synced
    1`; CRM restaurado, `inbound.applied` 6→7, versão 14→15.
  - Escritas do fluxo: renovação do token na nº 1 (conexão 02:52:42);
    criação e atualizações do canal; estado incremental; 3 batimentos
    `manual`; duas aplicações Google → CRM. O CRM não escreveu nos EVENTOS
    do Google (`calendar.effect.update` continua 8), nenhum conflito novo —
    mas criar e parar o canal foram operações reais no Google.
  - **Encerramento — comprovado remoto e local.** Rota
    `stop-channel` (02:58:17) com o id do canal: HTTP 200,
    `remote: stopped` (o Google confirmou), `local: stopped`; canal
    `stopped`/`operator_stop`, uma auditoria `calendar.channel.stopped`.
    Depois: `CALENDAR_WEBHOOK_URL` removida, bypass dedicado revogado (só
    os 3 anteriores restam; o webhook com o segredo revogado recebe 302 da
    proteção), redeploy `dpl_AjGEmn63VGQRWW4sAPSaFjYFtM3m`, arquivos
    temporários com segredos apagados. `CRON_SECRET` da branch mantido.
  - Estado final: conexão `active`; compromisso "QA B2 — Reconexão
    validada", 27/10 17:00–18:30, 90 min, Meet `wai-vuvn-vte`, sem
    convidados (conferido no Google), um único evento, 1 vínculo `in_sync`.
  - Limitações: o processamento foi por manutenção MANUAL; agendador e
    alertas desligados — sincronização automática e meta de atraso NÃO
    validadas. Os números de mensagem do Google não são sequenciais (1,
    137162, 249343): não servem para contar notificações.
- **17/10/2026 — agendador principal (Inngest), sem webhook (UTC):**
  - PR #35 mesclada em `d31212f` (pais `7e053e1` e `1710d8d`); Production
    `dpl_46qSKrDg25yUmWhZ17ioGtya7V5h`, agenda desligada. `main` incorporada
    aqui em `00e83c5`, sem conflito.
  - Painel do Inngest (organização "Praxis CRM", só leitura): plano Hobby,
    0/50.000 execuções/mês na organização inteira (cota compartilhada com
    Production), 5 etapas simultâneas, 1 de 3 usuários; ambientes de branch
    disponíveis (o da A11 já estava arquivado). App de Production
    `praxis-crm` intacto antes e depois (sincronizado em 28/09, 1 função da
    A11).
  - Configuração temporária: `INNGEST_SIGNING_KEY` = chave dos AMBIENTES DE
    BRANCH (prefixo `signkey-branch-`; o painel: "shared for all branch
    environments"), Sensitive, só Preview/`validacao-b2`; bypass dedicado
    "inngest B2 teste" (`1792211520455`, alcance do projeto inteiro);
    `CALENDAR_SCHEDULER_ENABLED=true` só na branch; webhook, alertas, Resend,
    Event Key e A11 ausentes. Redeploy `dpl_HAnCUWUNQvjt6HrtVSCboSxHAPHc`.
  - Sincronização (04:34:57, PUT do SDK): ambiente de branch `validacao-b2`
    criado; app `praxis-crm-agenda`, URL do endereço estável
    `/api/inngest/calendar` com o bypass; função
    `praxis-crm-agenda-b2-calendar-maintenance`, gatilho
    `TZ=UTC */15 * * * *`, 0 retries, concorrência 1 (escopo da função).
  - Alvo e estado inicial: um único alvo (`61af033c`, vínculo `ac694db5`,
    "Praxis — Testes B2.", preview); único canal `stopped`; compromisso
    versão 15; CRM fora da Agenda, sem edição e sem manutenção manual em
    toda a medição.
  - **Execuções automáticas — comprovadas (3 consecutivas, todas do cron):**

    | Previsto | Run ID | Início–fim (Inngest) | Etapa `maintenance` | Técnico | Sincronização (retorno e batimento) |
    |---|---|---|---|---|---|
    | 04:45:00 | `01M542TW70ZAVQCKAF6DMX0H0Y` | 04:45:03–04:45:08 | 04:45:05–04:45:08 | Completed | `ok`, targets 1, synced 1, failed 0 (batimento 04:45:08; token renovado 04:45:07) |
    | 05:00:00 | `01M543PB40ZAVQCKAF6DMX0H0Y` | 05:00:31–05:00:36 | 05:00:33–05:00:35 | Completed | `ok`, synced 1, failed 0 (batimento 05:00:35) |
    | 05:15:00 | `01M544HT10ZAVQCKAF6DMX0H0Y` | 05:15:08–05:15:13 | 05:15:10–05:15:13 | Completed | `ok`, synced 1, failed 0 (batimento 05:15:13) |

    Gatilho de cada uma: `inngest/scheduled.timer`, "Scheduled for" e "Fired
    at" no horário nominal. Nenhuma falha, nenhuma nova tentativa; batimento
    `inngest` 0→3, sempre `ok`; espera do Inngest até começar: 3 s, 31 s e
    8 s.
  - **Mudança e restauração do título — comprovadas (só o título):**
    "QA B2 — Agendador" salvo no Google às 04:47:41 → aplicado no CRM às
    05:00:35 pela execução das 05:00 (**12 min 54 s**; versão 15→16);
    restaurado no Google às 05:02:13 → aplicado às 05:15:13 pela execução
    das 05:15 (**13 min 00 s**; versão 16→17). Amostra observada abaixo da
    meta de 20 min — evidência inicial, não garantia. O pior caso esperado é
    perto de 15 min + a espera do Inngest + a rodada.
  - Escritas do fluxo: renovação de token (04:45:07), estado incremental e
    batimentos a cada rodada, duas aplicações Google → CRM
    (`calendar.inbound.applied` 7→9). O CRM não escreveu nos eventos do
    Google (`calendar.effect.update` continua 8); nenhum conflito novo.
  - **Desligamento — com divergência:** chave removida (05:16), redeploy
    `dpl_AQ9nyrA7RTJNK5bpCCLVZZfbY8SP`, nova sincronização com a lista vazia
    (05:18:07) RECUSADA pela API do Inngest: HTTP 500 "No functions
    registered within your app", `modified: false` — o Inngest não aceita
    app sem funções, então o cron continuaria disparando. Desativação pelo
    painel: função PAUSADA às 05:19:30 (reversível; "No new runs will be
    queued or invoked"). Às 05:32 nenhuma execução nova no horário das 05:30
    (painel com 3 execuções, todas concluídas; batimento parado em 3). O
    painel continua mostrando "Next run" do cron mesmo pausada. Bypass
    revogado às 05:33:30 (restam os 3 anteriores; a rota recebe 302 com o
    segredo revogado). Signing key de branch mantida na `validacao-b2`;
    `CRON_SECRET` intacto; arquivos temporários com segredos apagados;
    nenhuma captura com chave ou bypass.
  - Estado final: conexão `active`; compromisso "QA B2 — Reconexão
    validada", 27/10 17:00–18:30, 90 min, Meet `wai-vuvn-vte`, sem
    convidados (conferido no Google), um único evento, 1 vínculo `in_sync`.
  - Pendências e limitações:
    - O §9.7 promete "sincronizar a lista vazia retira a função" — FALSO
      contra o Inngest real. O app `praxis-crm-agenda` continua no ambiente
      de branch `validacao-b2`, com a função PAUSADA e a URL do bypass já
      revogado; o ambiente de branch se arquiva sozinho 3 dias depois da
      última atividade. Corrigir o procedimento (pausar/arquivar no painel,
      ou manter a função registrada sem gatilho quando desligada) exige
      decisão e PR.
    - A PR #35 descreveu a introspecção sem assinatura como "só a
      contagem": no SDK instalado, em modo cloud, ela responde 401.
    - O contador de execuções do painel seguia em 0/50.000 às 05:35;
      pelo modelo de cobrança a rodada consumiu 6 (3 execuções + 3 etapas)
      — não confirmado no painel.
    - Achado de segurança: a signing key de PRODUCTION (a em uso desde
      28/09 23:47) foi encontrada em duas capturas locais do navegador
      automatizado (28/09, rodada da A11; pasta ignorada pelo git); não
      identificada evidência de exposição externa. As capturas foram
      apagadas — isso não elimina todo o risco; a rotação da chave está
      planejada e depende de autorização.
- **Pendência de usabilidade (não implementada):** a página Agenda mostra
  sempre só a semana atual, sem navegação entre semanas; um compromisso da
  semana seguinte não aparece nela.

### 6.14 Reautorização reconhecida sem o agendador
**Lacuna encontrada** (validação no Preview, 16/10/2026, antes de revogar a
conta de teste): só a manutenção agendada (`runCalendarMaintenance`, pela
rota de cron) marcava `needs_reauth`. A sincronização sob demanda e as ações
interativas engoliam o `invalid_grant` (só o log `calendar_on_demand_failed`
ou "O Google Agenda não foi atualizado…"), a conexão continuava `active` e a
tela de Integrações nunca mostrava "Autorizar novamente" — e o agendador está
desligado em Preview e Production. O comentário de `loadConnectionContext`
dizia o contrário.

**Correção:** o reconhecimento fica no ponto único por onde passam todas as
renovações, `loadFreshTokens` (sob demanda, edição/criação/reagendamento,
disponibilidade, lista de agendas, desconexão, recuperação e manutenção):

| Falha da renovação | Erro de domínio | Conexão | Mensagem |
|---|---|---|---|
| `invalid_grant` (revogado, vencido, senha trocada, 7 dias do modo de teste) | `calendar_reauth_required` | `needs_reauth` | "…use “Autorizar novamente”." |
| `invalid_client`, `unauthorized_client` | `calendar_oauth_misconfigured` | inalterada | configuração do ambiente; o usuário não precisa refazer nada |
| rede, prazo, limite de chamadas, erro temporário | `calendar_refresh_unavailable` | inalterada | "tente de novo em instantes" |

Em todos os casos a operação para ANTES de qualquer chamada de calendário;
atividade, vínculo, evento e histórico ficam intactos. Numa edição já salva
no CRM, a mensagem continua "Salvo no CRM. O Google Agenda não foi
atualizado: …" (nada é apresentado como desfeito). Perda de permissão de
UMA agenda (401/403 da Calendar API) continua sendo atenção no vínculo, não
reautorização: um 401 isolado não comprova `invalid_grant`.

**Consistência** (migration `20261017100000_b2_reauth_if_current`, nova;
nenhuma migration aplicada foi editada): a marcação usa
`mark_calendar_connection_needs_reauth_if_current`, que confere dono,
workspace e ambiente, trava a linha e compara a impressão digital (SHA-256)
do refresh token CIFRADO que a renovação usou com a do gravado. Assim:
- a mesma falha repetida devolve "already", sem nova transição nem auditoria;
- uma falha atrasada do token VELHO, depois de uma reautorização concluída,
  devolve "stale" e não derruba a conexão nova;
- uma conexão desconectada continua desconectada ("disconnected").
A manutenção agendada passou a só contar o caso (a renovação já marcou),
sem a segunda marcação sem essa proteção.

**Limitação:** enquanto o token de acesso guardado não vence (até ~1 h), não
há renovação — uma revogação feita no Google só é reconhecida na próxima
renovação. Não há detecção imediata.

## 7. Isolamento entre ambientes

O Supabase é compartilhado, então o isolamento é de duas camadas:

1. **Ambiente determinado pelo servidor.** O módulo do Google deriva o
   ambiente de `VERCEL_ENV` (`production` | `preview`; nunca de parâmetro
   ou campo do cliente) e o envia **assinado** a cada requisição. Toda RPC valida
   `environment` da conexão, do canal e do vínculo contra o ambiente do
   chamador e **recusa** divergência.
2. **Compromissos e atividades vinculados: recusa total, antes de qualquer
   alteração.** `activities` é dado de negócio compartilhado, e uma atividade
   com vínculo ativo pertence ao ambiente do vínculo. Uma operação do Preview
   sobre um compromisso ou atividade cujo vínculo é de Production é
   **recusada por inteiro**: nenhuma alteração no compromisso, na atividade,
   no vínculo, na base, no canal ou na conexão, **nenhum efeito externo
   enfileirado** e nenhuma chamada ao Google. Não existe modo "grava só o
   efeito local". A recusa **aborta a transação**, então não pode ser auditada
   no próprio banco (o registro seria desfeito junto): quem registra é o
   servidor, em log estruturado com o código `calendar_environment_mismatch`
   e ids internos, sem conteúdo do evento (nas ações de calendário já na
   fundação; nas de atividade, quando a etapa 2 passar a vinculá-las).
   - **Onde fica o controle (no banco, não só na aplicação):** o cliente de
     servidor envia o ambiente em cabeçalho próprio (`X-Praxis-Env`),
     lido no banco via `request.headers`. Um gatilho
     `BEFORE UPDATE OR DELETE` em `activities` consulta o vínculo ativo da
     linha e **aborta a transação** se o ambiente **autenticado** for
     diferente do do vínculo — ou se não houver ambiente autenticado (falha
     fechada). Como o gatilho é de linha, cobre **todos** os caminhos,
     inclusive os que já existem (`update_activity`, `reschedule_activity`,
     `reassign_activity`, `complete_activity`, `delete_activity`) e
     exclusões em cascata por lead ou oportunidade, mescla de contatos e
     qualquer função futura. Os caminhos existentes não mudam de assinatura:
     a proteção entra por migration nova.
   - **O ambiente é AUTENTICADO, não apenas declarado.** Um usuário
     autenticado que chame o PostgREST direto, sem passar pelo servidor do
     CRM, enviaria o mesmo cabeçalho (achado de revisão da PR #24,
     reproduzido em `21_b2_environment_trust.test.sql`: com o cabeçalho
     lido em texto simples, a atividade vinculada a production era alterada).
     Por isso o valor é `<ambiente>.<expira>.<hmac-sha256>`, assinado com
     uma chave **por ambiente**:
     - o servidor assina com `CALENDAR_ENV_SIGNING_KEY` (≥ 32 caracteres,
       valor **diferente** em Preview e Production, escopo da Vercel);
     - o banco guarda as duas chaves em `public.calendar_environment_keys`
       (sem GRANT para ninguém e **sem RPC que as defina**: provisionadas à
       mão, uma vez por ambiente, por quem administra o banco) e só aceita o
       ambiente se a assinatura confere (comparação por HMAC) e o cabeçalho
       não venceu (validade de 10 min; o banco recusa mais de 1 h);
     - cabeçalho ausente, sem assinatura, com assinatura inventada, assinado
       pela chave do **outro** ambiente, vencido ou com validade absurda vale
       como "sem ambiente";
     - um usuário não tem a chave (não lê a tabela nem chama o verificador),
       e o Preview não tem a chave de Production, então não consegue afirmar
       `production`;
     - sem a variável configurada, o servidor não envia cabeçalho e o banco
       recusa tudo o que depende de ambiente (as funcionalidades de agenda
       ficam indisponíveis; atividades sem vínculo não são afetadas);
     - as verificações de usuário, papel e alcance das funções existentes
       continuam valendo, na ordem em que já estavam (provado em pgTAP).
     Limite assumido: um possuidor da chave de service role já tem acesso
     total ao banco; o alvo desta barreira é o usuário autenticado e o
     acidente entre ambientes, não o comprometimento do servidor.
   - O mesmo vale para as tabelas de vínculo, conexão, canal, estado e
     conflito: a RPC recusa quando o ambiente informado difere do da linha.
   - A mudança vinda do Google só é aplicada à atividade pelo ambiente dono do
     vínculo (processamento do próprio ambiente, com o mesmo controle).
   - **Testes de Preview usam registros próprios de QA**, criados pelo teste
     (workspace de QA, atividades e vínculos criados na hora) e **nunca
     modificam registros vinculados em Production**. O caso "vínculo de
     Production" é simulado criando, no próprio teste, uma atividade de QA
     cujo vínculo tem `environment = production`.
3. **Barreiras físicas, independentes do código:** chaves de cifra de tokens
   **distintas por ambiente** (um ambiente não decifra o token do outro);
   clientes OAuth distintos; webhook com endereço do próprio ambiente e
   `token` secreto por canal; agendadores filtram `environment`.
4. **Risco a validar no Preview:** a proteção de deployment da Vercel bloqueia
   chamadas sem sessão e o Google não envia cabeçalhos customizados; o
   webhook do Preview precisa de endereço estável com bypass pela URL. Se não
   funcionar, o Preview opera só por polling (§9) e o webhook é validado em
   Production com a conta de teste.

Critério de teste: um teste automatizado, com registros próprios de QA,
tenta com ambiente `preview` alterar e excluir (por cada caminho existente de
atividade e por cascata) um compromisso/atividade vinculado a `production`, e
altera vínculo, canal e conexão de `production`. Exige **recusa total**: nada
mudou, nenhum efeito foi enfileirado e não houve nenhuma chamada ao Google.
Exige também que, sem o cabeçalho de ambiente, a mutação de atividade
vinculada seja recusada, e que atividade **sem** vínculo continue editável.

## 8. Papéis (conferido em `src/lib/roles.ts`)

Matriz atual relevante: `activity.edit` = owner/admin/manager/lawyer/sales;
`activity.configure` e `pipeline.configure` = owner/admin/manager;
`conversation.simulate` e `form_endpoint.manage` = owner/admin.

Permissões novas (a criar na implementação, seguindo o padrão do arquivo):

| Permissão | Papéis | Efeito |
|---|---|---|
| `calendar.connect_own` | owner, admin, manager, lawyer, sales | conectar, escolher a agenda e desconectar **a própria** conta |
| `calendar.manage` | owner, admin | ver a saúde de todas as conexões do workspace e **desconectar a de outro usuário** (só revoga; nunca lê tokens) |

`viewer` não conecta. Criar/editar/cancelar compromisso reutiliza
`activity.edit` e o alcance por lead já existente (advogado e atendimento só
"seus"), reforçado no banco. A disponibilidade (`freebusy`) de um usuário só
mostra intervalos ocupados, a quem pode agendar com ele no workspace.

## 9. Agendamento, renovação e recuperação

### 9.1 O que se sabe
- **GitHub Actions `schedule`** não dá garantia aqui: na A11 houve intervalo
  de ~6h23 e uma janela com execuções de outros tipos e nenhuma por
  `schedule`. O workflow da A11 **não é alterado nesta etapa**; qualquer uso
  futuro dele na B2 será por arquivo próprio e **apenas como recuperação
  adicional, sem prazo garantido**.
- **Vercel Cron:** Hobby = uma vez por dia, precisão ±59 min; Pro = por
  minuto. O plano da conta **não foi confirmado** (a CLI não expôs).
- **Inngest** (já instalado e com chaves em Production): página de preços
  consultada em 08/10/2026 — plano gratuito: 50 mil execuções/mês, 5 passos
  concorrentes, histórico de 24 h; Pro a partir de US$ 99/mês. **A página não
  informa frequência mínima de cron nem alertas**: **a validar** antes de
  depender dele. Estimativa: uma função a cada 15 min = ~2.900 disparos/mês
  por função; o consumo real (passos contam como execução?) será **medido** na
  validação.

### 9.2 Desenho (sem depender de um único agendador)
1. **Principal:** função agendada do Inngest, a cada 15 min, por ambiente.
2. **Recuperação adicional:** chamada ao mesmo endpoint idempotente por
   GitHub Actions (arquivo novo, depois) e, se o plano permitir, por um cron
   diário da Vercel (o Hobby comporta). Nenhum dos dois tem prazo garantido.
3. **Correção independente do agendador:** abrir a agenda ou criar/editar um
   compromisso dispara sync incremental se o último tiver mais de 5 min. O
   que o usuário vê não depende do agendador estar vivo.
4. **Webhook é só dica.** Canal vencido ou notificação perdida não perde
   dado: o polling por `syncToken` recupera.
5. Sync completo de segurança diário e em todo `410`.

### 9.3 Quem detecta e alerta quando o próprio agendador falha
Um agendador não pode se vigiar. Camadas, nenhuma garantida sozinha:
- Cada execução grava `calendar_scheduler_heartbeat` (ambiente + agendador).
- **Detector 1 (ativo):** a recuperação adicional (GitHub e/ou cron diário da
  Vercel), ao rodar, confere o batimento: se o do Inngest tem mais de 60 min,
  envia e-mail (Resend) aos owner/admin do workspace.
- **Detector 2 (passivo, não depende de agendador):** ao abrir a agenda ou
  `Configurações > Integrações`, owner/admin veem aviso "sincronização
  atrasada" se o batimento passou de 60 min ou se algum canal tem pouca vida.
- **Detector 3 (humano):** verificação semanal manual do batimento durante o
  piloto, enquanto não houver monitoramento da B5/B6.
- Honestidade do desenho: se **todos** os agendadores falharem juntos, o
  atraso só é percebido por Detector 2 ou 3. O tempo de detecção, nesse caso
  extremo, é de até a próxima abertura da tela ou do cron diário.

### 9.4 Renovação de canais
- **`renew_at` a partir da duração efetiva:** ao criar o canal, a API devolve
  `expiration`; `ttl = expiration - agora`; `renew_at = created_at + 0,7 × ttl`
  (margem proporcional de 30%).
- **TTL curto:** se `ttl < 24 h`, a renovação **não** é a cada execução:
  aplica-se histerese (nenhum canal é renovado antes de 50% da vida nem
  antes de 10 min desde a criação do anterior) e, se `ttl < 3 × intervalo do
  agendador` (45 min), o canal não é viável: marca-se `polling_only`, não se
  tenta renovar em laço e há alerta único.
- **Trava de concorrência:** concessão atômica
  (`UPDATE ... SET renewing_until = now() + 2 min WHERE renew_at <= now() AND
  (renewing_until IS NULL OR renewing_until < now()) ... RETURNING`); duas
  execuções simultâneas nunca renovam o mesmo canal.
- **Sobreposição:** cria-se o canal novo **antes** de parar o velho (linha
  `creating` gravada antes da chamada, para saber o id se houver timeout); o
  velho passa a `retiring` e só é parado (`channels.stop`) depois de a
  mensagem `sync` (nº 1) do novo ser recebida ou de passar uma janela de
  segurança. Notificações dos dois são deduplicadas: o sync é de voo único por
  conexão, com debounce.
- Falha ao criar o novo: o velho continua, com tentativa e backoff e alerta
  se faltar menos de 25% da vida.

### 9.5 Encerrar um canal (procedimento operacional)
O mecanismo existe: `stopChannel` (`sync/channels.ts`) pede ao Google
`channels.stop` e depois encerra o canal no banco (`stop_calendar_channel`;
o webhook passa a responder "ignorado"). A manutenção o usa para canal
vencido, abandonado, substituído ou sem vínculo, e a desconexão também para
os canais. Esse helper absorve a falha da chamada ao Google — terminar sem
erro NÃO prova que o canal parou lá. A Calendar API não lista canais: a
única prova remota é a resposta do próprio `channels.stop`.

**Executor no servidor** — `POST /api/cron/calendar/stop-channel`
(`sync/channel-stop.ts`), para encerrar UM canal específico:
- só existe com `VERCEL_ENV=preview`; em Production, ou sem ambiente, 404
  antes de qualquer consulta;
- `Authorization: Bearer <CRON_SECRET>` (`cron-auth.ts`), nunca na URL;
  sem isso, 401 sem efeitos;
- corpo `{ "channelId": "<uuid>" }`, e nada mais (campo extra: 400). Conexão,
  dono, workspace, agenda e recurso vêm do registro gravado
  (`get_calendar_channel_for_stop`, migration `20261018100000`: ambiente
  assinado, canal e conexão do mesmo ambiente e workspace, nenhum segredo
  devolvido). Canal de outro ambiente, inexistente ou inconsistente: 404,
  sem Google nem alteração;
- token pela renovação normal da própria conexão; parada pelo ADAPTADOR
  (`provider.stopChannel`), depois encerramento local com o motivo fixo
  `operator_stop`. Não desconecta, não renova canal e não toca em
  atividade, vínculo, evento, Meet ou convidados;
- sem repetição automática; repetir num canal já encerrado devolve
  `already_stopped` sem nova chamada ao Google;
- conexão sem token agora (a reautorizar, falha temporária): nada é
  encerrado (409), para a parada no Google poder ser tentada de novo;
- resposta só com códigos (`remote`, `local`, `reason`), nunca token,
  endereço, cabeçalho ou corpo de erro do Google. A restrição ao canal de uma
  validação específica é conferida no procedimento, não no código.

| `remote` | Significa | HTTP |
|---|---|---|
| `stopped` | o Google confirmou a parada (2xx) | 200 |
| `provider_404` | o Google respondeu 404: o canal já não existia lá | 200 |
| `http_<status>` | outra resposta do Google: não parou | 202 |
| `indeterminate` | sem resposta (timeout, rede): NÃO se sabe se parou — não prova que continua ativo | 202 |
| `not_attempted` | sem chamada (`reason`: já encerrado, sem recurso, `polling_only`, conexão sem token) | 200 ou 409 |

`local`: `stopped`, `already_stopped`, `unchanged` (409) ou `failed` (500 —
nunca sucesso completo, mesmo com `remote: stopped`).

**Outras formas de cortar as notificações** (não são parada no Google):
- remover `CALENDAR_WEBHOOK_URL` NÃO muda o endereço de um canal já
  registrado: o Google continua enviando para o endereço gravado nele até
  o canal parar ou vencer; a variável só afeta canais criados depois;
- revogar o bypass de automação bloqueia a ENTREGA pela proteção da Vercel
  (as notificações não chegam ao CRM), mas o canal continua existindo no
  Google;
- o canal some sozinho no vencimento (`expires_at`, o valor devolvido pelo
  Google na criação).

**Procedimento para o canal de uma validação:** ler no banco o canal — id,
ambiente `preview`, conexão e agenda esperadas, único vivo —; chamar a rota
com esse id; registrar `remote` e `local`; se `indeterminate` ou
`http_<status>`, registrar o `expires_at` como prazo em que o canal some do
Google; depois remover a URL temporária e revogar o bypass dedicado (os
outros não mudam) e fazer redeploy.

**Bypass dedicado:** o "Protection Bypass for Automation" da Vercel vale
para o projeto inteiro, não para um deployment ou branch. Ser dedicado
facilita revogá-lo sem afetar os outros, mas não reduz esse alcance (no
plano Hobby não há exceção por domínio). Com ele na URL do canal, o segredo
fica na variável do ambiente, na configuração do canal no Google e
possivelmente nos logs de requisição da Vercel; o CRM não guarda o endereço
no banco nem o registra em log.

### 9.6 Cadência do polling sob o cron
O polling vence uma vez por PERÍODO de 15 min alinhado em UTC (os mesmos
períodos do cron), não por "15 min desde a última". A regra antiga fazia a
rodada nominal seguinte pular a agenda sempre que a anterior terminava
segundos depois do horário (`last_run_at` é gravado no fim): a mudança no
Google ficava para a outra rodada, ~30 min depois (reproduzido em
`tests/unit/b2-poll-cadence.test.ts`). Agora o próximo horário nominal
sempre sincroniza, e chamadas repetidas no mesmo período (manual, outro
agendador) continuam sem sincronizar de novo. Marcação do webhook e sync
completo de 24 h não mudaram.

### 9.7 Agendador principal: ativação, medição e desligamento
Seis coisas distintas — não confundir:
| | O que é | Onde |
|---|---|---|
| Ambiente do Inngest | Production ou um ambiente de BRANCH; o SDK anuncia o nome a partir de `VERCEL_GIT_COMMIT_REF` (no Preview, `validacao-b2`; em Production, `main`) | painel do Inngest |
| Ambiente Vercel | `VERCEL_ENV` (`preview`/`production`), que define o ambiente da agenda (§7) | variáveis da Vercel |
| Signing key | `INNGEST_SIGNING_KEY`: a de ambientes de branch (uma só, compartilhada por todas as branches) ou a de Production. É ela que separa os ambientes — nunca a de Production num Preview: a sincronização iria para o app de Production | Vercel, por ambiente/branch |
| App id | `praxis-crm-agenda` (agenda) × `praxis-crm` (A11). Separa os APPS dentro de um ambiente; NÃO isola ambientes | código |
| Lista de funções | `b2-calendar-maintenance` só com `CALENDAR_SCHEDULER_ENABLED=true`; montada no carregamento — mudar a chave exige redeploy + nova sincronização do app | código + Vercel |
| Resultado | TÉCNICO (execução no Inngest: concluída ou falha) × da SINCRONIZAÇÃO (`outcome` ok/partial/failed, contagens, batimento `inngest`) | painel do Inngest × banco |

Resultado técnico: `ok` e `partial` concluem a execução (o retorno traz
`outcome` e as contagens — `partial` nunca é sincronização integral);
`failed` ou exceção vira `StepFailed` com código fixo
(`calendar_maintenance_failed` / `calendar_maintenance_error`), sem pilha
nem mensagem original, sem nova tentativa (`retries: 0`). O batimento já
gravou o desfecho verdadeiro antes. Na medição, conferir os DOIS: verde no
painel não basta.

Configuração mínima no Preview (`validacao-b2`): `INNGEST_SIGNING_KEY` de
ambientes de branch e `CALENDAR_SCHEDULER_ENABLED=true`. Não precisa de
`INNGEST_EVENT_KEY` (não publica eventos), nem da configuração da A11, nem de
`CALENDAR_WEBHOOK_URL`/`CALENDAR_ALERTS_ENABLED`. O Inngest alcança o
Preview protegido pela URL de sincronização com `x-vercel-protection-bypass`
(bypass dedicado, alcance do projeto inteiro; a URL com o segredo fica na
configuração do app no Inngest).

Ativação: variáveis → redeploy → sincronizar `praxis-crm-agenda` no ambiente
de branch `validacao-b2` pela URL `/api/inngest/calendar?...bypass` →
conferir a função e o cron no painel e que o app de Production não mudou.
Medição: ≥ 3 execuções automáticas consecutivas (início/fim no Inngest,
batimento `inngest`, desfecho), mudança e restauração de título no Google
com os horários da mudança, da execução e da aplicação no CRM, sem abrir a
Agenda, sem edição e sem manutenção manual; consumo de execuções (cada
rodada = 1 execução + 1 etapa).
Desligamento: remover `CALENDAR_SCHEDULER_ENABLED` → redeploy →
sincronizar de novo (lista vazia) → conferir que a função saiu, sem
execução em andamento e sem nova execução no horário seguinte → revogar o
bypass. A signing key de branch pode ficar na `validacao-b2`.

### 9.8 Objetivos a validar (não garantias existentes)
- Nenhum canal vence sem substituto por mais de 1 h.
- Defasagem de sincronização ≤ 20 min **com o webhook desligado**, supondo o
  agendador principal vivo; sem ele, vale a sincronização sob demanda e a
  recuperação adicional, sem prazo.
- Alerta de agendador parado em ≤ 60 min **quando** a recuperação adicional
  roda.
Todos medidos na validação com canal forçado a vencer e agendador desligado,
e reportados como medição, não como promessa.

## 10. Critérios de aceite

1. Conexão com escopos mínimos e escolha da agenda; token cifrado com a chave
   do ambiente; o ambiente oposto não o decifra.
2. Compromisso criado no CRM gera **um** evento, mesmo com repetição, `409` ou
   duplo clique; um `409` com marca divergente **não** é adotado.
3. Resultado incerto (timeout simulado) nunca duplica nem perde: reconcilia
   por consulta de estado.
4. Meet opcional: link visível após `pending → success`; falha visível.
5. Convidados: ausentes por padrão; só enviados com opção explícita
   confirmada.
6. Google → CRM: título, horário e cancelamento de evento vinculado refletem
   no CRM; defasagem medida (§9.8).
7. **Conflito:** edição simultânea nos dois lados nunca perde um valor em
   silêncio: o do CRM fica em `calendar_sync_conflicts` e na timeline, com
   restauração; cobre título, horário, cancelamento e Meet; `412` provoca
   releitura e nova comparação.
8. Evento sem vínculo/marca: nunca vira lead/atividade, nunca é alterado ou
   apagado, não é persistido nem logado; só bloqueia disponibilidade.
9. `syncToken` avança só após todas as páginas processadas; falha no meio
   mantém o token anterior; `410` reinicia o estado sem apagar atividades nem
   histórico.
10. Exclusão reconhecida mesmo sem marca na resposta (pelo vínculo local).
11. Sem loop: alteração feita pelo CRM não volta como mudança externa.
12. Desconexão: encerra canais, revoga token, não apaga nada; reconexão
    reencontra os vínculos.
13. Renovação: `renew_at` pela duração efetiva; TTL < 24 h não renova a cada
    execução; duas execuções simultâneas renovam uma vez; sobreposição sem
    perder nem duplicar notificação.
14. **Isolamento:** operações do Preview sobre compromisso, atividade,
    vínculo, canal ou conexão de Production são **recusadas antes de qualquer
    alteração**, sem enfileirar efeito externo e sem chamar o Google, em todos
    os caminhos existentes de edição/exclusão de atividades e em cascata
    (teste automatizado com registros próprios de QA, §7).
15. Permissões por papel conforme §8, RLS forçada e teste de isolamento entre
    workspaces; auditoria das ações; logs sem conteúdo de eventos.
16. Webhook: 2xx rápido para canal conhecido do ambiente; rejeita canal,
    token ou ambiente desconhecidos.
17. Agendamento: batimento gravado, alertas e avisos conforme §9.3, objetivos
    do §9.8 medidos e reportados.
18. Validação inicial só com conta e calendário de teste; a agenda real do
    Henrique só depois, com autorização expressa.

## 11. Ordem proposta

1. **Fundação:** tabelas, cifra por ambiente, permissões, isolamento,
   conexão e escolha da agenda.
2. **CRM → Google:** criar/reagendar/cancelar, `If-Match`, idempotência,
   Meet, `freebusy`, convidados opcionais.
3. **Google → CRM:** sync incremental, conflitos, canais, webhook,
   renovação, agendadores, batimento e alertas. Em duas PRs: **3a**
   (sincronização, canais, webhook e manutenção, com provedor simulado) e
   **3b** (agendadores, batimento e alertas, reconexão, restauração de
   conflito e timeline; §6.11, checklist em §6.10).
4. **Validação** com conta e calendário de teste (Preview, depois
   Production).
5. **Etapa controlada** com a agenda do Henrique.

Cada etapa em PR própria, com CI verde e sem merge sem autorização.

## 12. Pendências (nada foi criado ou configurado)

- **Identificar o super administrador do Workspace** da Vizentini (quem cria
  a organização do Google Cloud, libera o app no Admin e cria o usuário de
  teste).
- **Disponibilidade de uma conta de teste no domínio** com agenda própria. Sem
  ela, o teste usa só o projeto externo em modo de teste (conta dedicada) e o
  app interno é exercitado apenas na etapa do Henrique.
- A validar na implementação: `calendar.events.owned` contra agenda
  compartilhada; dispensa de verificação do app interno; frequência mínima e
  alertas do cron do Inngest e consumo real de execuções; plano atual da
  Vercel; bypass de proteção do Preview para o webhook.
- **Passos para execução posterior (nada feito):** (1) aplicar a migration da
  B2 no hospedado (ref, `--dry-run`, confirmação); (2) gerar duas chaves de
  assinatura distintas (≥ 32 caracteres) e gravar uma em cada ambiente da
  Vercel como `CALENDAR_ENV_SIGNING_KEY`; (3) inserir as MESMAS duas chaves,
  por SQL, em `public.calendar_environment_keys` (uma linha por ambiente);
  (4) gerar as chaves de cifra dos tokens (`CALENDAR_TOKEN_*`), também
  distintas por ambiente. Até a migration ser aplicada, a tela de Integrações
  mostra "não configurada" e não consulta nada de B2.
- Nenhuma credencial, usuário, licença ou serviço externo foi criado ou
  contratado nesta etapa.
- **Usabilidade — navegação entre semanas na Agenda (pendente, separada):** a
  página Agenda mostra sempre só a semana atual; um compromisso da semana
  seguinte não aparece nela (observado na validação do Preview, §6.13 da
  branch `validacao-b2`). Não implementado.
- **Confirmação de "Restaurar valor do CRM" (corrigida):** a mensagem ficava
  no estado do botão, que some quando a ação revalida a página; agora a
  timeline guarda o desfecho e o mostra acima da lista. Sucesso (verde) só
  com o Google igual ao CRM; restaurado só no CRM (envio pendente, recusado,
  incerto, novo conflito ou acesso perdido) é aviso e diz que a restauração
  não foi concluída no Google Agenda. Regras de sincronização inalteradas.
- **Retorno da recuperação automática na tela (pendente, conhecida desde a
  etapa 3b):** depois de "Vincular" a agenda numa reconexão, o relatório da
  recuperação ("… reencontrado(s) … concluída(s)") não aparece: o formulário
  de "Vincular" só mostra erros e some quando a agenda é escolhida (mesmo
  padrão corrigido na PR #30). Evidência real em 16/10/2026 (Preview): a
  recuperação concluiu (auditoria `calendar.link.recovered`,
  `calendar.inbound.applied`, `calendar.link.recovery_completed`) sem nenhuma
  mensagem; "Reencontrar compromissos" mostra o resultado. Não corrigido.
- **Atualização redundante na recuperação (registrada, sem otimização):** na
  mesma recuperação, depois de a entrada trazer o título do Google, a saída
  ainda fez um `update` do mesmo evento com valores já iguais (nenhuma
  criação, nenhum efeito visível).
- **Intervalo completo no conflito de horário (corrigido):** o mecanismo de
  conflito e restauração de horário passou no Google real (validação de
  16/10/2026 no Preview, Google 16h–18h × CRM 17h–18h30). A validação revelou
  que a timeline mostrava só os inícios ("16:00:00" e "17:00:00"),
  escondendo o término e a duração — e restaurar um horário também muda a
  duração. Agora o conflito e a restauração mostram o intervalo completo no
  fuso do escritório ("27/10/2026, 16:00–18:00 (120 min)"; atravessando a
  meia-noite, com as duas datas). Só apresentação dos valores que o banco já
  guardava (`start` e `end`): sem mudança de sincronização, banco ou dados.
