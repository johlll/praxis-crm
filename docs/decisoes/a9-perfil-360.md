# A9 — Perfil 360º do lead: decisões

## 1. Escopo recuperado do plano original e o que muda dele

O plano (§12, fase A9) descreve: "as 6 abas, `ActivityTimeline` filtrável,
composer (anotação/mensagem/atividade), `AttributionPanel` com a sequência
de touchpoints, blocos de consulta, proposta e verificação de conflito,
ações de ganho/perda/conversão. Sem upload livre nesta fase (correção 14) e
somente metadados da proposta (número, valor, modelo, status, datas) —
nenhuma geração de PDF, que fica exclusivamente em B1".

As 6 abas vêm literalmente do protótipo aprovado (`Perfil 360 do Lead.dc.html`,
array `ABAS`): **Visão geral, Conversas, Atividades, Arquivos, Propostas,
Histórico**.

Duas peças do parágrafo acima colidiram com decisões já tomadas ou com uma
lacuna real do plano, e foram resolvidas com o usuário antes de começar a
implementação (não foram decisões unilaterais):

- **`AttributionPanel`/touchpoints — omitido nesta fase.** A A8 já havia
  registrado explicitamente (`a8-clientes.md`, revisão pré-merge) que
  "atribuição comercial/touchpoints fica para a A11". Não existe
  `touchpoints`, nem canal/UTM/campanha em `leads`/`contacts`. Implementar o
  painel na A9 exigiria inventar uma fonte de dado que não existe. Decisão:
  **o painel não aparece nesta fase** — nem como seção vazia, nem como
  placeholder. Entra completo na A11, quando o modelo de touchpoints existir
  de verdade.
- **Verificação de conflito — lacuna real de schema no plano (§6), resolvida
  com um registro manual mínimo.** O protótipo tem um bloco "Verificação de
  conflito" (status, responsável, data, nota) que nenhuma seção do plano
  original define. Decisão: nova tabela `conflict_checks`, **1 registro por
  lead**, preenchido manualmente pelo advogado/gestor — sem busca automática
  nem cruzamento de dados contra clientes/partes adversas (isso exigiria um
  motor de comparação que não existe e não foi pedido). Ver §5.

Tudo o mais do parágrafo do plano é implementado nesta fase.

## 2. Onde vive o Perfil 360 — não é uma rota nova

`src/app/(app)/leads/[id]/page.tsx` já era, na prática, um perfil básico do
lead (dados, responsável, status, oportunidades, atividades pendentes). A
A9 **enriquece essa mesma rota** em vez de criar `/leads/[id]/360` ou
equivalente — o protótipo em si mostra o breadcrumb "Leads / Juliana Prado",
confirmando que é a MESMA entidade "lead", não uma tela separada.

A oportunidade mostrada no painel direito (etapa, próxima ação, ganho/
perda) é a **oportunidade aberta mais recente do lead** (ou, se não houver
nenhuma aberta, a mais recente por `created_at`) — um lead pode ter mais de
uma oportunidade ao longo do tempo (nova consulta após uma perda, por
exemplo), mas o protótipo só tem espaço para uma no painel de contexto.
As demais continuam listadas em `LeadOpportunitiesSection`, inalterada.

## 3. Reaproveitamento — nenhuma lógica de ganho/perda/etapa é duplicada

Pesquisa prévia ao código confirmou que praticamente tudo que a A9 precisa
para ações de oportunidade já existe e é desacoplado do kanban:

- `OpportunityDetailPanel` (`src/components/pipeline/opportunity-detail-panel.tsx`)
  já compõe dados da oportunidade, histórico de etapas, `ActivitiesSection`
  e os diálogos `WonDialog`/`LostDialog` — é literalmente reaproveitado
  dentro da aba "Visão geral" para a oportunidade ativa do lead, sem
  reimplementar nada.
- `win_opportunity()` (RPC da A5) já cria/reaproveita o `client` e o
  `client_handoff` pendente atomicamente — não existe um botão "converter em
  cliente" separado do fluxo de ganho; o botão do protótipo
  ("Converter em cliente e caso jurídico") mapeia para o mesmo "Marcar como
  ganho" já existente (rótulo ajustado no componente reaproveitado).
- Avançar/voltar etapa: reaproveita `moveOpportunityStageAction`,
  `checkStageRequirementsAction` e `StageAdvanceDialog`, já genéricos e sem
  dependência do board — a única peça nova é a barra de progresso visual
  das etapas (`StageProgressBar`), que não existia em lugar nenhum do
  código.
- "Próxima ação" com concluir/reagendar: reaproveita `ActivitiesSection` +
  `ActivityRowActions`, já embutidos no `OpportunityDetailPanel`.
- CPF mascarado com revelação auditada: reaproveita o componente e o fluxo
  já existentes na página de contato (`SensitiveField`/fluxo de A3), sem
  segunda implementação.

Nenhuma dessas peças foi copiada ou reescrita — são importadas como estão.

Ajustes feitos depois de rodar os e2e existentes contra a página nova
(nenhuma regra de negócio mudou, só composição de UI):

- `OpportunityDetailPanel` ganhou o prop opcional `showClientLink`
  (default `true`, comportamento inalterado em `/oportunidades/[id]`),
  desligado só na página de lead — sem ele, o "Ver cliente" do cabeçalho
  colidia com o do painel.
- A `ActivitiesSection` (lista completa, com "Nova atividade" e as ações
  de reagendar/transferir/concluir de cada linha) fica na aba "Visão
  geral" — é a mesma seção que o e2e da A6 já exercita de ponta a ponta
  (criar → reagendar → transferir), então ela precisa estar acessível
  sem trocar de aba. `OpportunityDetailPanel` ganhou também
  `showActivities` (default `true`) para não montar uma SEGUNDA
  `ActivitiesSection` (a dele, escopada só a esta oportunidade) ao lado
  da do lead inteiro.
- A linha do tempo mostra o MESMO evento de atividade, mas nunca com o
  título sozinho: `detail` é `"{título} — agendada/concluída"`, nunca só
  `"{título}"`. Achado real do e2e: com os dois nós de texto idênticos
  (`"Revisar contrato (teste e2e)"` na lista E na timeline),
  `getByText(título, {exact:true})` resolvia para dois elementos. A
  aba "Atividades" reaproveita a MESMA `ActivitiesSection`/consulta —
  nunca as duas instâncias montadas ao mesmo tempo (abas são mutuamente
  exclusivas).

## 4. O que é novo nesta fase

- **`proposals`** (schema já previsto no plano §6.5, implementado agora):
  número, oportunidade, valor, modelo de honorários, status
  (`rascunho → enviada → aceita | recusada`), canais de envio, datas de
  envio/decisão. **Sem `document_path` nem geração de PDF** — essa coluna e
  a geração entram só na B1 (emenda 2 do plano). Projeção financeira por
  papel reaproveita a MESMA função da A5
  (`private.opportunity_financial_projection`, adaptada para o formato de
  proposta sem probabilidade/previsão — nova função
  `private.proposal_financial_projection` que segue a idêntica política:
  viewer nada, sales só a faixa via `private.money_band_label`, os demais o
  valor exato).
- **`conflict_checks`** (nova, decisão registrada em §1): status, quem
  verificou, quando, nota — 1 por lead, sem histórico de versões (upsert).
- **`lead_notes`** (nova): anotação livre do composer ("Anotação"), sem
  edição nem exclusão — append-only, como `activities`/`stage_transitions`.
  Não existia nenhuma forma de registrar uma nota solta hoje (só notas
  presas a uma atividade específica).
- **Timeline unificada paginada** (`get_lead_timeline`): cruza
  `lead_notes` + `activities` + `messages` (via `conversations` do lead) +
  `stage_transitions` (via oportunidades do lead) + `proposals` +
  `conflict_checks` num único feed cronológico. Ver §6 para a regra de
  paginação.
- **`list_conversations` ganha `p_lead_id`** (parâmetro novo, aditivo): hoje
  só filtra por workspace; a aba "Conversas" precisa das conversas de UM
  lead.
- **`StageProgressBar`**: componente visual novo (barra das N etapas do
  pipeline do lead, com a etapa atual destacada) — não existia em nenhuma
  tela.

## 5. Permissões — nada de novo, mesma regra de sempre

Todo dado novo (`proposals`, `conflict_checks`, `lead_notes`) é acessado
**apenas** através de RPCs `SECURITY DEFINER`, reaproveitando sem mudança:

- `private.has_workspace_role(...)` — gate de papel no workspace.
- `private.lead_accessible_to_role(role, lead.assigned_to, actor)` — alcance
  por registro (advogado só vê o que é seu ou sem responsável). Como
  `proposals`/`conflict_checks`/`lead_notes` sempre carregam `lead_id`
  (mesma decisão da A6 para `activities`: tudo pendura do lead, nunca da
  oportunidade sozinha), a checagem é idêntica à de atividades — sem
  reinventar.
- `private.conversation_accessible_to_role(...)` — reaproveitada sem
  mudança para incluir mensagens na timeline.
- Projeção financeira: `private.opportunity_financial_projection` (já
  existente, oportunidades da timeline) e a nova
  `private.proposal_financial_projection` (mesma política, adaptada ao
  formato de proposta).
- Negação sempre vira "não encontrado" — nunca 403 — mesmo padrão de
  `get_lead`/`get_opportunity`/`get_client`.
- Todas as tabelas novas: RLS habilitada e forçada, `select/insert/update/
  delete` negados por policy para `authenticated` (mesmo padrão de
  `activities`/`leads` — nenhuma leitura/escrita direta do cliente, tudo via
  RPC).
- `conflict_checks`: escrita restrita a `owner/admin/manager/lawyer` (mesma
  lista de quem pode mover oportunidade) — `sales`/`viewer` só leem
  `status`/`checked_at`; o texto da nota é filtrado dentro da própria RPC
  para esses dois papéis (decisão explicitada em §11 depois do review
  pós-CI — a versão original não distinguia nota de status na leitura).
- `proposals`: criar/enviar/decidir segue a mesma lista de papéis com
  escrita em oportunidades (`owner/admin/manager/lawyer/sales`, alcance por
  registro); leitura do valor sempre passa pela projeção.

## 6. Timeline: ordenação determinística e paginação por cursor

Copiado literalmente do padrão já validado em `list_conversation_messages`
(A7, revisado por flakiness documentada tanto em A7-HANDOFF quanto na
correção da A8/PR #12 nesta mesma sessão): cursor composto
`(occurred_at, id)`, nunca `occurred_at` sozinho — dois eventos com o
MESMO timestamp (comum quando vários registros nascem na mesma transação)
são desempatados pelo `id`, sem o que uma página poderia pular ou repetir
eventos empatados entre duas buscas.

Cada linha da timeline é um evento sintético (`jsonb`) com `event_type`,
`occurred_at`, `id` (do registro de origem), e um payload mínimo específico
do tipo — nunca o registro bruto (ex.: uma proposta na timeline mostra
número/valor projetado por papel, nunca `decision_note` interno se o
usuário não tiver acesso).

Falha de consulta (erro do RPC) propaga uma exceção tratada no módulo
(`LeadTimelineLoadError`, mesmo padrão de `ActivitiesLoadError`/
`ConversationsLoadError`) — nunca vira silenciosamente uma lista vazia. A
tela usa `error.tsx` para diferenciar isso de "sem eventos ainda"
(`EmptyState`).

## 7. Aba "Arquivos" — sem upload, sem lista fictícia

Correção 14 do plano mantém upload de documentos fora do MVP (entra só na
B4, condicionado ao piloto). A aba "Arquivos" existe (é uma das 6 abas do
protótipo) mas mostra um `EmptyState` explícito ("Envio de arquivos ainda
não está disponível — previsto para a fase B4") — nenhum arquivo fictício,
nenhum botão de upload funcional.

## 8. Composer — anotação, mensagem (condicional), anexo (desabilitado)

- **Anotação**: cria um `lead_notes`, aparece na timeline imediatamente.
- **Atividade**: não é um botão do composer — a `ActivitiesSection` já
  visível na "Visão geral" (ver §3) já tem seu próprio "Nova atividade";
  um segundo gatilho no composer duplicaria esse botão na mesma tela
  (achado real do e2e, mesma classe do achado da timeline em §3).
- **Mensagem**: só habilitado se já existir ao menos uma `conversation`
  vinculada a este lead (reaproveita `sendMessageAction`, A7). Sem
  conversa vinculada, o botão fica desabilitado com texto explicando o
  motivo — a A9 não cria um canal de WhatsApp novo nem inventa um ponto de
  entrada de conversa que não existe.
- **Anexo**: desabilitado, com texto "Anexos entram na fase B4" — mesma
  razão da aba Arquivos.

## 9. "Consulta" — sem tabela nova, e não implementado nesta fase

Decisão original: o bloco "Consulta" do protótipo (status, data,
duração, advogado, modalidade, nota) seria derivado da **atividade mais
recente do tipo `meeting` já concluída** desta oportunidade — não uma
entidade nova, sem inventar duração/modalidade (campos que não existem em
`activities` hoje).

**Na prática, esse cartão de resumo dedicado não chegou a ser
construído** — a atividade em si já aparece na `ActivitiesSection` e na
linha do tempo, mas não há uma seção separada "Consulta" na tela.
Registrado como limitação real em `A9-HANDOFF.md` §8, não como algo
entregue com escopo reduzido. Se o escritório quiser esse resumo
dedicado, é uma tarefa pequena e separada; duração/modalidade
estruturadas continuam uma decisão futura (possivelmente B2, junto da
agenda integrada ao Google).

## 10. Testes obrigatórios (verificação ao fim da fase, §14 do plano)

- pgTAP: RLS forçada nas 3 tabelas novas; alcance por registro em
  `proposals`/`conflict_checks`/`lead_notes` para os 6 papéis; projeção
  financeira de proposta por papel (viewer nada, sales só faixa, demais
  exato); paginação da timeline sem perda/repetição em timestamps
  empatados (mesmo teste de tie-break da A7/A8, adaptado); isolamento entre
  workspaces cobrindo as 3 tabelas novas.
- Unitário (vitest): payload serializado de `viewer`/`sales` não contém
  chave financeira proibida; `LeadTimelineLoadError` nunca vira lista
  vazia; `generateMetadata()` da página propaga falha operacional (mesmo
  padrão do achado 3 da revisão da A8).
- Preview: fluxo principal com dados fictícios — abrir um lead, ver as 6
  abas, criar uma anotação, criar uma proposta, registrar conflito, marcar
  como ganho.

## 11. Correções do review pós-CI (antes da abertura para merge)

Depois do CI verde e da validação em preview registradas no handoff (§§6–7),
uma segunda revisão de código (fora do CI/e2e, leitura direta do que foi
implementado) encontrou 5 problemas reais que os testes existentes não
cobriam, mais 2 entregas do protótipo ainda pendentes que o handoff já
registrava como limitação mas que o usuário pediu para concluir em vez de
adiar. Nenhuma mudança de regra de negócio nova — só fechar o que a A9 já
tinha se comprometido a entregar.

1. **Nota de conflito vazava para atendimento/visualizador.**
   `get_conflict_check()` devolvia `note` para os 6 papéis igual; como a
   nota pode conter detalhe sensível sobre partes envolvidas (mesma razão
   de honorários virarem faixa para atendimento em `proposal_financial_projection`),
   a decisão passa a ser: só quem pode ESCREVER a verificação
   (owner/admin/manager/lawyer) lê o texto — sales/viewer recebem `note:
   null`, nunca o conteúdo. Filtrado dentro da própria RPC (nunca escondido
   só na interface). `status`/`checked_at` continuam visíveis aos 6, como
   já era.
2. **`upsert_conflict_check` tinha uma janela de corrida real.** A
   comparação `p_lock_version <> v_existing.lock_version` acontecia ANTES
   do `UPDATE`, mas o `UPDATE` filtrava só por `id` — duas chamadas
   concorrentes liam a mesma versão, passavam as duas pela checagem, e a
   segunda sobrescrevia a primeira sem nunca disparar `stale_version`
   (mesma classe de bug que a A4 já tinha corrigido para oportunidades). A
   versão entra agora no próprio `WHERE` do `UPDATE`
   (`where id = ... and lock_version = p_lock_version`), igual ao padrão já
   usado em `send_proposal`/`decide_proposal` nesta mesma migration.
3. **"Enviar proposta" prometia um envio que o CRM não faz.** A UI mostrava
   canais (WhatsApp/e-mail) e "Enviando…" como se o sistema despachasse a
   mensagem — na prática só grava metadado. Renomeado para "Registrar envio
   manual", com uma frase explícita ("o CRM não despacha a mensagem")
   acima dos checkboxes de canal. Nenhuma integração de envio real entra
   nesta fase (isso é B3).
4. **Atividades e conversas do lead descartavam o resto em silêncio.** A
   busca de atividades da página não passava `status: "all"` (herdava o
   default `pending`, escondendo tudo já concluído) e tanto atividades
   quanto conversas só buscavam a primeira página (20/50), sem nenhuma
   forma de chegar ao resto. Corrigido com `status: "all"` na busca e
   paginação de verdade ("carregar mais") nas duas abas — `LeadActivitiesSection`
   e `LeadConversationsList`, mesmo padrão de estado sincronizado durante a
   renderização já usado em `LeadTimeline`.
5. **O filtro da timeline só filtrava o que já estava na tela.** Trocar
   para "Propostas" aplicava o filtro em memória sobre os ~30 eventos já
   carregados (de qualquer tipo), então um evento real mais antigo do tipo
   escolhido não aparecia — o servidor já aceitava `p_types`, a interface
   nunca mandava. Corrigido: trocar de filtro agora refaz a busca no
   servidor com o tipo escolhido (primeira página), e "carregar mais"
   mantém esse mesmo filtro no cursor seguinte.

Duas entregas concluídas nesta rodada, que antes estavam registradas como
limitação real (não como escopo reduzido):

6. **Bloco "Consulta".** Implementado como planejado em §9 — sem tabela
   nova, `ConsultationCard` deriva da atividade `meeting` já concluída mais
   recente da oportunidade ativa (dentre as já carregadas para a aba
   Atividades, sem consulta adicional). Só aparece quando essa atividade
   existe; sem isso, a ausência do bloco já é a informação. Duração e
   modalidade continuam de fora (não existem em `activities` hoje, mesma
   decisão original).
7. **Mudar de etapa sem sair do Perfil 360.** `StageMoveControl` reaproveita
   a mesma RPC e o mesmo bloqueio por requisito do kanban
   (`move_opportunity_stage` + `checkStageRequirementsAction` +
   `StageAdvanceDialog`, sem nenhuma duplicação de regra) atrás de um
   `<select>` na Visão geral, visível só para quem edita oportunidades e só
   enquanto a oportunidade está aberta. `moveOpportunityStageAction` ganhou
   um `leadId` opcional no `FormData` só para revalidar `/leads/[id]`
   também (o kanban não manda esse campo, então seu comportamento não
   muda).

Testes acrescentados: 4 novas asserções pgTAP (nota mascarada para
advogado/visualizador/atendimento — `14_a9_perfil_360.test.sql`, plano
30 → 34) e um arquivo e2e novo, `tests/e2e/a9-lead-profile.spec.ts`
(mudar etapa sem sair do Perfil 360, texto honesto de envio de proposta,
filtro da timeline indo ao servidor, nota de conflito nunca chegando ao
navegador do visualizador) — o PR anterior não tinha nenhum e2e
específico da A9, só reaproveitava os já existentes de fases anteriores.
