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
  — criação: `events.get` do id (200 e confere → sucesso; 404 → pode repetir);
  atualização: relê e compara com o estado pretendido (igual → sucesso; igual
  à base → repete com `If-Match`; outro → reaplica a regra 6.3); exclusão:
  `events.get` (404/cancelado → sucesso). Intenção sem desfecho vira alerta.

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
   renovação, agendadores, batimento e alertas.
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
