# B2 — Integração com Google Agenda: plano consolidado

Status: **desenvolvimento da B2 concluído e validação controlada em
Preview concluída. A B2 NÃO está operacional em Production**: Production
segue sem configuração de Google/Calendar, e a ativação é uma etapa futura e
controlada. A B3 não foi iniciada. Encerramento e checklist: §13.
Escopo: B2 do plano (§10 e marco B). A B1 não é reaberta; o chatbot é um
projeto separado e fica fora.

Data das verificações na documentação oficial: 08/10/2026. O que não foi
confirmado está marcado como **a validar**.

## 1. Decisões já tomadas

1. Primeira conexão: a conta Google Workspace do Henrique, autorizada por
   ele via OAuth. Ele escolhe a agenda.
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
8. **Só agendas da própria conta na primeira versão** (decisão de 17/10/2026):
   cada usuário escolhe a agenda principal ou uma secundária cujo `dataOwner`
   (CalendarList) é o e-mail da conta conectada. Agenda de outra conta fica
   fora, mesmo com `accessRole` "owner" ou "writer" — `accessRole` "owner"
   NÃO equivale a dono dos dados: o Google o dá também a quem recebeu a
   agenda com "fazer alterações e gerenciar compartilhamento". O escopo
   continua `calendar.events.owned`. Agenda compartilhada é evolução futura:
   exigirá `calendar.events`, novo consentimento de todos e validação real.
   A regra vale no servidor (`isOwnCalendar`, `selectCalendarAction`), não só
   na tela. Trocar a agenda escolhida afeta só compromissos NOVOS: os
   existentes continuam na agenda registrada no próprio vínculo.

## 2. O que a documentação oficial confirma

| Tema | Fato (fonte: developers.google.com/workspace/calendar) |
|---|---|
| Webhook | Endereço HTTPS com certificado SSL válido. A notificação **não tem corpo**: só cabeçalhos (`X-Goog-Channel-ID`, `X-Goog-Resource-State`, `X-Goog-Message-Number`, `X-Goog-Channel-Token` se definido). Nenhuma verificação de domínio é citada. |
| Canal | Sem renovação automática: é preciso criar outro com `watch` antes do vencimento. A duração vem do pedido ou do limite interno do Google, o mais restritivo; **não há TTL fixo documentado**, vale sempre o `expiration` devolvido. |
| Primeira mensagem | `sync` com `X-Goog-Message-Number: 1` ao criar o canal. |
| `syncToken` | **Incompatível** com `iCalUID`, `orderBy`, `privateExtendedProperty`, `q`, `sharedExtendedProperty`, `timeMin`, `timeMax`, `updatedMin`. Parâmetros idênticos do sync inicial em diante, senão `400`. `showDeleted` não pode ser `false`: eventos apagados vêm sempre. `nextSyncToken` só vem na última página. `410` = descartar o estado local e refazer o sync completo. |
| Escritas | `If-Match` com o `etag`: se mudou, `412`; a orientação é reler e reaplicar. |
| Meet | `conferenceData.createRequest` com `requestId` novo e `conferenceDataVersion=1`; criação assíncrona (`pending` → `success`). Antes de habilitar conferência em app que guarda eventos, fazer sync completo. |
| Escopos | Mais estreitos: `calendar.events.owned` (eventos de agendas **das quais o usuário é dono**), `calendar.freebusy`, `calendar.calendarlist.readonly`. O escopo amplo `calendar` não é necessário. Agenda de outra conta exigiria `calendar.events` ("View and edit events on all your calendars"); fora da primeira versão (decisão 8). A CalendarList traz `primary` e `dataOwner` ("The email of the owner of the calendar. Set only for secondary calendars"); `accessRole` é o papel efetivo, não a propriedade. |
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
  exato liga); sem ela a lista de funções volta vazia e nada é agendado —
  enquanto a função nunca tiver sido sincronizada. Uma função já
  sincronizada NÃO sai do Inngest por isso: interrompe-se com a pausa no
  painel (§9.7). Mesmo ligada, sem provedor configurado a rodada não toca
  em nada. Rodada
  `failed` vira FALHA da execução no Inngest (§9.7).
- **Sob demanda** (§9.2.3): abrir a Agenda, criar ou editar um compromisso
  sincroniza as agendas da PRÓPRIA conexão cuja última execução tem mais de
  5 min — depois da resposta (`after`), com a mesma trava da manutenção, no
  máximo 5 agendas por vez. Não depende de chave: sem provedor, nada.
- **Recuperação adicional** (`.github/workflows/b2-calendar-recovery.yml`
  + `scripts/b2-calendar-recovery.ts`): só `workflow_dispatch`, sem
  `schedule`, sem endereço padrão. Quem dispara informa o destino, e o
  script só aceita os da lista APROVADA, por comparação exata da string
  (hoje, só o Preview da `validacao-b2`): barra no fim, `http`,
  credenciais embutidas, caminho, parâmetro, porta, domínio parecido ou
  outro ambiente são recusados **antes de qualquer requisição**. Segredos
  próprios da B2, que ainda não existem: `B2_CALENDAR_CRON_SECRET` (mesmo
  valor do `CRON_SECRET` do ambiente) e `B2_CALENDAR_BYPASS_SECRET` (bypass
  da Vercel dedicado à B2 — o `VERCEL_AUTOMATION_BYPASS_SECRET` é da A11 e
  não é usado nem alterado). Chama `/api/cron/calendar?source=github` com o
  segredo e o bypass só em cabeçalhos (nada na URL) e não segue
  redirecionamento. Até a correção (17/10/2026) o workflow aceitava
  qualquer `target_url` HTTPS e mandava o bypass da A11 na URL. Agendá-lo é
  decisão da etapa 4.
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
  evento, pelo Resend já usado nas propostas. **Destinatário de teste**
  (`CALENDAR_ALERTS_TEST_RECIPIENT`, só com `VERCEL_ENV=preview`; em
  Production é ignorada): um único endereço substitui a lista inteira — um
  envio por alerta, por mais owner/admin que a consulta devolva; a reserva
  e o intervalo de 6 h são os mesmos, e o alerta enviado fica registrado
  com a nota `test_recipient`. Configuração presente mas inválida (dois
  endereços, nome, quebra de linha…) falha sem enviar a ninguém
  (`test_recipient_invalid`, não conta para o intervalo) — nunca cai para
  os destinatários reais.
- **Detector 2** (§9.3): na Agenda e em Integrações, owner/admin veem aviso
  quando há compromissos vinculados e o agendador PRINCIPAL (Inngest) está
  atrasado (nenhuma execução dele em 60 min, ou nunca rodou), quando ele
  roda mas a última execução falhou (com quando foi a última sem falhas),
  quando parte das agendas falhou (as demais foram atualizadas) ou há canal
  com menos de 25% da vida — cada caso com a sua mensagem. A recuperação
  adicional (GitHub) aparece como **informação à parte**, com horário e
  resultado, e não apaga nem suaviza o aviso do principal: ela não comprova
  que o principal funciona. Chamada manual não conta para nada. Até a
  correção (17/10/2026) o atraso era medido pela execução automática mais
  recente de qualquer agendador, e uma recuperação bem-sucedida escondia o
  Inngest parado. Com o agendador desligado, o aviso é informativo: abrir a
  página Agenda pode disparar a atualização da agenda conectada, no máximo
  uma vez a cada 5 min (a regra da sob demanda), e criar ou editar um
  compromisso também.
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
3. **Branch de validação** `validacao-b2`, com endereço estável de Preview;
   o **endereço de retorno exato** do cliente OAuth é esse endereço seguido
   de `/api/calendar/oauth/callback` (em Production, o domínio de Production
   com o mesmo caminho).
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
  atrasada" se o batimento do agendador principal passou de 60 min ou se
  algum canal tem pouca vida; a recuperação adicional aparece à parte e não
  conta como o principal.
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
| Lista de funções | `b2-calendar-maintenance` só com `CALENDAR_SCHEDULER_ENABLED=true`; montada no carregamento — LIGAR exige redeploy + nova sincronização do app; DESLIGAR a chave não retira a função do Inngest (lista vazia é recusada): a interrupção é a pausa no painel | código + Vercel |
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
Preview protegido pela URL de sincronização com o mecanismo de bypass de
automação da Vercel.

Ativação: variáveis → redeploy → sincronizar `praxis-crm-agenda` no ambiente
de branch `validacao-b2` pela URL `/api/inngest/calendar?...bypass` →
conferir a função e o cron no painel e que o app de Production não mudou.
Medição: ≥ 3 execuções automáticas consecutivas (início/fim no Inngest,
batimento `inngest`, desfecho), mudança e restauração de título no Google
com os horários da mudança, da execução e da aplicação no CRM, sem abrir a
Agenda, sem edição e sem manutenção manual. Consumo: ESTIMADO pelo modelo
de cobrança (cada rodada = 1 execução + 1 etapa); o contador do painel não
o confirmou na medição de 17/10/2026 (seguia 0/50.000).

**Interrupção temporária — a PAUSA no painel do Inngest** (ambiente certo →
Functions → `b2-calendar-maintenance` → All actions → Pause): é o que
impede novas execuções. Antes de pausar, conferir execuções em andamento
(Runs); depois, conferir o estado "Paused" (o menu passa a oferecer
"Resume") e que nenhuma execução nova aparece no horário nominal seguinte.
O painel pode continuar exibindo "Next run" do cron com a função pausada.

Sincronizar a lista vazia NÃO retira a função: com a chave desligada o SDK
apresenta zero funções, mas o serviço RECUSA o registro ("No functions
registered within your app", HTTP 500, `modified: false`; 17/10/2026) e a
função antiga continua registrada, com o cron. Não usar o arquivamento
automático do ambiente de branch como desligamento: é limpeza, não
interrupção controlada.

Medidas COMPLEMENTARES (não substituem a pausa): remover
`CALENDAR_SCHEDULER_ENABLED` e fazer redeploy (o deployment deixa de
oferecer a função — uma chamada do Inngest para ele falharia, não seria
"desligada"); revogar o bypass dedicado (a Vercel barra as chamadas do
Inngest ao Preview; a configuração do app no Inngest não muda). A signing
key de branch pode ficar na `validacao-b2`.

**Retomada** (só com decisão explícita): conferir, nesta ordem, o
deployment do Preview (commit esperado, `Ready`, alias estável),
`CALENDAR_SCHEDULER_ENABLED=true` só na branch, `INNGEST_SIGNING_KEY` de
branch, o ambiente do Inngest (`validacao-b2`, não Production), a URL do app
acessível (bypass válido; introspecção ASSINADA respondendo pelo SDK) e a
função sincronizada com o cron esperado — só então "Resume". Sem
assinatura válida o SDK responde 401 a tudo, inclusive à introspecção.

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

## 12. Pendências do plano (registro histórico; situação atual no §13)

- **Identificar o super administrador do Workspace** da Vizentini (quem cria
  a organização do Google Cloud, libera o app no Admin e cria o usuário de
  teste).
- **Disponibilidade de uma conta de teste no domínio** com agenda própria. Sem
  ela, o teste usa só o projeto externo em modo de teste (conta dedicada) e o
  app interno é exercitado apenas na etapa do Henrique.
- Agenda compartilhada: decidida como evolução futura (§1, decisão 8); não
  é mais pendência de validação da primeira versão.
- A validar na implementação: dispensa de verificação do app interno; frequência mínima e
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

## 13. Encerramento do desenvolvimento

### 13.1 Status oficial
- **Desenvolvimento da B2 concluído** (código na `main` até a PR #38).
- **Validação controlada em Preview concluída**, com conta Google e agenda
  secundária dedicadas a teste e dados fictícios.
- **A B2 NÃO está operacional em Production.** Production continua sem
  nenhuma configuração de Google/Calendar; a integração não está
  configurada nem ativada.
- A **ativação em Production** é uma etapa futura e controlada (§13.8),
  cada passo com autorização.
- **A B3 não foi iniciada.**

### 13.2 Validado com o Google real (Preview)
Cada fluxo foi exercitado uma vez, com uma única submissão, conferindo CRM,
banco e Google depois de recarregar:
- **OAuth e escolha da agenda:** conexão com os escopos mínimos e escolha de
  agenda própria; tokens cifrados com a chave do ambiente.
- **CRM → Google:** criação, edição de título e reagendamento no mesmo
  evento; durações de 60, 90 e 120 min e horários no fuso do escritório.
- **Disponibilidade:** consulta de livre/ocupado e recusa de criação com
  "só criar se o horário estiver livre", sem efeito colateral.
- **Meet:** criação sob demanda, link visível após o Google concluir;
  remoção pelo Google refletida no CRM.
- **Convidados:** ausentes por padrão; um convite com confirmação explícita
  foi recebido e aceito por um endereço controlado fora da conta conectada.
- **Google → CRM:** título, horário, Meet e cancelamento aplicados pela
  sincronização sob demanda, pelo webhook (com manutenção manual) e pelo
  agendador.
- **Conflitos:** título e horário editados nos dois lados; o Google
  prevalece, o valor do CRM fica guardado na timeline e "Restaurar valor do
  CRM" o devolve ao Google, com confirmação visível.
- **Revogação e reautorização:** acesso revogado no Google → conexão
  "a reautorizar" na renovação seguinte → "Autorizar novamente" devolve a
  MESMA conexão, sem nova escolha de agenda e sem duplicar nada.
- **Reconexão e reencontro:** desconectar e reconectar a mesma conta
  reencontrou o vínculo e trouxe a mudança feita no Google enquanto
  desconectado; repetir "Reencontrar compromissos" não altera nada.
- **Cancelamentos:** evento excluído no Google (atividade mantida, vínculo
  "cancelado no Google", sem recriação); remoção pelo CRM (evento sai, a
  atividade fica livre); exclusão da atividade (evento removido antes).
- **Webhook:** canal criado, notificação aceita, mudança aplicada e canal
  encerrado no Google e no banco.
- **Agendador:** três execuções automáticas consecutivas do Inngest, com
  mudança no Google aplicada em cerca de 13 min sem abrir a Agenda
  (amostra, não garantia); pausa conferida.
- **Recuperação adicional e alerta:** com o agendador parado, o disparo
  manual sincronizou e enviou um único alerta (recebido); o segundo
  disparo respeitou o intervalo e não reenviou.
- **Sem duplicação:** em todos os cenários exercitados, um evento e um
  vínculo por compromisso, e nenhum conflito espúrio.

O recurso temporário de videoconferência usado na validação foi removido
do compromisso de QA.

### 13.3 Comprovado só por testes automatizados
- paginação da listagem e avanço do `syncToken` só na última página;
- `syncToken` inválido (410), inclusive em página posterior;
- concorrência e idempotência: duplo clique, 409 com marca divergente,
  resultado incerto, travas de sincronização e de renovação;
- renovação de canais perto do vencimento, com sobreposição e TTL curto;
- isolamento Preview × Production e entre workspaces (RLS, pgTAP);
- respostas malformadas e falhas do provedor (Meet, disponibilidade,
  renovação de token, permissões perdidas);
- rejeições do webhook; recusa de agenda que não pertence à conta.

### 13.4 Matriz dos critérios de aceite (§10)
Real = validado com o Google real em Preview · Auto = só teste automatizado
· Prod = ainda depende da ativação em Production.

| # | Critério | Situação |
|---|---|---|
| 1 | Escopos mínimos, agenda própria, cifra por ambiente | Real · Auto (cifra do ambiente oposto) · Prod |
| 2 | Um evento por compromisso | Real · Auto (duplo clique, 409) |
| 3 | Resultado incerto sem duplicar nem perder | Auto |
| 4 | Meet opcional e falha visível | Real · Auto (falha) |
| 5 | Convidados só com confirmação explícita | Real · Prod (remetente) |
| 6 | Google → CRM e defasagem | Real (amostra) · Prod |
| 7 | Conflito sem perda silenciosa | Real (título, horário) · Auto (cancelamento, Meet, 412) |
| 8 | Evento sem vínculo intocado | Auto |
| 9 | `syncToken` e 410 | Auto (limitação aceita, §13.5) |
| 10 | Exclusão reconhecida pelo vínculo local | Real |
| 11 | Sem loop | Real |
| 12 | Desconexão e reconexão | Real · Auto (revogação do token e encerramento de canal na desconexão) |
| 13 | Renovação de canais | Auto (limitação aceita, §13.5) |
| 14 | Isolamento Preview × Production | Auto · Prod |
| 15 | Papéis, RLS, auditoria, logs | Auto · Real (auditoria) |
| 16 | Webhook | Real · Auto (rejeições) |
| 17 | Agendamento, batimento, alertas | Real · Prod (objetivos do §9.8) |
| 18 | Teste só com conta de teste; Henrique depois | Real · Prod |

### 13.5 Limitações aceitas para o piloto
- **Agenda compartilhada:** fora da primeira versão (§1, decisão 8). Será
  evolução futura, com o escopo `calendar.events`, novo consentimento e
  validação real.
- **Paginação, 410 e renovação perto do vencimento** não foram provocados
  no Google real; têm cobertura automatizada e não bloqueiam o piloto. A
  primeira listagem completa grande e a primeira renovação serão
  observadas na ativação.
- **Conta de teste do domínio da Vizentini:** recomendada, não
  obrigatória. Se não existir ou tiver custo, a alternativa é uma ativação
  controlada diretamente com a conta do Henrique, com autorização expressa.
- **Remetente dos convites:** numa agenda secundária o destinatário vê o
  identificador técnico da agenda. A recomendação inicial é a agenda
  principal do Henrique — **a confirmar**: não foi validada; a
  apresentação deve ser conferida com um convite controlado na ativação.
- **Agendador, webhook e alertas** ficam desligados fora das rodadas
  controladas.
- **Recuperação interrompida:** os vínculos ficam pendentes até
  "Reencontrar compromissos".

### 13.6 Melhorias futuras de interface
- navegação entre semanas na Agenda (hoje só a semana atual);
- retorno visível da recuperação automática depois de "Vincular";
- confirmação após excluir uma atividade vinculada;
- localização de compromissos futuros em listas extensas (uma reunião da
  semana seguinte não foi encontrada na Central de Atividades; não
  investigado).

### 13.7 Resíduos de QA
Dados e vínculos fictícios de QA foram preservados no ambiente de
validação para rastreabilidade. A limpeza será decidida no encerramento
desse ambiente.

### 13.8 Checklist futuro de Production
Em ordem, cada passo com autorização:
1. Confirmar o administrador do Google Workspace da Vizentini.
2. Decidir entre conta de teste do domínio e ativação controlada com a
   conta do Henrique (§13.5).
3. Criar e configurar o projeto Google Cloud de Production (público
   interno; confirmar dispensa de verificação).
4. Configurar o cliente OAuth com o endereço de retorno de Production.
5. Provisionar as chaves próprias de Production (assinatura de ambiente e
   cifra de tokens), distintas das do Preview.
6. Cadastrar a assinatura de ambiente no banco.
7. Validar primeiro uma agenda própria (conexão, criação, edição,
   Google → CRM).
8. Configurar e validar o webhook.
9. Ativar e medir o agendador (execuções conferidas no painel e no
   batimento).
10. Ativar os alertas para os destinatários reais.
11. Validar um convite controlado e a apresentação do remetente.
12. Confirmar o isolamento Preview × Production com registros reais.
13. Só então autorizar o uso regular.
