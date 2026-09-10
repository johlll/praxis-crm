-- pgTAP — A6: atividades e agenda interna.
--
-- Fixtures do seed (supabase/seed.sql): ana=owner/carla=lawyer/
-- elisa=viewer no Escritório Um; bruno=owner/carla=sales no Escritório
-- Dois; daniel=sem membership em lugar nenhum (usado para provar
-- "assignee_not_a_member"). Pipeline padrão de cada workspace vem do
-- backfill da migration da A5.
--
-- Disciplina do arquivo (mesma da A4/A5): `request.jwt.claims` é escopo
-- de TRANSAÇÃO — todo bloco reafirma o papel do Postgres E o claim antes
-- de cada chamada, nunca confia em estado deixado por um bloco anterior.

begin;
select plan(72);

\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ana     '20000000-0000-0000-0000-000000000001'
\set bruno   '20000000-0000-0000-0000-000000000002'
\set carla   '20000000-0000-0000-0000-000000000003'
\set daniel  '20000000-0000-0000-0000-000000000004'
\set elisa   '20000000-0000-0000-0000-000000000005'

-- -----------------------------------------------------------------
-- Setup: pipeline padrão, contatos, leads e uma oportunidade de apoio.
-- -----------------------------------------------------------------

reset role;
select id as pipe_um from public.pipelines where workspace_id = :'ws_um'::uuid and is_default \gset
select id as stage_um_0 from public.pipeline_stages where pipeline_id = :'pipe_um'::uuid and position = 0 \gset
select id as stage_um_1 from public.pipeline_stages where pipeline_id = :'pipe_um'::uuid and position = 1 \gset
select id as stage_um_2 from public.pipeline_stages where pipeline_id = :'pipe_um'::uuid and position = 2 \gset
select id as stage_um_3 from public.pipeline_stages where pipeline_id = :'pipe_um'::uuid and position = 3 \gset
select ((now() at time zone 'America/Sao_Paulo')::date) as hoje \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A6 Ana', null, null, null)).id as contact_ana \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A6 Sem Resp', null, null, null)).id as contact_sem_resp \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A6 Carla', null, null, null)).id as contact_carla \gset
select create_lead(:'ws_um'::uuid, (:'contact_ana')::uuid, 'Trabalhista', 'Lead A6 Ana', '{}'::text[], 'media', :'ana'::uuid) as lead_ana \gset
select create_lead(:'ws_um'::uuid, (:'contact_sem_resp')::uuid, 'Cível', 'Lead A6 Sem Responsável', '{}'::text[], 'media', null) as lead_sem_resp \gset
select create_lead(:'ws_um'::uuid, (:'contact_carla')::uuid, 'Família', 'Lead A6 Carla', '{}'::text[], 'media', :'carla'::uuid) as lead_carla \gset
select create_opportunity(:'lead_ana'::uuid, :'pipe_um'::uuid, :'stage_um_0'::uuid) as opp_ana \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato A6 Dois', null, null, null)).id as contact_dois \gset
select create_lead(:'ws_dois'::uuid, (:'contact_dois')::uuid, 'Tributário', 'Lead A6 Dois', '{}'::text[], 'media', null) as lead_dois \gset

-- ===================================================================
-- 1) Criar atividade + leitura básica
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_activity(
  p_lead_id := (:'lead_ana')::uuid, p_type := 'call'::activity_type, p_title := 'Ligar pro cliente',
  p_due_date := (:'hoje')::date, p_due_time := '15:00'::time
) as ativ_ana \gset

select ok(:'ativ_ana' is not null, 'create_activity() retorna um id');

select (get_activity((:'ativ_ana')::uuid) ->> 'title') as titulo_lido \gset
select is((:'titulo_lido')::text, 'Ligar pro cliente'::text, 'get_activity() lê o título gravado');

select (get_activity((:'ativ_ana')::uuid) ->> 'has_time')::boolean as has_time_lido \gset
select ok((:'has_time_lido')::boolean, 'has_time=true quando due_time é informado (compromisso com horário)');

select (list_activities(:'ws_um'::uuid)).total_count as total_lista_ana \gset
select is((:'total_lista_ana')::bigint, 1::bigint, 'list_activities() enxerga a atividade recém-criada');

-- ===================================================================
-- 2) Isolamento entre workspaces e alcance "seus + sem responsável"
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
-- Bruno não é membro NENHUM de ws_um (é dono só de ws_dois) — cai na
-- checagem de papel (has_workspace_role), que responde
-- insufficient_permission, não activity_not_found. O mascaramento por
-- "não encontrado" é para quem É membro do workspace mas não tem
-- alcance ao REGISTRO (caso da Carla logo abaixo) — mesmo comportamento
-- já estabelecido em get_opportunity()/list_opportunities() na A5 para
-- exatamente este cenário (não é bug novo da A6).
select throws_ok(
  format($i$ select get_activity(%L::uuid) $i$, :'ativ_ana'),
  'P0001', 'insufficient_permission',
  'Bruno (sem NENHUMA membership em ws_um) não enxerga a atividade de Ana via RPC direta'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select get_activity(%L::uuid) $i$, :'ativ_ana'),
  'P0001', 'activity_not_found',
  'Carla (advogada, não é responsável pelo lead de Ana) não enxerga a atividade — "seus + sem responsável"'
);

select create_activity(
  p_lead_id := (:'lead_sem_resp')::uuid, p_type := 'task'::activity_type, p_title := 'Tarefa sem responsável',
  p_due_date := (:'hoje')::date
) as ativ_sem_resp \gset
select lives_ok(
  format($i$ select get_activity(%L::uuid) $i$, :'ativ_sem_resp'),
  'Carla enxerga atividade de um lead SEM responsável (alcance "seus + sem responsável")'
);

select create_activity(
  p_lead_id := (:'lead_carla')::uuid, p_type := 'task'::activity_type, p_title := 'Tarefa da Carla',
  p_due_date := (:'hoje')::date
) as ativ_carla \gset
select lives_ok(
  format($i$ select get_activity(%L::uuid) $i$, :'ativ_carla'),
  'Carla enxerga atividade de um lead do qual ELA é a responsável'
);

-- ===================================================================
-- 3) Coerência de vínculo: oportunidade precisa pertencer ao MESMO lead
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select create_activity(p_lead_id := %L::uuid, p_type := 'task'::activity_type, p_title := 'Vínculo errado', p_due_date := %L::date, p_opportunity_id := %L::uuid) $i$,
    :'lead_carla', :'hoje', :'opp_ana'
  ),
  'P0001', 'opportunity_not_found',
  'Oportunidade de OUTRO lead (opp_ana pertence a lead_ana, não a lead_carla) é recusada — coerência entre vínculos'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select lives_ok(
  format(
    $i$ select create_activity(p_lead_id := %L::uuid, p_type := 'task'::activity_type, p_title := 'Vínculo certo', p_due_date := %L::date, p_opportunity_id := %L::uuid) $i$,
    :'lead_ana', :'hoje', :'opp_ana'
  ),
  'Oportunidade do MESMO lead é aceita normalmente'
);

-- ===================================================================
-- 4) Atribuir responsável — não pode virar atalho de acesso
-- ===================================================================

select throws_ok(
  format(
    $i$ select create_activity(p_lead_id := %L::uuid, p_type := 'task'::activity_type, p_title := 'x', p_due_date := %L::date, p_assigned_to := %L::uuid) $i$,
    :'lead_ana', :'hoje', :'daniel'
  ),
  'P0001', 'assignee_not_a_member',
  'Atribuir a quem não é membro do workspace é recusado'
);

select throws_ok(
  format(
    $i$ select create_activity(p_lead_id := %L::uuid, p_type := 'task'::activity_type, p_title := 'x', p_due_date := %L::date, p_assigned_to := %L::uuid) $i$,
    :'lead_ana', :'hoje', :'carla'
  ),
  'P0001', 'activity_assignee_no_access',
  'Atribuir a um advogado que NÃO é o responsável do lead (nem o lead está sem responsável) é recusado — não pode virar atalho de acesso'
);

select lives_ok(
  format(
    $i$ select create_activity(p_lead_id := %L::uuid, p_type := 'task'::activity_type, p_title := 'x', p_due_date := %L::date, p_assigned_to := %L::uuid) $i$,
    :'lead_ana', :'hoje', :'ana'
  ),
  'Atribuir ao próprio responsável do lead funciona'
);

select lives_ok(
  format(
    $i$ select create_activity(p_lead_id := %L::uuid, p_type := 'task'::activity_type, p_title := 'x', p_due_date := %L::date, p_assigned_to := %L::uuid) $i$,
    :'lead_sem_resp', :'hoje', :'carla'
  ),
  'Atribuir um advogado a um lead SEM responsável funciona (nada a violar)'
);

-- ===================================================================
-- 5) Concorrência — update/complete/reschedule/reassign
-- ===================================================================

reset role;
select lock_version from public.activities where id = (:'ativ_ana')::uuid \gset ativ_ana_

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select update_activity(%L::uuid, %s, p_title := 'Título novo') $i$,
    :'ativ_ana', (:'ativ_ana_lock_version')::bigint + 1
  ),
  'P0001', 'activity_conflict',
  'update_activity com lock_version errado é recusado'
);
reset role;
select title from public.activities where id = (:'ativ_ana')::uuid \gset ativ_ana_pos_
select is((:'ativ_ana_pos_title')::text, 'Ligar pro cliente'::text, 'Tentativa recusada não alterou o título — sem efeito parcial');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select lives_ok(
  format($i$ select update_activity(%L::uuid, %s, p_title := 'Título novo') $i$, :'ativ_ana', :'ativ_ana_lock_version'),
  'update_activity com lock_version certo é aceito'
);
reset role;
select lock_version, title from public.activities where id = (:'ativ_ana')::uuid \gset ativ_ana_novo_
select is((:'ativ_ana_novo_lock_version')::bigint, (:'ativ_ana_lock_version')::bigint + 1, 'lock_version incrementado em 1 pelo update aceito');
select is((:'ativ_ana_novo_title')::text, 'Título novo'::text, 'Título de fato atualizado');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select reschedule_activity(%L::uuid, %s, %L::date) $i$,
    :'ativ_ana', (:'ativ_ana_novo_lock_version')::bigint + 1, :'hoje'
  ),
  'P0001', 'activity_conflict',
  'reschedule_activity com lock_version errado é recusado'
);
select lives_ok(
  format(
    $i$ select reschedule_activity(%L::uuid, %s, %L::date, %L::time) $i$,
    :'ativ_ana', :'ativ_ana_novo_lock_version', :'hoje', '18:00'
  ),
  'reschedule_activity com lock_version certo é aceito'
);
reset role;
select lock_version, due_at from public.activities where id = (:'ativ_ana')::uuid \gset ativ_ana_r_
select is(
  (:'ativ_ana_r_due_at')::timestamptz,
  ((:'hoje')::text || ' 18:00')::timestamp at time zone 'America/Sao_Paulo',
  'Novo horário persistido corretamente, montado no fuso America/Sao_Paulo'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
-- Responsável VÁLIDO aqui (ana) de propósito — check_activity_assignee()
-- roda ANTES do UPDATE guardado por lock_version (mesma ordem de
-- move_opportunity_stage na A5: toda validação de conteúdo vem antes do
-- gate de concorrência, que é sempre o último). Testar o conflito com um
-- responsável INVÁLIDO mascararia o erro certo com
-- activity_assignee_no_access — isolando aqui só a dimensão de
-- concorrência.
select throws_ok(
  format(
    $i$ select reassign_activity(%L::uuid, %s, %L::uuid) $i$,
    :'ativ_ana', (:'ativ_ana_r_lock_version')::bigint + 1, :'ana'
  ),
  'P0001', 'activity_conflict',
  'reassign_activity com lock_version errado é recusado'
);
select throws_ok(
  format(
    $i$ select reassign_activity(%L::uuid, %s, %L::uuid) $i$,
    :'ativ_ana', :'ativ_ana_r_lock_version', :'carla'
  ),
  'P0001', 'activity_assignee_no_access',
  'reassign_activity também valida acesso do novo responsável — mesma regra de create_activity'
);
select lives_ok(
  format(
    $i$ select reassign_activity(%L::uuid, %s, %L::uuid) $i$,
    :'ativ_ana', :'ativ_ana_r_lock_version', :'ana'
  ),
  'reassign_activity para o responsável do lead funciona'
);
reset role;
select lock_version from public.activities where id = (:'ativ_ana')::uuid \gset ativ_ana_f_

-- ===================================================================
-- 6) Concluir — e recusa em concluir/reagendar já concluída
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select lives_ok(
  format($i$ select complete_activity(%L::uuid, %s) $i$, :'ativ_ana', :'ativ_ana_f_lock_version'),
  'complete_activity com lock_version certo é aceito'
);
reset role;
select status, lock_version, completed_at from public.activities where id = (:'ativ_ana')::uuid \gset ativ_ana_done_
select is((:'ativ_ana_done_status')::text, 'done'::text, 'Status vira done');
select ok((:'ativ_ana_done_completed_at') is not null, 'completed_at preenchido');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select complete_activity(%L::uuid, %s) $i$, :'ativ_ana', :'ativ_ana_done_lock_version'),
  'P0001', 'activity_conflict',
  'Concluir uma atividade JÁ concluída é recusado (mesmo com lock_version certo)'
);
select throws_ok(
  format($i$ select reschedule_activity(%L::uuid, %s, %L::date) $i$, :'ativ_ana', :'ativ_ana_done_lock_version', :'hoje'),
  'P0001', 'activity_conflict',
  'Reagendar uma atividade já concluída é recusado'
);

-- ===================================================================
-- 7) Excluir
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select lives_ok(
  format($i$ select delete_activity(%L::uuid) $i$, :'ativ_sem_resp'),
  'delete_activity funciona (Ana pode gerenciar lead sem responsável)'
);
select throws_ok(
  format($i$ select get_activity(%L::uuid) $i$, :'ativ_sem_resp'),
  'P0001', 'activity_not_found',
  'Depois de excluída, a atividade não é mais encontrada'
);

-- ===================================================================
-- 8) RPC direta negada / grants exatos
-- ===================================================================

reset role;
select is(
  has_table_privilege('authenticated', 'public.activities', 'SELECT'), false,
  'authenticated não tem SELECT direto em activities — só via RPC'
);
select is(
  has_table_privilege('authenticated', 'public.activities', 'INSERT'), false,
  'authenticated não tem INSERT direto em activities'
);
select is(
  has_table_privilege('authenticated', 'public.stage_auto_activity_rules', 'SELECT'), true,
  'authenticated TEM select direto em stage_auto_activity_rules (configuração, não sensível)'
);
select is(
  has_table_privilege('authenticated', 'public.stage_auto_activity_rules', 'INSERT'), false,
  'authenticated não tem INSERT direto em stage_auto_activity_rules — mutação só via função'
);
select is(
  has_function_privilege('authenticated', 'public.create_activity(uuid, activity_type, text, date, time, uuid, text, uuid, lead_priority)', 'EXECUTE'),
  true, 'authenticated pode chamar create_activity'
);
select is(
  has_function_privilege('authenticated', 'public.set_stage_auto_activity_rule(uuid, activity_type, text, integer, activity_assignee_rule)', 'EXECUTE'),
  true, 'authenticated pode chamar set_stage_auto_activity_rule (a checagem de owner/admin/manager é DENTRO da função)'
);
select is(
  (select count(*)::int from pg_indexes where indexname = 'activities_one_per_transition_idx'),
  1, 'Índice único parcial de idempotência (uma atividade por transição) existe no schema'
);

-- ===================================================================
-- 9) Fronteiras de hoje / amanhã / atrasada / sem responsável
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_activity(
  p_lead_id := (:'lead_ana')::uuid, p_type := 'task'::activity_type, p_title := 'Vence hoje',
  p_due_date := (:'hoje')::date
) as ativ_hoje \gset
select create_activity(
  p_lead_id := (:'lead_ana')::uuid, p_type := 'task'::activity_type, p_title := 'Vence amanhã',
  p_due_date := ((:'hoje')::date + 1), p_assigned_to := (:'ana')::uuid
) as ativ_amanha \gset
select create_activity(
  p_lead_id := (:'lead_ana')::uuid, p_type := 'task'::activity_type, p_title := 'Bem atrasada',
  p_due_date := ((:'hoje')::date - 30)
) as ativ_atrasada \gset

select counts from list_activities(:'ws_um'::uuid, p_filter := 'overdue') \gset overdue_
select ((:'overdue_counts')::jsonb ->> 'overdue')::int as overdue_count \gset
select ok((:'overdue_count')::int >= 1, 'Contador de atrasadas inclui a atividade vencida há 30 dias');

select items from list_activities(:'ws_um'::uuid, p_filter := 'overdue') \gset overdue_list_
select ok(
  (:'overdue_list_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', (:'ativ_atrasada')::text)),
  'A atividade atrasada aparece no filtro "overdue" — não desaparece por estar no passado'
);
select ok(
  not ((:'overdue_list_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', (:'ativ_hoje')::text))),
  'A atividade de hoje NÃO aparece no filtro "overdue" (ainda não venceu)'
);

select items from list_activities(:'ws_um'::uuid, p_filter := 'today') \gset today_list_
select ok(
  (:'today_list_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', (:'ativ_hoje')::text)),
  'A atividade de hoje aparece no filtro "today"'
);
select ok(
  not ((:'today_list_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', (:'ativ_atrasada')::text))),
  'A atividade atrasada há 30 dias NÃO aparece no filtro "today"'
);

select items from list_activities(:'ws_um'::uuid, p_filter := 'tomorrow') \gset tomorrow_list_
select ok(
  (:'tomorrow_list_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', (:'ativ_amanha')::text)),
  'A atividade de amanhã aparece no filtro "tomorrow"'
);

-- Só "hoje" é verificado aqui (não "amanhã"): se o teste rodar num
-- domingo, amanhã (segunda) já cai na PRÓXIMA semana ISO — verificar só
-- o que é verdade em QUALQUER dia da semana em que o CI rodar.
select items from list_activities(:'ws_um'::uuid, p_filter := 'week') \gset week_list_
select ok(
  (:'week_list_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', (:'ativ_hoje')::text)),
  'Hoje sempre cai dentro do filtro "week" (início da semana na segunda-feira, date_trunc)'
);

select items from list_activities(:'ws_um'::uuid, p_filter := 'unassigned') \gset unassigned_list_
select ok(
  (:'unassigned_list_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', (:'ativ_hoje')::text)),
  'Atividade sem responsável aparece no filtro "unassigned"'
);
select ok(
  not ((:'unassigned_list_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', (:'ativ_amanha')::text))),
  'Atividade COM responsável não aparece no filtro "unassigned" (ativ_amanha foi atribuída à Ana)'
);

-- Concluir a atrasada: some do contador de atrasadas.
reset role;
select lock_version from public.activities where id = (:'ativ_atrasada')::uuid \gset ativ_atrasada_

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select complete_activity((:'ativ_atrasada')::uuid, (:'ativ_atrasada_lock_version')::bigint);
select counts from list_activities(:'ws_um'::uuid) \gset counts_depois_
select ((:'counts_depois_counts')::jsonb ->> 'overdue')::int as overdue_depois \gset
select ok(
  (:'overdue_depois')::int < (:'overdue_count')::int,
  'Concluir a atividade atrasada reduz o contador de atrasadas — indicadores refletem a conclusão'
);

-- get_activity_counts (usado pelo badge da sidebar) bate com o mesmo número.
select (get_activity_counts(:'ws_um'::uuid) ->> 'today')::int as sidebar_today \gset
select ok((:'sidebar_today')::int >= 1, 'get_activity_counts() (contador da sidebar) também enxerga a atividade de hoje');

-- ===================================================================
-- 10) Atividade automática ao mudar de etapa
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_stage_requirement(:'stage_um_3'::uuid, 'Confirmar aderência', 'text') as req_stage3 \gset

select set_stage_auto_activity_rule(:'stage_um_1'::uuid, 'call'::activity_type, 'Ligar em 48h', 48, 'lead_owner'::activity_assignee_rule) as rule_stage1 \gset
select set_stage_auto_activity_rule(:'stage_um_3'::uuid, 'task'::activity_type, 'Revisar aderência', 24, 'unassigned'::activity_assignee_rule) as rule_stage3 \gset

select ok(:'rule_stage1' is not null, 'set_stage_auto_activity_rule() cria a regra e devolve um id');

reset role;
select lock_version from public.opportunities where id = (:'opp_ana')::uuid \gset opp_ana_

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select move_opportunity_stage((:'opp_ana')::uuid, :'stage_um_0'::uuid, :'stage_um_1'::uuid, (:'opp_ana_lock_version')::bigint);

reset role;
select count(*)::int as n from public.activities where opportunity_id = (:'opp_ana')::uuid and source = 'stage_rule' \gset auto1_
select is((:'auto1_n')::int, 1, 'Mover para a etapa com regra cria exatamente UMA atividade automática');

select type, assigned_to, title from public.activities
  where opportunity_id = (:'opp_ana')::uuid and source_rule_id = (:'rule_stage1')::uuid \gset auto1_ativ_
select is((:'auto1_ativ_type')::text, 'call'::text, 'Tipo da atividade automática é o configurado na regra');
select is((:'auto1_ativ_assigned_to')::uuid, (:'ana')::uuid, 'assignee_rule=lead_owner: responsável herdado do lead (Ana)');

select lock_version from public.opportunities where id = (:'opp_ana')::uuid \gset opp_ana_

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select move_opportunity_stage((:'opp_ana')::uuid, :'stage_um_1'::uuid, :'stage_um_2'::uuid, (:'opp_ana_lock_version')::bigint);

reset role;
select count(*)::int as n from public.activities where opportunity_id = (:'opp_ana')::uuid and source = 'stage_rule' \gset auto2_
select is((:'auto2_n')::int, 1, 'Mover para etapa SEM regra configurada não cria nenhuma atividade nova');

select lock_version from public.opportunities where id = (:'opp_ana')::uuid \gset opp_ana_

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select move_opportunity_stage(%L::uuid, %L::uuid, %L::uuid, %s) $i$,
    :'opp_ana', :'stage_um_2', :'stage_um_3', :'opp_ana_lock_version'
  ),
  'P0001', 'stage_requirements_pending',
  'Mover para a etapa 3 sem preencher o requisito pendente é recusado'
);

reset role;
select count(*)::int as n from public.activities where opportunity_id = (:'opp_ana')::uuid and source = 'stage_rule' \gset auto3_
select is(
  (:'auto3_n')::int, 1,
  'Movimento RECUSADO por requisito pendente não cria a atividade automática da etapa 3 (rollback da transação inteira) — continua em 1'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
-- Requisito PREENCHIDO aqui de propósito — a checagem de requisito
-- pendente roda ANTES do UPDATE guardado por lock_version (mesma ordem
-- de "toda validação de conteúdo antes do gate de concorrência" já
-- usada em reassign_activity acima); sem preencher, stage_requirements_
-- pending mascararia o opportunity_conflict que este teste quer isolar.
select throws_ok(
  format(
    $i$ select move_opportunity_stage(%L::uuid, %L::uuid, %L::uuid, %s, %L::jsonb) $i$,
    :'opp_ana', :'stage_um_2', :'stage_um_3', (:'opp_ana_lock_version')::bigint + 99,
    json_build_array(json_build_object('requirement_id', :'req_stage3', 'value_text', 'ok'))::text
  ),
  'P0001', 'opportunity_conflict',
  'Movimento RECUSADO por lock_version errado também não cria atividade nenhuma'
);
reset role;
select count(*)::int as n from public.activities where opportunity_id = (:'opp_ana')::uuid and source = 'stage_rule' \gset auto4_
select is((:'auto4_n')::int, 1, 'Confirmado: continua em 1 depois da tentativa com conflito');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select move_opportunity_stage(
  (:'opp_ana')::uuid, :'stage_um_2'::uuid, :'stage_um_3'::uuid, (:'opp_ana_lock_version')::bigint,
  json_build_array(json_build_object('requirement_id', :'req_stage3', 'value_text', 'ok'))::jsonb
);

reset role;
select count(*)::int as n from public.activities where opportunity_id = (:'opp_ana')::uuid and source = 'stage_rule' \gset auto5_
select is((:'auto5_n')::int, 2, 'Preenchendo o requisito, o movimento é aceito e a 2ª atividade automática é criada (regra da etapa 3)');

-- Filtra pela REGRA que originou (source_rule_id), não por "mais recente
-- por created_at" — todo este arquivo roda numa ÚNICA transação, então
-- now() (e portanto created_at) fica CONGELADO no mesmo instante do
-- início da transação para o arquivo inteiro; "order by created_at desc"
-- não desempata de forma confiável entre as duas atividades automáticas
-- já existentes (achado real no CI, não presumido).
select assigned_to is null as sem_resp from public.activities
  where opportunity_id = (:'opp_ana')::uuid and source_rule_id = (:'rule_stage3')::uuid \gset auto5_ativ_
select ok((:'auto5_ativ_sem_resp')::boolean, 'assignee_rule=unassigned: atividade nasce SEM responsável mesmo o lead tendo dono');

-- Reentrar na etapa 1 é uma NOVA transição — dispara a regra de novo.
select lock_version from public.opportunities where id = (:'opp_ana')::uuid \gset opp_ana_
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select move_opportunity_stage((:'opp_ana')::uuid, :'stage_um_3'::uuid, :'stage_um_1'::uuid, (:'opp_ana_lock_version')::bigint);
reset role;
select count(*)::int as n from public.activities where opportunity_id = (:'opp_ana')::uuid and source = 'stage_rule' \gset auto6_
select is(
  (:'auto6_n')::int, 3,
  'Reentrar numa etapa com regra é uma NOVA transição legítima — cria mais uma (3ª) atividade automática, não é bloqueado como duplicata'
);

-- ===================================================================
-- 11) "Próxima ação" nas projeções de oportunidade
-- ===================================================================

-- Toda atividade pendente já vinculada a opp_ana até aqui (as 3
-- automáticas da seção anterior, todas vencendo em 24-48h, MAIS a
-- "Vínculo certo" da seção 3, vencendo hoje) fica mais próxima que os 5
-- dias usados abaixo — sem isto, uma delas "venceria" a disputa por
-- "próxima ação mais próxima" e o teste ficaria refém de dado deixado
-- por seções anteriores. UPDATE direto (não é o que está sendo testado
-- aqui — complete_activity() já foi provada nas seções 5/6) só pra
-- isolar limpo esta seção.
reset role;
update public.activities set status = 'done', completed_at = now()
  where opportunity_id = (:'opp_ana')::uuid and status = 'pending';

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_activity(
  p_lead_id := (:'lead_ana')::uuid, p_type := 'task'::activity_type, p_title := 'Próxima ação futura',
  p_due_date := ((:'hoje')::date + 5), p_opportunity_id := (:'opp_ana')::uuid
) as ativ_futura \gset
select create_activity(
  p_lead_id := (:'lead_ana')::uuid, p_type := 'task'::activity_type, p_title := 'Pendência vencida da oportunidade',
  p_due_date := ((:'hoje')::date - 10), p_opportunity_id := (:'opp_ana')::uuid
) as ativ_venc_opp \gset

select (get_opportunity((:'opp_ana')::uuid) -> 'next_action' ->> 'id') as next_action_id \gset
select is((:'next_action_id')::uuid, (:'ativ_futura')::uuid, 'get_opportunity() aponta a próxima ação para a atividade futura mais próxima, não a atrasada');

select (get_opportunity((:'opp_ana')::uuid) ->> 'overdue_activities_count')::int as overdue_da_opp \gset
select ok((:'overdue_da_opp')::int >= 1, 'get_opportunity() conta a pendência atrasada separadamente (overdue_activities_count)');

reset role;
select lock_version from public.activities where id = (:'ativ_futura')::uuid \gset ativ_futura_

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select complete_activity((:'ativ_futura')::uuid, (:'ativ_futura_lock_version')::bigint);
select (get_opportunity((:'opp_ana')::uuid) -> 'next_action') as next_action_depois \gset
select is((:'next_action_depois')::text, 'null'::text, 'Sem nenhuma pendente futura, next_action volta a "Sem próxima ação" (null)');

select items from list_opportunities(:'ws_um'::uuid) \gset lista_opp_
select ok(
  (:'lista_opp_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', (:'opp_ana')::text, 'overdue_activities_count', (:'overdue_da_opp')::int)),
  'list_opportunities() também carrega overdue_activities_count por item (mesma projeção reaproveitada)'
);

select get_pipeline_board(:'pipe_um'::uuid) as board \gset
select ok(
  (:'board')::jsonb @> jsonb_build_array(jsonb_build_object('stage_id', (:'stage_um_1')::text)),
  'get_pipeline_board() ainda devolve a estrutura normal das colunas (next_action embutido em cada card, sem quebrar o board)'
);

-- ===================================================================
-- 12) Configuração da regra automática — permissão e upsert
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select set_stage_auto_activity_rule(%L::uuid, 'task'::activity_type, 'x', 24, 'unassigned'::activity_assignee_rule) $i$,
    :'stage_um_2'
  ),
  'P0001', 'insufficient_permission',
  'Advogada não pode configurar regra automática (administrativo: owner/admin/manager)'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select set_stage_auto_activity_rule(:'stage_um_2'::uuid, 'email'::activity_type, 'Enviar e-mail de boas-vindas', 12, 'lead_owner'::activity_assignee_rule);
select set_stage_auto_activity_rule(:'stage_um_2'::uuid, 'meeting'::activity_type, 'Agendar reunião', 6, 'unassigned'::activity_assignee_rule);

reset role;
select count(*)::int as n from public.stage_auto_activity_rules where stage_id = (:'stage_um_2')::uuid \gset upsert_
select is((:'upsert_n')::int, 1, 'No máximo uma regra por etapa — a segunda chamada SUBSTITUI, não duplica');

select type as tipo_final, title as titulo_final from public.stage_auto_activity_rules where stage_id = (:'stage_um_2')::uuid \gset upsert_final_
select is((:'upsert_final_tipo_final')::text, 'meeting'::text, 'Depois do upsert, vale a segunda chamada (meeting), não a primeira (email)');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select lives_ok(
  format($i$ select delete_stage_auto_activity_rule(%L::uuid) $i$, :'stage_um_2'),
  'delete_stage_auto_activity_rule() funciona para owner'
);
reset role;
select count(*)::int as n from public.stage_auto_activity_rules where stage_id = (:'stage_um_2')::uuid \gset apos_delete_
select is((:'apos_delete_n')::int, 0, 'Regra removida de fato');

select * from finish();
rollback;
