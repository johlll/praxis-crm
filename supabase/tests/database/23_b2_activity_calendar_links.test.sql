-- pgTAP — B2, etapa 2b: leitura do vínculo com a agenda pela interface
-- (list_activity_calendar_links). Todos os registros são criados por este
-- teste. Mostra o que a tela recebe e, principalmente, o que NÃO recebe.

begin;
select plan(11);

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

select * from finish();
rollback;
