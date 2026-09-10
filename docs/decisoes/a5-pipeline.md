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

## Tela de configuração de pipeline (`/configuracoes/pipelines`)

Adicionada na revisão pós-fechamento da A5 (item 2), reaproveitando
**só** as RPCs já existentes e testadas pelo pgTAP desde a entrega
original — nenhuma regra nova de negócio, só a interface que faltava.
Acesso gated por `pipeline.configure` (owner/admin/manager): quem não
tem a permissão não vê o link em `/configuracoes` nem acessa a URL
direta (`notFound()`, mesmo padrão de "recurso não encontrado" já usado
para isolamento entre workspaces — não é um caso novo de 403 disfarçado
de 404). Reordenar etapas usa botões subir/descer chamando
`reorder_pipeline_stages()` com a ordem recomputada no cliente — sem
arrastar (dnd-kit já é dependência da fase, mas drag-and-drop de
configuração de etapas é um adicional que a entrega mínima não exige).
Motivos de perda desativados somem da lista de configuração (mesmo
espírito de "não pode ser excluído, só desativado" — reativar não
existe nesta fase, então não há por que listar os já desativados aqui).

O teste e2e de requisito de avanço (`pipeline.spec.ts`, teste 3)
continua configurando o requisito via RPC direta, deliberadamente — ele
testa que a autorização e o bloqueio são reforçados no **servidor**,
não que a tela existe (isso agora tem teste próprio em
`pipeline-config.spec.ts`).

## Etapa terminal (is_won/is_lost) — move não pode contornar ganhar/perder

Achado na revisão pós-fechamento (item 1): `move_opportunity_stage()`
recusava marcar uma etapa OCUPADA como terminal (`update_pipeline_stage`
já tinha essa proteção, migration original), mas não recusava o
espelho — mover uma oportunidade ABERTA para uma etapa JÁ marcada
`is_won`/`is_lost`, deixando `status='open'` numa etapa que a própria
configuração do pipeline diz ser terminal. Corrigido em
`20260910130000` (`CREATE OR REPLACE`, mesma assinatura): a etapa de
destino é checada logo após confirmar que pertence ao pipeline, e
`is_won`/`is_lost` bloqueia incondicionalmente com `stage_is_terminal`,
antes de qualquer gravação de `requirement_values` — preserva o modelo
aprovado de que ganhar/perder são **ações próprias**
(`win_opportunity`/`lose_opportunity`), nunca uma consequência de mover
para uma coluna. A UI reflete isso: etapas terminais não aparecem no
menu "mover para" do kanban (o servidor recusaria de qualquer forma —
é só para não oferecer uma opção fadada ao erro).

## Requisitos de fechamento (ganhar) — decisão pendente, ainda não implementada

Investigação (revisão pós-fechamento, item 3): `win_opportunity()` **não
verifica `stage_requirements` de nenhuma etapa** — confirmado por
leitura direta do corpo da função (nenhuma referência a
`stage_requirements`/`opportunity_requirement_values`), não presumido.
Uma oportunidade pode ser ganha em qualquer etapa aberta, mesmo com
requisitos pendentes — inclusive requisitos configurados **depois** que
a oportunidade já passou por aquela etapa (não há checagem
retroativa). `lose_opportunity()` tem a mesma ausência.

Isso é **diferente** do requisito de avanço (que só bloqueia
`move_opportunity_stage()` ao entrar numa etapa) — ganhar não passa por
`move_opportunity_stage()` nenhuma vez. Três desenhos possíveis para uma
regra de fechamento, apresentados ao usuário antes de qualquer
implementação (nenhum foi escolhido ainda):

1. **Sem checagem nenhuma (comportamento atual)** — mais simples e
   flexível, mas permite ganhar sem nunca ter confirmado um requisito
   que o escritório considera essencial (ex.: "conflito de interesses
   verificado"), mesmo que ele exista configurado em alguma etapa do
   caminho.
2. **Ganhar exige os requisitos de todas as etapas até a atual
   (inclusive)** — mesma regra de avanço, só que reaplicada no momento
   de ganhar, cobrindo o caso de requisito configurado depois que a
   etapa foi visitada. Não exige nada de etapas **à frente** da atual
   (a oportunidade nunca chegou lá) — não torna toda pergunta
   intermediária obrigatória, só as do caminho já percorrido.
3. **Campo explícito por requisito** (`required_for_win boolean default
   false` em `stage_requirements`) — o admin marca, requisito a
   requisito, quais também bloqueiam o fechamento, **independente da
   etapa atual** (ex.: "conflito de interesses" bloqueia ganhar mesmo
   que a oportunidade feche direto na etapa 1). Mais preciso e mais
   alinhado à frase "sem tornar automaticamente toda pergunta
   intermediária obrigatória" (só o que for explicitamente marcado
   passa a valer), mas exige coluna nova, migration e um controle a mais
   na tela de configuração.

Recomendação: opção 3, por separar de verdade os dois conceitos que o
usuário pediu para distinguir — mas a escolha final depende de como o
escritório realmente usa "requisito" na prática, e por isso não foi
implementada sem confirmação explícita.
