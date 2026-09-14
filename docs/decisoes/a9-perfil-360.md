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

Ajuste feito depois de rodar os e2e existentes contra a página nova:
`OpportunityDetailPanel` ganhou dois props opcionais,
`showClientLink`/`showActivities` (default `true`, comportamento
inalterado em `/oportunidades/[id]`), desligados só na página de lead —
sem eles, o "Ver cliente" do cabeçalho colidia com o do painel, e a
`ActivitiesSection` do painel (só as atividades DESTA oportunidade)
colidia com a `ActivitiesSection` do lead inteiro, cada uma com seu
próprio botão "Nova atividade" visível ao mesmo tempo na aba "Visão
geral". A página de lead agora usa **uma única** `ActivitiesSection`
(todas as atividades do lead), reaproveitada tanto na aba "Visão geral"
quanto na aba "Atividades" — nunca as duas montadas ao mesmo tempo (abas
são mutuamente exclusivas), então não há segunda consulta nem segundo
botão.

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
  lista de quem pode mover oportunidade) — `sales`/`viewer` só leem.
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
- **Atividade**: não é um botão do composer — a "Visão geral" já mostra o
  botão "Nova atividade" do `OpportunityDetailPanel`/`ActivitiesSection`
  (A6) quando há oportunidade ativa, e a aba "Atividades" sempre mostra o
  seu próprio. Um terceiro gatilho no composer duplicaria a mesma ação na
  mesma tela (achado real do e2e: dois botões "Nova atividade" visíveis
  ao mesmo tempo quebravam `getByRole("button", { name: "Nova atividade" })`).
- **Mensagem**: só habilitado se já existir ao menos uma `conversation`
  vinculada a este lead (reaproveita `sendMessageAction`, A7). Sem
  conversa vinculada, o botão fica desabilitado com texto explicando o
  motivo — a A9 não cria um canal de WhatsApp novo nem inventa um ponto de
  entrada de conversa que não existe.
- **Anexo**: desabilitado, com texto "Anexos entram na fase B4" — mesma
  razão da aba Arquivos.

## 9. "Consulta" — sem tabela nova

O bloco "Consulta" do protótipo (status, data, duração, advogado,
modalidade, nota) é derivado da **atividade mais recente do tipo `meeting`
já concluída** desta oportunidade — não é uma entidade nova. Duração e
modalidade não existem como campos estruturados em `activities` hoje; a
tela mostra apenas o que os dados atuais sustentam (título, data,
responsável, notas) — nenhum campo é inventado para preencher o layout do
protótipo. Se o escritório precisar de duração/modalidade estruturadas,
isso é uma decisão futura (possivelmente parte da B2, junto da agenda
integrada ao Google).

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
