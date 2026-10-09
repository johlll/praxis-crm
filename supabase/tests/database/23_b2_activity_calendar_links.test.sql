-- pgTAP — B2, etapa 2b: leitura do vínculo com a agenda pela interface
-- (list_activity_calendar_links) e identidade da tentativa de inclusão
-- (get_open_calendar_create). Todos os registros são criados por este
-- teste. Mostra o que a tela recebe e, principalmente, o que NÃO recebe.

begin;
select plan(46);

\set dono   '20000000-0000-0000-0000-000000000001'
\set adv    '20000000-0000-0000-0000-000000000002'
\set adv2   '20000000-0000-0000-0000-000000000003'
\set leitor '20000000-0000-0000-0000-000000000005'

insert into public.calendar_environment_keys (environment, signing_key) values
  ('production', 'chave-de-producao-de-teste-0123456789ab'),
  ('preview', 'chave-de-preview-de-teste-0123456789abcd');

create function pg_temp.hdr(p_env text)
returns text language sql as $f$
  select json_build_object('x-praxis-env', p_env || '.' || e.x || '.' || private.environment_signature(p_env, e.x, k.signing_key))::text
  from (select extract(epoch from now())::bigint + 600 as x) e,
       (select signing_key from public.calendar_environment_keys where environment = p_env::public.calendar_environment) k
$f$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Teste B2 links', 'teste-b2-links')).id as ws \gset
reset role;

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'adv', 'lawyer', 'active'),
  (:'ws'::uuid, :'adv2', 'lawyer', 'active'),
  (:'ws'::uuid, :'leitor', 'viewer', 'active');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_contact(:'ws'::uuid, 'pf', 'Cliente B2 links', null, null, null)).id as contact \gset
select create_lead(:'ws'::uuid, (:'contact')::uuid, 'Trabalhista', 'Lead B2 links', '{}'::text[], 'media', :'adv'::uuid) as lead \gset
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'meeting'::activity_type, p_title := 'Reunião sigilosa B2',
  p_due_date := (current_date + 5), p_due_time := '15:00'::time
) as reuniao \gset
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'meeting'::activity_type, p_title := 'Reunião sem vínculo',
  p_due_date := (current_date + 6), p_due_time := '10:00'::time
) as livre \gset
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'meeting'::activity_type, p_title := 'Reunião três',
  p_due_date := (current_date + 7), p_due_time := '11:00'::time
) as terceira \gset
reset role;

select pg_temp.hdr('production') as h_prod \gset
select pg_temp.hdr('preview') as h_prev \gset

select set_config('request.headers', :'h_prod', true);
select connect_calendar_account(:'ws'::uuid, :'dono'::uuid, 'dono@v.test', array['escopo'], 'refresh-cifrado', 'access-cifrado', now() + interval '1 hour', '1') as conn \gset
select set_calendar_connection_calendar(:'conn'::uuid, :'dono'::uuid, 'cal-links@x', 'Agenda de teste');
select create_calendar_event_link(:'conn'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'evento-links-1') as link \gset
update public.calendar_event_links
set meet_status = 'success', meet_url = 'https://meet.simulated/links', base_etag = '"segredo-etag"', base_title = 'Reunião sigilosa B2',
    duration_minutes = 90, last_synced_at = now()
where id = (:'link')::uuid;

-- ---------------------------------------------------------------------
-- 1) Acesso
-- ---------------------------------------------------------------------

set local role anon;
select throws_ok(
  format($i$ select list_activity_calendar_links(array[%L::uuid]) $i$, :'reuniao'),
  '42501', null, 'anon NÃO executa list_activity_calendar_links'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select set_config('request.headers', '', true);
select throws_ok(
  format($i$ select list_activity_calendar_links(array[%L::uuid]) $i$, :'reuniao'),
  'P0001', 'environment_required', 'sem ambiente autenticado a leitura é recusada'
);

select set_config('request.headers', :'h_prod', true);
select is(list_activity_calendar_links('{}'::uuid[]), '[]'::jsonb, 'lista vazia devolve vazio');
select throws_ok(
  format($i$ select list_activity_calendar_links(array_fill(%L::uuid, array[201])) $i$, :'reuniao'),
  'P0001', 'too_many_activities', 'mais de 200 atividades por chamada é recusado'
);

-- ---------------------------------------------------------------------
-- 2) O que a tela recebe
-- ---------------------------------------------------------------------

select is(
  (select jsonb_array_length(list_activity_calendar_links(array[(:'reuniao')::uuid, (:'livre')::uuid]))),
  1, 'só a atividade vinculada aparece (a sem vínculo não)'
);
select is(
  (select list_activity_calendar_links(array[(:'reuniao')::uuid]) -> 0 ->> 'isMine'),
  'true', 'o dono da conexão vê isMine = true'
);
select is(
  (select jsonb_build_object('s', e ->> 'status', 'd', e ->> 'durationMinutes', 'u', e ->> 'meetUrl', 'm', e ->> 'meetStatus')
   from jsonb_array_elements(list_activity_calendar_links(array[(:'reuniao')::uuid])) e),
  jsonb_build_object('s', 'linked', 'd', '90', 'u', 'https://meet.simulated/links', 'm', 'success'),
  'estado, duração e Meet do vínculo'
);
select is(
  (select (list_activity_calendar_links(array[(:'reuniao')::uuid]))::text ~* '(segredo|etag|Reunião sigilosa|cal-links|evento-links|dono@v|cifrado)'),
  false, 'NUNCA devolve título, etag, ids de agenda/evento, e-mail da conta nem token'
);

-- ---------------------------------------------------------------------
-- 3) Quem não é dono, ambiente e alcance
-- ---------------------------------------------------------------------

select set_config('request.jwt.claims', json_build_object('sub', :'adv', 'role', 'authenticated')::text, true);
select is(
  (select list_activity_calendar_links(array[(:'reuniao')::uuid]) -> 0 ->> 'isMine'),
  'false', 'outro usuário com acesso ao lead vê isMine = false'
);

select set_config('request.jwt.claims', json_build_object('sub', :'adv2', 'role', 'authenticated')::text, true);
select is(
  list_activity_calendar_links(array[(:'reuniao')::uuid]),
  '[]'::jsonb, 'advogado sem alcance ao lead não vê o vínculo'
);

select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select set_config('request.headers', :'h_prev', true);
select is(
  list_activity_calendar_links(array[(:'reuniao')::uuid]),
  '[]'::jsonb, 'o preview não enxerga vínculo de production'
);
reset role;

-- ---------------------------------------------------------------------
-- 4) Estado de sincronização gravado (visível depois de recarregar)
-- ---------------------------------------------------------------------

select set_config('request.headers', :'h_prod', true);

select begin_calendar_effect(:'conn'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'update', '{}'::jsonb) as i_pend \gset
select is(
  (select jsonb_build_object('c', calendar_id, 'e', event_id) from public.calendar_effect_intents where id = (:'i_pend')::uuid),
  jsonb_build_object('c', 'cal-links@x', 'e', 'evento-links-1'),
  'operação sobre compromisso vinculado grava como alvo a agenda e o evento DO VÍNCULO'
);
select resolve_calendar_effect(:'i_pend'::uuid, :'dono'::uuid, 'failed', 'provider_503', '{"syncState":"pending"}'::jsonb);
select is(
  (select jsonb_build_object('s', sync_state, 'o', sync_operation, 'e', sync_error) from public.calendar_event_links where id = (:'link')::uuid),
  jsonb_build_object('s', 'pending', 'o', 'update', 'e', 'provider_503'),
  'falha temporária fica GRAVADA no vínculo como pendente'
);

select begin_calendar_effect(:'conn'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'update', '{}'::jsonb) as i_fail \gset
select resolve_calendar_effect(:'i_fail'::uuid, :'dono'::uuid, 'failed', 'provider_400', '{}'::jsonb);
select is(
  (select sync_state from public.calendar_event_links where id = (:'link')::uuid),
  'failed', 'recusa definitiva fica gravada como falha'
);
select is(
  (select status from public.calendar_effect_intents where id = (:'i_pend')::uuid),
  'failed', 'intenção já definitiva não é reescrita por outra'
);

select begin_calendar_effect(:'conn'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'delete', '{}'::jsonb) as i_unc \gset
select resolve_calendar_effect(:'i_unc'::uuid, :'dono'::uuid, 'uncertain', 'result_uncertain', '{}'::jsonb);
select is(
  (select jsonb_build_object('s', sync_state, 'o', sync_operation) from public.calendar_event_links where id = (:'link')::uuid),
  jsonb_build_object('s', 'uncertain', 'o', 'delete'),
  'resultado incerto fica gravado como incerto, com a operação'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select is(
  (select jsonb_build_object('s', e ->> 'syncState', 'o', e ->> 'syncOperation')
   from jsonb_array_elements(list_activity_calendar_links(array[(:'reuniao')::uuid])) e),
  jsonb_build_object('s', 'uncertain', 'o', 'delete'),
  'a tela lê o estado gravado'
);
reset role;

-- Uma conferência posterior com desfecho definitivo encerra a incerta e limpa o estado.
select begin_calendar_effect(:'conn'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'update', '{}'::jsonb) as i_ok \gset
select resolve_calendar_effect(
  :'i_ok'::uuid, :'dono'::uuid, 'succeeded', '',
  jsonb_build_object('eventId', 'evento-links-1', 'etag', '"2"', 'title', 'Reunião sigilosa B2', 'cancelled', false,
    'hasMeet', true, 'durationMinutes', 90, 'crmVersion', 2, 'linkStatus', 'linked')
);
select is(
  (select jsonb_build_object('s', sync_state, 'e', sync_error) from public.calendar_event_links where id = (:'link')::uuid),
  jsonb_build_object('s', 'in_sync', 'e', null),
  'sucesso volta o vínculo a in_sync'
);
select is(
  (select status from public.calendar_effect_intents where id = (:'i_unc')::uuid),
  'superseded', 'a intenção incerta anterior é encerrada pela conferência'
);
select is(
  (select count(*)::int from public.audit_logs
   where workspace_id = :'ws'::uuid and action like 'calendar.link.sync_%' and metadata::text ~* '(etag|sigilosa|evento-links)'),
  0, 'a auditoria do estado de sincronização não guarda título, etag nem ids de evento'
);

-- ---------------------------------------------------------------------
-- 5) mark_calendar_link_pending
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select mark_calendar_link_pending(%L::uuid, %L::uuid, 'x') $i$, :'reuniao', :'dono'),
  '42501', null, 'authenticated NÃO executa mark_calendar_link_pending'
);
reset role;

select is(mark_calendar_link_pending(:'reuniao'::uuid, :'adv'::uuid, 'connection_not_active'), false,
  'outro usuário não marca pendência no vínculo da conexão alheia');
select is(mark_calendar_link_pending(:'reuniao'::uuid, :'dono'::uuid, 'connection_not_active'), true,
  'o dono da conexão marca a pendência quando a sincronização nem começou');
select is(
  (select jsonb_build_object('s', sync_state, 'e', sync_error) from public.calendar_event_links where id = (:'link')::uuid),
  jsonb_build_object('s', 'pending', 'e', 'connection_not_active'),
  'e ela fica gravada'
);
select set_config('request.headers', :'h_prev', true);
select is(mark_calendar_link_pending(:'reuniao'::uuid, :'dono'::uuid, 'x'), false,
  'o preview não marca pendência em vínculo de production');
select set_config('request.headers', :'h_prod', true);

-- ---------------------------------------------------------------------
-- 6) Vínculo existente não some quando a atividade deixa de ser reunião
-- ---------------------------------------------------------------------

update public.activities set type = 'task', has_time = false where id = (:'reuniao')::uuid;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select is(
  (select list_activity_calendar_links(array[(:'reuniao')::uuid]) -> 0 ->> 'status'),
  'linked', 'o vínculo continua aparecendo mesmo com a atividade virada tarefa sem horário'
);
reset role;

-- ---------------------------------------------------------------------
-- 7) Inclusão no Google com resultado incerto (ainda sem vínculo)
-- ---------------------------------------------------------------------

select throws_ok(
  format($i$ select begin_calendar_effect(%L::uuid, %L::uuid, %L::uuid, 'create', '{}'::jsonb) $i$, :'conn', :'livre', :'dono'),
  'P0001', 'calendar_target_required', 'a inclusão só nasce com a agenda e o evento que vai usar'
);
select throws_ok(
  format($i$ select begin_calendar_effect(%L::uuid, %L::uuid, %L::uuid, 'create', '{}'::jsonb, 'outra-agenda@x', 'evento-livre') $i$, :'conn', :'livre', :'dono'),
  'P0001', 'calendar_selection_changed', 'a agenda da tentativa é a selecionada no momento do registro'
);

select begin_calendar_effect(:'conn'::uuid, :'livre'::uuid, :'dono'::uuid, 'create', '{}'::jsonb, 'cal-links@x', 'evento-livre') as i_create \gset
select is(
  (select jsonb_build_object('c', calendar_id, 'e', event_id, 'k', connection_id, 'v', environment, 'w', workspace_id)
   from public.calendar_effect_intents where id = (:'i_create')::uuid),
  jsonb_build_object('c', 'cal-links@x', 'e', 'evento-livre', 'k', :'conn', 'v', 'production', 'w', :'ws'),
  'a identidade da tentativa (ambiente, workspace, conexão, agenda, evento) é gravada ANTES da chamada'
);
select resolve_calendar_effect(:'i_create'::uuid, :'dono'::uuid, 'uncertain', 'result_uncertain', '{}'::jsonb);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select is(
  (select jsonb_build_object('s', e ->> 'status', 'y', e ->> 'syncState', 'o', e ->> 'syncOperation', 'm', e ->> 'isMine')
   from jsonb_array_elements(list_activity_calendar_links(array[(:'livre')::uuid])) e),
  jsonb_build_object('s', 'not_linked', 'y', 'uncertain', 'o', 'create', 'm', 'true'),
  'inclusão incerta aparece para a tela, mesmo sem vínculo'
);
select throws_ok(
  format($i$ select get_open_calendar_create(%L::uuid, %L::uuid) $i$, :'livre', :'dono'),
  '42501', null, 'authenticated NÃO executa get_open_calendar_create'
);
reset role;

select throws_ok(
  format($i$ select begin_calendar_effect(%L::uuid, %L::uuid, %L::uuid, 'create', '{}'::jsonb, 'cal-links@x', 'evento-livre') $i$, :'conn', :'livre', :'dono'),
  'P0001', 'create_outcome_uncertain', 'com uma inclusão sem desfecho, outra não nasce (o evento pode existir)'
);
select throws_ok(
  format($i$ update public.calendar_effect_intents set calendar_id = 'cal-links-2@x' where id = %L::uuid $i$, :'i_create'),
  'P0001', 'intent_identity_immutable', 'a identidade gravada não pode ser trocada depois'
);

-- A verificação lê a tentativa ORIGINAL.
select is(
  get_open_calendar_create(:'livre'::uuid, :'dono'::uuid) - 'intentId' - 'workspaceId',
  jsonb_build_object('isMine', true, 'environment', 'production', 'connectionId', :'conn',
    'calendarId', 'cal-links@x', 'eventId', 'evento-livre', 'status', 'uncertain', 'settled', true),
  'o autor recebe a tentativa original, com o alvo gravado'
);
select is(
  get_open_calendar_create(:'livre'::uuid, :'adv'::uuid),
  '{"isMine": false}'::jsonb, 'outra pessoa com alcance só sabe que existe (sem conexão, agenda nem evento)'
);
select throws_ok(
  format($i$ select get_open_calendar_create(%L::uuid, %L::uuid) $i$, :'livre', :'adv2'),
  'P0001', 'activity_not_found', 'sem alcance ao lead, nem isso'
);
select set_config('request.headers', :'h_prev', true);
select is(get_open_calendar_create(:'livre'::uuid, :'dono'::uuid), null::jsonb, 'o preview não enxerga a tentativa de production');
select set_config('request.headers', :'h_prod', true);

-- Troca de agenda entre a inclusão incerta e a verificação: o evento
-- encontrado é vinculado na agenda DA TENTATIVA, e só a intenção original é
-- concluída. Outra intenção aberta da mesma atividade, de outro alvo (aqui,
-- sem alvo registrado), continua aberta.
select set_calendar_connection_calendar(:'conn'::uuid, :'dono'::uuid, 'cal-links-2@x', 'Outra agenda');
insert into public.calendar_effect_intents (workspace_id, connection_id, activity_id, environment, operation, status, created_by)
values (:'ws'::uuid, (:'conn')::uuid, (:'livre')::uuid, 'production', 'update', 'uncertain', :'dono') returning id as i_outro \gset

select throws_ok(
  format($i$ select resolve_calendar_effect(%L::uuid, %L::uuid, 'succeeded', '', '{"eventId":"outro-evento"}'::jsonb) $i$, :'i_create', :'dono'),
  'P0001', 'intent_target_mismatch', 'a inclusão só é concluída no evento gravado'
);
select resolve_calendar_effect(
  :'i_create'::uuid, :'dono'::uuid, 'succeeded', '',
  jsonb_build_object('eventId', 'evento-livre', 'etag', '"1"', 'title', 'Reunião sem vínculo', 'cancelled', false,
    'hasMeet', false, 'durationMinutes', 60, 'crmVersion', 1, 'linkStatus', 'linked')
) as link_livre \gset
select is(
  (select calendar_id from public.calendar_event_links where id = (:'link_livre')::uuid),
  'cal-links@x', 'depois da troca de agenda, o evento é vinculado na agenda ORIGINAL da tentativa'
);
select is(
  (select status from public.calendar_effect_intents where id = (:'i_create')::uuid),
  'succeeded', 'a intenção original é a concluída (nenhuma nova é aberta)'
);
select is(
  (select status from public.calendar_effect_intents where id = (:'i_outro')::uuid),
  'uncertain', 'outra intenção aberta da mesma atividade, de outro alvo, NÃO é encerrada'
);
select is(get_open_calendar_create(:'livre'::uuid, :'dono'::uuid), null::jsonb, 'concluída, não há mais inclusão a verificar');

-- Sem acesso à agenda da tentativa: a MESMA intenção continua aberta. Só a
-- ausência confirmada (com acesso) a encerra.
select begin_calendar_effect(:'conn'::uuid, :'terceira'::uuid, :'dono'::uuid, 'create', '{}'::jsonb, 'cal-links-2@x', 'evento-tres') as i_tres \gset
select resolve_calendar_effect(:'i_tres'::uuid, :'dono'::uuid, 'uncertain', 'result_uncertain', '{}'::jsonb);
select resolve_calendar_effect(:'i_tres'::uuid, :'dono'::uuid, 'uncertain', 'calendar_access_lost', '{}'::jsonb);
select is(
  (select jsonb_build_object('s', status, 'e', error_code) from public.calendar_effect_intents where id = (:'i_tres')::uuid),
  jsonb_build_object('s', 'uncertain', 'e', 'calendar_access_lost'),
  'sem acesso à agenda, a pendência continua aberta (não vira ausência)'
);
select resolve_calendar_effect(:'i_tres'::uuid, :'dono'::uuid, 'failed', 'not_created_confirmed', '{}'::jsonb);
select is(get_open_calendar_create(:'terceira'::uuid, :'dono'::uuid), null::jsonb, 'ausência confirmada encerra a pendência');

-- Intenção sem alvo registrado: nenhuma conclusão é inventada.
insert into public.calendar_effect_intents (workspace_id, connection_id, activity_id, environment, operation, status, created_by)
values (:'ws'::uuid, (:'conn')::uuid, (:'terceira')::uuid, 'production', 'create', 'uncertain', :'dono') returning id as i_legado \gset
select is(
  get_open_calendar_create(:'terceira'::uuid, :'dono'::uuid) ->> 'calendarId',
  null::text, 'intenção sem alvo registrado chega sem agenda (nenhuma é deduzida)'
);
select throws_ok(
  format($i$ select resolve_calendar_effect(%L::uuid, %L::uuid, 'succeeded', '', '{"eventId":"evento-tres"}'::jsonb) $i$, :'i_legado', :'dono'),
  'P0001', 'intent_target_unknown', 'e não pode ser concluída como criada'
);

select * from finish();
rollback;
