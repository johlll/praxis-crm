# A6 — Atividades e agenda interna: decisões

**Fase:** A6
**Branch:** `feat/a6-activities-calendar`
**Data:** 10/09/2026

Este documento registra as decisões de arquitetura tomadas dentro da margem de "escolhas rotineiras" que o pedido da A6 explicitamente delegou, e o raciocínio por trás de cada uma. Nenhuma delas exigiu voltar ao usuário — nenhum bloqueio concreto nem decisão de negócio ausente foi encontrado durante a implementação.

---

## 1. Vínculo da atividade: lead obrigatório, oportunidade opcional

O plano original (`activities — tipo, título, oportunidade, responsável...`) só previa vínculo com oportunidade. O pedido da A6 ampliou isso explicitamente: "vínculos necessários com contatos/leads/oportunidades".

**Decisão:** `activities.lead_id` é `NOT NULL` — é o LEAD, não a oportunidade, que define o alcance por registro (herdado via `private.lead_accessible_to_role()`, a mesma função já usada por leads e oportunidades desde a A4/A5). `activities.opportunity_id` é opcional: cobre tanto uma atividade de qualificação inicial (antes de existir oportunidade) quanto uma atividade específica de uma negociação em andamento.

**Coerência entre vínculos:** quando `opportunity_id` é informado, o banco garante — por FK composta `(workspace_id, opportunity_id, lead_id)` contra uma nova `unique(workspace_id, id, lead_id)` em `opportunities` — que a oportunidade pertence ao MESMO lead que a atividade referencia, não só ao mesmo workspace. `MATCH SIMPLE` (padrão do Postgres) faz essa checagem ser ignorada quando `opportunity_id` é nulo, então uma atividade sem oportunidade nunca esbarra nela.

Não existe `contact_id` como coluna própria — o contato já é alcançável via `lead.contact_id`, e duplicar a referência criaria uma terceira fonte de verdade para a mesma cadeia sem necessidade.

## 2. Concorrência: `lock_version` (padrão da A5), não `updated_at` (padrão da A4)

A A4 (`assign_lead`, `set_lead_status`...) usa comparação de `updated_at` para detectar edição concorrente. A A5 introduziu `lock_version bigint`, mais robusto (sem depender de precisão de timestamp). Como a A6 é posterior às duas e as ações de atividade (editar/concluir/reagendar/transferir) se parecem mais com as de oportunidade (várias ações atômicas distintas sobre o mesmo registro) do que com as de lead, `activities` adota `lock_version`, o padrão mais recente.

## 3. Status: só `pending`/`done` — sem `cancelled`

O escopo pedido lista "criar, visualizar, editar e excluir atividades" (exclusão é `DELETE` de verdade) e "concluir, reagendar e transferir responsável" como as únicas transições de estado. Não há pedido de uma atividade "cancelada" distinta de excluída. Manter só dois status evita uma máquina de estados maior do que o necessário — excluir (`delete_activity`) é como se remove uma atividade que não vai mais acontecer.

## 4. Tipo de atividade: enum fechado, 5 valores

`activity_type`: `call | meeting | task | email | deadline` (Ligação, Reunião, Tarefa, E-mail, Prazo). Mesmo espírito de tipos fechados já usado em `stage_requirement_type` (A5) — lista pequena e fixa, sem motor de tipos configuráveis pelo cliente nesta fase (isso ficaria para `custom_field_definitions`, C4 do plano, fora de escopo).

## 5. Data/hora: `due_at` sempre um instante real; `has_time` diferencia compromisso de tarefa só-de-data

Pedido explícito: "Diferencie compromissos com horário de atividades que tenham apenas uma data". Em vez de duas colunas (`due_date`/`due_time` nullable) ou uma tabela separada de `appointments` (que o plano original reserva para a integração com Google Agenda, fora do escopo desta fase), a A6 usa:

- `due_at timestamptz not null` — sempre um instante real, nunca uma string solta.
- `has_time boolean not null default true` — quando `false`, a atividade só tem DATA; `due_at` é normalizado, no servidor, para `23:59:59` no fuso `America/Sao_Paulo` daquele dia.

Essa normalização permite uma única regra de "atrasada" (`status = 'pending' and due_at < now()`) que funciona idêntica para os dois casos, sem duplicar lógica de fronteira de dia. O cliente nunca monta o instante — sempre envia `due_date` (obrigatório) + `due_time` (opcional) separados, e o servidor (`create_activity()`/`reschedule_activity()`) monta o `timestamptz` com `AT TIME ZONE 'America/Sao_Paulo'` explícito. Isso evita reproduzir o bug real de hidratação já documentado em `A5-HANDOFF.md` §3.1 (formatação de data sem fuso explícito) — aqui o cuidado é ainda maior porque data/hora é central na fase, não incidental.

**Fronteiras documentadas (únicas no código, `private.activity_filter_bounds()`):**
- **Hoje:** `[meia-noite de hoje, meia-noite de amanhã)` em `America/Sao_Paulo`.
- **Amanhã:** `[meia-noite de amanhã, meia-noite de depois de amanhã)`.
- **Semana:** `[segunda-feira desta semana, segunda-feira da semana seguinte)` — `date_trunc('week', ...)` do Postgres já trunca para segunda-feira (semana ISO 8601), batendo exatamente com o pedido "início da semana na segunda-feira" sem lógica adicional.
- **Atrasada:** `status = 'pending' and due_at < now()`.

Nenhuma dessas contas depende do fuso da máquina que roda o código — todas usam `AT TIME ZONE 'America/Sao_Paulo'` explícito dentro do SQL.

## 6. Atividade automática por etapa: configuração mínima, no máximo uma regra por etapa

O pedido explicitamente pede "configuração MÍNIMA" — não um motor de automação genérico. `stage_auto_activity_rules` tem `unique(stage_id)`: uma etapa tem no máximo uma regra (tipo, título literal, prazo relativo em horas, regra de responsável). Configurar é sempre um upsert (`set_stage_auto_activity_rule`, `on conflict (stage_id) do update`) — não existe lista de regras por etapa, editar substitui.

`title` é um texto literal, sem motor de templates/placeholders — decisão deliberada para não construir infraestrutura de automação além do pedido.

**Regra de responsável:** fechada em duas opções (`unassigned` | `lead_owner`) — nasce sem responsável, ou herda o responsável do lead no momento da transição (que pode, ele mesmo, ser nulo).

**Garantias de correção (todas verificadas por pgTAP, seção 10 de `11_a6_activities.test.sql`):**
- A atividade só é criada DEPOIS de todo `raise exception` possível e do `UPDATE` que já teria abortado a transação inteira num conflito — "movimento recusado, requisito pendente ou conflito não geram atividade" é automático por construção (rollback de toda a função), não uma checagem extra.
- Idempotência: um índice único parcial em `source_stage_transition_id` garante no máximo uma atividade por transição, mesmo em reenvio ou chamada concorrente — redundante com o fato de que `stage_transitions` já nasce único por movimentação bem-sucedida (concorrência otimista via `lock_version` em `move_opportunity_stage`, A5), mas mantido como reforço explícito pedido.
- Reentrar numa etapa é uma NOVA transição (novo `source_stage_transition_id`) — dispara a regra de novo, não é tratado como duplicata da vez anterior.

## 7. Atribuir responsável não pode virar atalho de acesso

Pedido explícito: "Atribuir uma atividade não pode conceder acesso a um lead ou oportunidade que o usuário não pode acessar." O candidato a responsável (`create_activity`/`reassign_activity`) passa por `private.check_activity_assignee()`, que exige: (1) ser membro ativo do workspace, e (2) satisfazer `private.lead_accessible_to_role()` para o LEAD ao qual a atividade pertence — ou seja, um advogado só pode ser responsável por uma atividade de um lead que ele já acessaria pela via normal ("seus + sem responsável"). Isso é distinto e adicional ao alcance de LEITURA da própria atividade (que também usa `lead_accessible_to_role`, mas sobre o ator que está chamando a RPC, não sobre o candidato a responsável).

## 8. "Próxima ação" nunca é uma atividade atrasada

Pedido: "A próxima ação deve vir de consulta à atividade futura mais próxima, não concluída nem cancelada... Atividades vencidas devem aparecer como pendência atrasada, sem desaparecer por estarem no passado." Isso são DOIS sinais distintos, nunca conflados:

- `next_action`: a atividade pendente com `due_at` mais próximo, mas só entre as que `due_at >= now()` — nunca uma atrasada.
- `overdue_activities_count`: contagem separada de pendentes já vencidas.

Uma oportunidade com só uma pendência atrasada e nenhuma futura mostra `next_action = null` ("Sem próxima ação") **e** `overdue_activities_count > 0` — os dois aparecem juntos na interface (`OpportunityDetailPanel`, `pipeline-board.tsx`, `opportunity-table.tsx`), nunca um escondendo o outro.

`private.opportunity_next_action()` é reaproveitada (mesma convenção das projeções da A5, `opportunity_financial_projection`/`opportunity_column_sum_projection`) nas três funções de leitura de oportunidade (`get_opportunity`, `list_opportunities`, `get_pipeline_board`) — uma única implementação, três pontos de uso.

## 9. Sem tela de configuração de tipos de atividade

O plano original menciona `activity_types` configurável por workspace (§6.5). A A6 não implementa isso — o pedido desta fase não menciona tipos configuráveis, e `ACTIVITY_TYPES` como enum fechado de 5 valores já cobre os casos do protótipo aprovado. Se o cliente precisar de tipos customizados no futuro, isso se encaixa melhor em `custom_field_definitions` (C4 do plano), com o desenho de tipo fechado já estabelecido — não antecipado aqui.

## 10. Contador da sidebar: só "atrasadas"

O pedido diz "contadores reais na sidebar", sem especificar qual número. `get_activity_counts()` já calcula os 5 buckets (atrasadas/hoje/amanhã/semana/sem responsável); o badge da sidebar mostra só **atrasadas** — o número mais acionável ("isto está vencido, alguém precisa ver"), consistente com o mesmo padrão de badge de urgência usado em CRMs comerciais. Os outros 4 números aparecem como chips na própria Central de Atividades.

## 11. Sem navegação entre semanas na Agenda

"Calendário semanal" (`/agenda`) mostra sempre a semana ATUAL (segunda a domingo, fuso do escritório) — sem botões de semana anterior/seguinte nesta entrega. O pedido não menciona navegação, e o filtro `week` do `list_activities()` já é ancorado em `now()` no servidor; adicionar navegação exigiria um parâmetro de semana de referência na RPC, o que fica para quando houver pedido explícito. Registrado como limitação conhecida, não como pendência oculta.

## 12. Criação de atividade pela Central: seletor de lead simples

A tela `/atividades` (sem lead fixo no contexto) precisa de um jeito de escolher o lead ao criar uma atividade "do zero". O projeto não tem — em nenhuma tela — nenhum componente de busca/autocomplete; todo formulário usa `<select>` nativo (confirmado por levantamento do código antes de implementar). A A6 segue o mesmo padrão: um `<select>` populado com os leads ativos do workspace (primeira página, mesmo limite de paginação de `listLeads`). Funciona bem para a escala de demonstração/piloto atual; se o número de leads crescer a ponto de tornar isso inviável, a solução é um combobox com busca — fora do escopo desta entrega, sem pedido explícito para justificá-la agora.
