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
- Token inválido (`invalid_grant`): conexão `needs_reauth`, aviso ao usuário.

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
| Batimento do agendador e alertas: batimento, e-mail do Detector 1, aviso na tela do Detector 2 (§9.3) | **3b**; medição do §9.5 na **4** | feito na 3b, e-mail **desligado** (`CALENDAR_ALERTS_ENABLED`) |
| Reconexão reencontra os vínculos pela marca (critério 12) | **3b** | feito |
| Restauração do valor do CRM que perdeu num conflito (critério 7) | **3b** | feito (título e horário) |
| Conflito e restauração na timeline do lead (critério 7) | **3b** | feito |
| `CALENDAR_WEBHOOK_URL` e liberação da proteção do Preview para o webhook | **4** | pendente |
| Comportamento real do Google (token, paginação, `410`, vida dos canais, cabeçalhos) e metas do §9.5 | **4** | pendente |
| Pendências do administrador do Workspace e da conta de teste (§12) | **4** (validação externa) | pendente |

### 6.11 Agendadores, alertas, reconexão e restauração (etapa 3b)
Implementado com o provedor **simulado** (migration
`20261012100000_b2_scheduler_alerts_restore`, não aplicada ao hospedado).
**Tudo o que roda sozinho ou envia algo para fora começa desligado, e
continua desligado depois do merge.**

- **Agendador principal** (`src/server/calendar/inngest.ts`): função do
  Inngest a cada 15 min (`TZ=UTC */15 * * * *`), uma por vez, sem novas
  tentativas em laço. Só é oferecida ao Inngest com
  `CALENDAR_SCHEDULER_ENABLED=true` (só o valor exato liga); sem ela a lista
  de funções volta vazia e nada é agendado. Mesmo ligada, sem provedor
  configurado a rodada não toca em nada.
- **Sob demanda** (§9.2.3): abrir a Agenda, criar ou editar um compromisso
  sincroniza as agendas da PRÓPRIA conexão cuja última execução tem mais de
  5 min — depois da resposta (`after`), com a mesma trava da manutenção, no
  máximo 5 agendas por vez. Não depende de chave: sem provedor, nada.
- **Recuperação adicional** (`.github/workflows/b2-calendar-recovery.yml`):
  só `workflow_dispatch`, sem `schedule`, sem endereço padrão (quem dispara
  informa), com segredo próprio `B2_CALENDAR_CRON_SECRET` (mesmo valor do
  `CRON_SECRET` do ambiente; ainda não existe). Chama
  `/api/cron/calendar?source=github`. Agendá-lo é decisão da etapa 4.
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

### 9.5 Objetivos a validar (não garantias existentes)
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
   no CRM; defasagem medida (§9.5).
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
    do §9.5 medidos e reportados.
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
