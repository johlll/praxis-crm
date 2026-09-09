# A5 — Pipeline e oportunidades: decisões de modelo e segurança

## Vínculo lead ↔ oportunidade

Um lead pode ter **várias** oportunidades (aprovado explicitamente) —
`opportunities.lead_id` é obrigatório, não existe oportunidade órfã.
Demandas independentes do mesmo contato continuam virando leads
distintos (não uma segunda oportunidade do mesmo lead). Não existe
"oportunidade ativa" escolhida silenciosamente: a tela do lead lista
todas, com status visível, e a pessoa escolhe qual abrir.

## Integridade entre pipeline, etapa e oportunidade

A etapa de uma oportunidade precisa pertencer ao **mesmo pipeline** que
a oportunidade referencia — garantido no banco por uma FK composta
`(pipeline_id, stage_id) references pipeline_stages(pipeline_id, id)`,
não só validado na aplicação. Isso exigiu que `pipeline_stages` tivesse
`UNIQUE(pipeline_id, id)` além da PK simples, e o mesmo padrão de
`UNIQUE(workspace_id, id)` se repete em `leads`, `pipelines`,
`stage_requirements`, `opportunities`, `lost_reasons` e `clients` — toda
FK composta "mesmo registro, mesmo workspace" exige a constraint unique
correspondente na tabela referenciada (achado real no primeiro `db push`
desta fase: `there is no unique constraint matching given keys`).

## Alcance por registro — reaproveitado, não reimplementado

Não existe responsável próprio de oportunidade nesta fase. O alcance
"seus + sem responsável" do advogado (e do papel `sales`, pela mesma
regra) é herdado do **lead pai**: `private.lead_accessible_to_role()`
(criada na revisão da A4) é reaproveitada tal como está — sem nenhuma
mudança de assinatura ou comportamento — em toda função de leitura e
escrita de oportunidade. Confirmado adequado ao modelo antes de
reaproveitar (pedido explícito): a função só compara papel/responsável/
ator, nunca referencia nada específico de `leads`.

## Etapas do pipeline

Um funil padrão por workspace, com as 8 etapas do protótipo aprovado
(`Pipeline.dc.html`), criado dentro de `create_workspace_with_owner()`
para workspaces novos, e por um backfill idempotente (mesma migration)
para os workspaces já existentes. Estrutura compatível com múltiplos
funis (`pipelines` não tem unicidade de nome, só um único
`is_default=true` por workspace) — sem forçar agora a decisão de um
funil por área jurídica.

`is_won`/`is_lost` existem em `pipeline_stages` para flexibilidade
futura, mas nenhuma etapa do funil padrão os usa: ganhar/perder é uma
**ação** (`win_opportunity`/`lose_opportunity`), não uma coluna do
kanban — conforme o protótipo aprovado, onde "Ganhou"/"Perdeu" são
botões no painel de detalhe, não uma 9ª etapa.

Excluir uma etapa com qualquer oportunidade vinculada (mesmo histórica,
ganha ou perdida) é recusado (`stage_occupied`). Marcar uma etapa como
`is_won`/`is_lost` é recusado se ela tiver oportunidade **aberta**
agora (`stage_has_open_opportunities`) — evita a ambiguidade de uma
oportunidade aberta numa etapa que passou a significar "encerrada".

## Requisitos de avanço — pular etapa não contorna

`move_opportunity_stage()` só exige requisito ao **avançar**
(`position` do destino maior que a atual) — retroceder nunca é
bloqueado. Ao avançar, os requisitos de **todas** as etapas entre a
atual (exclusive) e o destino (inclusive) precisam estar satisfeitos,
não só os da etapa final — pular da etapa 1 para a 4 exige os
requisitos das etapas 2, 3 e 4, todos.

## Concorrência atômica

`lock_version` (mesmo padrão de `updated_at` na A4, mas um contador
inteiro em vez de timestamp): o `UPDATE` de `move_opportunity_stage()`/
`win_opportunity()`/`lose_opportunity()` está condicionado a
`lock_version = p_lock_version and status = 'open'` no mesmo `WHERE` —
checagem e escrita são a mesma operação atômica. O histórico
(`stage_transitions`) é inserido na mesma transação da função, depois
do `UPDATE` bem-sucedido — nunca por fora, nunca com efeito parcial se
o `UPDATE` falhar. `stage_mismatch` (etapa de origem informada não bate
com a atual) é checado **antes** do `UPDATE`, dando uma mensagem mais
específica que "conflito de versão" quando o motivo real é outro.

## Projeção financeira por papel

Duas funções privadas, reaproveitando `private.money_band_label()` da
A4 sem mudança:
- `private.opportunity_financial_projection()` — valor de UMA
  oportunidade: viewer nada, sales só a faixa, os demais o exato.
- `private.opportunity_column_sum_projection()` — soma de uma COLUNA do
  kanban: sales e viewer não recebem nenhum total, exato ou derivado de
  faixas (que revelaria uma estimativa dos valores individuais). O
  `lawyer` só agrega o que já passou pelo filtro de alcance (suas
  oportunidades), então a soma nunca inclui valor de terceiros.

Aplicadas nos mesmos três caminhos: `get_opportunity()` (detalhe),
`list_opportunities()` (tabela) e `get_pipeline_board()` (kanban, card e
soma de coluna) — nenhum caminho tem uma regra diferente dos outros.

Separação leitura/escrita: sales e lawyer podem **escrever**
`value_cents` ao criar/editar uma oportunidade dentro do seu alcance
(faz parte do trabalho comercial) — a projeção só afeta o que volta na
**leitura**. Nenhuma escrita lê o valor atual como prova de permissão de
leitura, e nenhuma permissão de leitura autoriza escrita sozinha.

## Ganho, perda e a fundação mínima de clients/client_handoffs

Antecipação aprovada explicitamente, só o necessário para o aceite de
ganho da A5 — sem tela de Clientes nem gestão de atendimento (A8).
`win_opportunity()` é atômica: `UPDATE` condicionado
(`status='open'`) → cria ou reaproveita o `client` ativo do contato
(índice parcial único `(workspace_id, contact_id) where status='ativo'`
resolve a corrida com `ON CONFLICT ... DO NOTHING` + `SELECT` de
fallback, tudo na mesma transação) → cria o `client_handoff` (`UNIQUE
(opportunity_id)` garante um único handoff por oportunidade). Uma
segunda chamada de `win_opportunity()` na mesma oportunidade encontra
`status <> 'open'` e falha em `opportunity_conflict` **antes** de
chegar perto de criar qualquer coisa — idempotência por construção, não
por checagem extra.

`lose_opportunity()` exige `lost_reason_id` válido e **ativo** no mesmo
workspace. `lost_followup_date` é aceito e persistido (o protótipo tem
esse campo no modal), mas não cria nenhuma atividade, tarefa ou
lembrete real — não existe fonte de atividades antes da A6; prometer
isso agora seria enganoso.

## Resíduo financeiro da A4

`lead_values`, `private.lead_value_projection()` e
`private.money_band_label()` continuam intactos, sem uso pelo contrato
ativo de `leads` — **não convertidos automaticamente** em
`opportunities` (são semanticamente diferentes: valor estimado de lead
≠ valor de oportunidade com modelo de honorários e probabilidade).
`opportunities.value_cents` nasce do zero, sem migrar nenhum dado
antigo. Remoção de `lead_values` fica para uma manutenção separada, com
destino explicitamente aprovado — não bloqueia esta fase.

## Sem tela de configuração de pipeline nesta entrega

As funções de configuração (`create_pipeline_stage`,
`update_pipeline_stage`, `reorder_pipeline_stages`,
`delete_pipeline_stage`, `create_stage_requirement`,
`delete_stage_requirement`, `create_lost_reason`,
`deactivate_lost_reason`) existem, têm autorização no servidor
(owner/admin/manager) e são testadas no pgTAP — mas não há tela em
`/configuracoes` para chamá-las ainda. O teste e2e de requisito de
avanço configura o requisito via RPC direta (mesmo padrão usado para
provar que a autorização não depende da UI). Registrado como pendência
explícita, não como decisão de escopo — ver seção de limitações no
handoff.
