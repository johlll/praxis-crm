-- pgTAP — B2, etapa 2: intenções de efeito externo, base de sincronização,
-- conflitos e aplicação do valor do Google (docs/decisoes/b2-google-agenda.md
-- §6). Todos os registros são criados por este teste (workspace, atividades,
-- conexões e vínculos próprios de QA).
--
-- As funções de escrita são exclusivas do service_role (chamadas sem troca
-- de role; a prova de que `authenticated` NÃO as executa é feita à parte) e
-- exigem o ambiente AUTENTICADO da requisição (cabeçalho assinado, montado
-- aqui como o servidor faz).

begin;
select plan(62);

\set dono   '20000000-0000-0000-0000-000000000001'
\set adv    '20000000-0000-0000-0000-000000000002'
\set adv2   '20000000-0000-0000-0000-000000000003'
\set leitor '20000000-0000-0000-0000-000000000005'

insert into public.calendar_environment_keys (environment, signing_key) values
  ('production', 'chave-de-producao-de-teste-0123456789ab'),
  ('preview', 'chave-de-preview-de-teste-0123456789abcd');

create function pg_temp.hdr(p_env text, p_key_env text default null, p_expires bigint default null)
returns text language sql as $f$
  select json_build_object('x-praxis-env', p_env || '.' || e.x || '.' || private.environment_signature(p_env, e.x, k.signing_key))::text
  from (select coalesce(p_expires, extract(epoch from now())::bigint + 600) as x) e,
       (select signing_key from public.calendar_environment_keys
         where environment = coalesce(p_key_env, p_env)::public.calendar_environment) k
$f$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Teste B2 sync', 'teste-b2-sync')).id as ws \gset
reset role;

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'adv', 'lawyer', 'active'),
  (:'ws'::uuid, :'adv2', 'lawyer', 'active'),
  (:'ws'::uuid, :'leitor', 'viewer', 'active');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_contact(:'ws'::uuid, 'pf', 'Cliente B2 sync', null, null, null)).id as contact \gset
select create_lead(:'ws'::uuid, (:'contact')::uuid, 'Trabalhista', 'Lead B2 sync', '{}'::text[], 'media', :'adv'::uuid) as lead \gset
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'meeting'::activity_type, p_title := 'Reunião B2',
  p_due_date := (current_date + 5), p_due_time := '15:00'::time
) as reuniao \gset
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'task'::activity_type, p_title := 'Tarefa B2',
  p_due_date := (current_date + 5)
) as tarefa \gset
reset role;

select pg_temp.hdr('production') as h_prod \gset
select pg_temp.hdr('preview') as h_prev \gset

select set_config('request.headers', :'h_prod', true);
select connect_calendar_account(:'ws'::uuid, :'dono'::uuid, 'dono@v.test', array['escopo'], 'refresh-cifrado', 'access-cifrado', now() + interval '1 hour', '1') as conn_prod \gset
select set_calendar_connection_calendar(:'conn_prod'::uuid, :'dono'::uuid, 'cal-prod@x', 'Agenda de produção');
select set_config('request.headers', :'h_prev', true);
select connect_calendar_account(:'ws'::uuid, :'dono'::uuid, 'dono@v.test', array['escopo'], 'refresh-prev', 'access-prev', now() + interval '1 hour', '1') as conn_prev \gset
select set_calendar_connection_calendar(:'conn_prev'::uuid, :'dono'::uuid, 'cal-prev@x', 'Agenda de teste');

-- ---------------------------------------------------------------------
-- 1) Tabelas e grants
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('calendar_effect_intents', 'calendar_sync_conflicts')
     and c.relrowsecurity and c.relforcerowsecurity),
  2, 'RLS habilitada E forçada em calendar_effect_intents e calendar_sync_conflicts'
);
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('calendar_effect_intents', 'calendar_sync_conflicts')
     and grantee in ('anon', 'authenticated')),
  0, 'nenhum GRANT de tabela para anon/authenticated'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select begin_calendar_effect(%L::uuid, %L::uuid, %L::uuid, 'create', '{}'::jsonb) $i$, :'conn_prod', :'reuniao', :'dono'),
  '42501', null, 'authenticated NÃO executa begin_calendar_effect'
);
select throws_ok(
  format($i$ select resolve_calendar_effect(gen_random_uuid(), %L::uuid, 'failed', 'x', '{}'::jsonb) $i$, :'dono'),
  '42501', null, 'authenticated NÃO executa resolve_calendar_effect'
);
select throws_ok(
  format($i$ select get_calendar_link(%L::uuid, %L::uuid) $i$, :'reuniao', :'dono'),
  '42501', null, 'authenticated NÃO executa get_calendar_link'
);
select throws_ok(
  format($i$ select record_calendar_conflict(gen_random_uuid(), %L::uuid, 'title', '1'::jsonb, '2'::jsonb, 'google_prevails') $i$, :'dono'),
  '42501', null, 'authenticated NÃO executa record_calendar_conflict'
);
select throws_ok(
  format($i$ select apply_google_values_to_activity(%L::uuid, %L::uuid, 1, 'x', null) $i$, :'reuniao', :'dono'),
  '42501', null, 'authenticated NÃO executa apply_google_values_to_activity'
);
select throws_ok(
  format($i$ select store_calendar_access_token(%L::uuid, %L::uuid, 'c', now(), '1') $i$, :'conn_prod', :'dono'),
  '42501', null, 'authenticated NÃO executa store_calendar_access_token'
);
reset role;

-- ---------------------------------------------------------------------
-- 2) begin_calendar_effect
-- ---------------------------------------------------------------------

select set_config('request.headers', '', true);
select throws_ok(
  format($i$ select begin_calendar_effect(%L::uuid, %L::uuid, %L::uuid, 'create', '{}'::jsonb) $i$, :'conn_prod', :'reuniao', :'dono'),
  'P0001', 'environment_required', 'sem ambiente autenticado a intenção não nasce'
);

select set_config('request.headers', :'h_prod', true);
select throws_ok(
  format($i$ select begin_calendar_effect(%L::uuid, %L::uuid, %L::uuid, 'create', '{}'::jsonb) $i$, :'conn_prod', :'reuniao', :'leitor'),
  'P0001', 'connection_not_found', 'só o dono da conexão registra intenção'
);
select throws_ok(
  format($i$ select begin_calendar_effect(%L::uuid, %L::uuid, %L::uuid, 'teleporte', '{}'::jsonb) $i$, :'conn_prod', :'reuniao', :'dono'),
  'P0001', 'invalid_operation', 'operação desconhecida é recusada'
);
select throws_ok(
  format($i$ select begin_calendar_effect(%L::uuid, %L::uuid, %L::uuid, 'create', '{}'::jsonb) $i$, :'conn_prod', :'tarefa', :'dono'),
  'P0001', 'activity_not_appointment', 'só reunião com horário vira compromisso'
);

select begin_calendar_effect(:'conn_prod'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'create', '{"title":"Reunião B2"}'::jsonb) as intent_create \gset
select is(
  (select status from public.calendar_effect_intents where id = (:'intent_create')::uuid),
  'pending', 'a intenção nasce pendente, ANTES de qualquer efeito externo'
);

select set_config('request.headers', :'h_prev', true);
select throws_ok(
  format($i$ select begin_calendar_effect(%L::uuid, %L::uuid, %L::uuid, 'create', '{}'::jsonb) $i$, :'conn_prod', :'reuniao', :'dono'),
  'P0001', 'calendar_environment_mismatch', 'preview não registra intenção sobre conexão de production'
);

-- ---------------------------------------------------------------------
-- 3) resolve_calendar_effect — grava vínculo e base no mesmo passo
-- ---------------------------------------------------------------------

select set_config('request.headers', :'h_prod', true);
select throws_ok(
  format($i$ select resolve_calendar_effect(%L::uuid, %L::uuid, 'succeeded', '', '{"eventId":"x"}'::jsonb) $i$, :'intent_create', :'leitor'),
  'P0001', 'intent_not_found', 'só quem abriu a intenção a resolve'
);

select set_config('request.headers', :'h_prev', true);
select throws_ok(
  format($i$ select resolve_calendar_effect(%L::uuid, %L::uuid, 'succeeded', '', '{"eventId":"x"}'::jsonb) $i$, :'intent_create', :'dono'),
  'P0001', 'calendar_environment_mismatch', 'preview não resolve intenção de production'
);

select set_config('request.headers', :'h_prod', true);
select resolve_calendar_effect(:'intent_create'::uuid, :'dono'::uuid, 'uncertain', 'result_uncertain', '{}'::jsonb);
select is(
  (select status from public.calendar_effect_intents where id = (:'intent_create')::uuid),
  'uncertain', 'resultado incerto fica registrado como incerto (não vira falha)'
);
select is(
  (select count(*)::int from public.calendar_event_links where activity_id = (:'reuniao')::uuid),
  0, 'incerto não cria vínculo'
);

select resolve_calendar_effect(
  :'intent_create'::uuid, :'dono'::uuid, 'succeeded', '',
  jsonb_build_object('eventId', 'evento-1', 'etag', '"7"', 'title', 'Reunião B2',
    'start', '2026-11-10T14:00:00Z', 'end', '2026-11-10T15:00:00Z', 'cancelled', false, 'hasMeet', true,
    'meetStatus', 'success', 'meetUrl', 'https://meet.simulated/evento-1', 'meetRequestId', 'req-1',
    'durationMinutes', 90, 'crmVersion', 3, 'linkStatus', 'linked')
) as link \gset
select ok(:'link' is not null, 'depois de incerto, a conferência de estado pode concluir a MESMA intenção');

select is(
  (select jsonb_build_object('t', base_title, 'e', base_etag, 'd', duration_minutes, 'm', meet_status, 'v', base_crm_version)
   from public.calendar_event_links where id = (:'link')::uuid),
  jsonb_build_object('t', 'Reunião B2', 'e', '"7"', 'd', 90, 'm', 'success', 'v', 3),
  'o vínculo nasce com título, etag, duração, Meet e versão do CRM da base'
);

select is(
  resolve_calendar_effect(:'intent_create'::uuid, :'dono'::uuid, 'failed', 'tarde-demais', '{}'::jsonb),
  (:'link')::uuid, 'resultado definitivo é idempotente (não reescrito)'
);
select is(
  (select status from public.calendar_effect_intents where id = (:'intent_create')::uuid),
  'succeeded', 'e continua succeeded'
);

-- Falha definitiva: nenhum vínculo novo.
select begin_calendar_effect(:'conn_prod'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'update', '{}'::jsonb) as intent_falha \gset
select resolve_calendar_effect(:'intent_falha'::uuid, :'dono'::uuid, 'failed', 'provider_500', '{}'::jsonb);
select is(
  (select status from public.calendar_effect_intents where id = (:'intent_falha')::uuid),
  'failed', 'falha definitiva registrada'
);

-- ---------------------------------------------------------------------
-- 4) get_calendar_link
-- ---------------------------------------------------------------------

select is(
  (get_calendar_link(:'reuniao'::uuid, :'dono'::uuid) ->> 'baseEtag'),
  '"7"', 'get_calendar_link devolve a base'
);
select is(
  get_calendar_link(:'tarefa'::uuid, :'dono'::uuid),
  null, 'atividade sem vínculo: null'
);
select throws_ok(
  format($i$ select get_calendar_link(%L::uuid, %L::uuid) $i$, :'reuniao', :'adv2'),
  'P0001', 'activity_not_found', 'sem alcance ao lead, o vínculo não é nem confirmado'
);
select set_config('request.headers', :'h_prev', true);
select throws_ok(
  format($i$ select get_calendar_link(%L::uuid, %L::uuid) $i$, :'reuniao', :'dono'),
  'P0001', 'calendar_environment_mismatch', 'vínculo de production não é lido a partir de preview'
);

-- ---------------------------------------------------------------------
-- 5) Atualização: a base avança, o Meet já obtido é preservado
-- ---------------------------------------------------------------------

select set_config('request.headers', :'h_prod', true);
select begin_calendar_effect(:'conn_prod'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'update', '{}'::jsonb) as intent_upd \gset
select resolve_calendar_effect(
  :'intent_upd'::uuid, :'dono'::uuid, 'succeeded', '',
  jsonb_build_object('eventId', 'evento-1', 'etag', '"9"', 'title', 'Reunião B2',
    'start', '2026-11-12T16:00:00Z', 'end', '2026-11-12T17:00:00Z', 'cancelled', false, 'hasMeet', true,
    'durationMinutes', 90, 'crmVersion', 4, 'linkStatus', 'linked')
);
select is(
  (select jsonb_build_object('s', base_start, 'e', base_etag, 'm', meet_status, 'u', meet_url, 'v', base_crm_version)
   from public.calendar_event_links where event_id = 'evento-1'),
  jsonb_build_object('s', '2026-11-12T16:00:00+00:00'::timestamptz, 'e', '"9"', 'm', 'success', 'u', 'https://meet.simulated/evento-1', 'v', 4),
  'a base avança e o Meet obtido antes continua guardado'
);
select is(
  (select count(*)::int from public.calendar_event_links where activity_id = (:'reuniao')::uuid and status = 'linked'),
  1, 'continua um único vínculo ativo'
);

-- ---------------------------------------------------------------------
-- 5b) Meet: chave AUSENTE preserva; chave com null é remoção explícita
-- ---------------------------------------------------------------------

select begin_calendar_effect(:'conn_prod'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'update', '{}'::jsonb) as intent_meet \gset
select resolve_calendar_effect(
  :'intent_meet'::uuid, :'dono'::uuid, 'succeeded', '',
  jsonb_build_object('eventId', 'evento-1', 'etag', '"9b"', 'title', 'Reunião B2', 'cancelled', false, 'hasMeet', true,
    'meetStatus', null, 'meetUrl', null, 'durationMinutes', 90, 'crmVersion', 4, 'linkStatus', 'linked')
);
select is(
  (select jsonb_build_object('s', meet_status, 'u', meet_url) from public.calendar_event_links where event_id = 'evento-1'),
  jsonb_build_object('s', null, 'u', null),
  'Meet removido no Google (null explícito) limpa status e URL do vínculo'
);
select is(
  (select meet_request_id from public.calendar_event_links where event_id = 'evento-1'),
  'req-1', 'o pedido de Meet (chave ausente) continua guardado'
);

select begin_calendar_effect(:'conn_prod'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'meet', '{}'::jsonb) as intent_meet2 \gset
select resolve_calendar_effect(
  :'intent_meet2'::uuid, :'dono'::uuid, 'succeeded', '',
  jsonb_build_object('eventId', 'evento-1', 'etag', '"9c"', 'title', 'Reunião B2', 'cancelled', false, 'hasMeet', true,
    'meetStatus', 'success', 'meetUrl', 'https://meet.simulated/evento-1b', 'meetRequestId', 'req-2',
    'durationMinutes', 90, 'crmVersion', 4, 'linkStatus', 'linked')
);
select is(
  (select jsonb_build_object('s', meet_status, 'u', meet_url, 'r', meet_request_id) from public.calendar_event_links where event_id = 'evento-1'),
  jsonb_build_object('s', 'success', 'u', 'https://meet.simulated/evento-1b', 'r', 'req-2'),
  'um Meet novo (chaves presentes) substitui o valor guardado'
);

-- ---------------------------------------------------------------------
-- 5c) O vínculo manda na conexão e na agenda
-- ---------------------------------------------------------------------

select connect_calendar_account(:'ws'::uuid, :'adv'::uuid, 'adv@v.test', array['escopo'], 'refresh-adv', 'access-adv', now() + interval '1 hour', '1') as conn_adv \gset
select set_calendar_connection_calendar(:'conn_adv'::uuid, :'adv'::uuid, 'cal-adv@x', 'Agenda do advogado');
select count(*)::int as intents_antes from public.calendar_effect_intents \gset

select throws_ok(
  format($i$ select begin_calendar_effect(%L::uuid, %L::uuid, %L::uuid, 'update', '{}'::jsonb) $i$, :'conn_adv', :'reuniao', :'adv'),
  'P0001', 'calendar_link_mismatch', 'conexão de OUTRO usuário não opera o compromisso vinculado pela conexão do dono'
);

select set_calendar_connection_calendar(:'conn_prod'::uuid, :'dono'::uuid, 'cal-prod-2@x', 'Outra agenda');
select throws_ok(
  format($i$ select begin_calendar_effect(%L::uuid, %L::uuid, %L::uuid, 'delete', '{}'::jsonb) $i$, :'conn_prod', :'reuniao', :'dono'),
  'P0001', 'calendar_link_mismatch', 'o mesmo usuário com OUTRA agenda selecionada também não opera o vínculo'
);
select is(
  (select count(*)::int from public.calendar_effect_intents),
  :'intents_antes'::int, 'as recusas não criam intenção'
);

-- Uma intenção aberta ANTES da troca de agenda é resolvida no MESMO vínculo.
select set_calendar_connection_calendar(:'conn_prod'::uuid, :'dono'::uuid, 'cal-prod@x', 'Agenda de produção');
select begin_calendar_effect(:'conn_prod'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'update', '{}'::jsonb) as intent_troca \gset
select set_calendar_connection_calendar(:'conn_prod'::uuid, :'dono'::uuid, 'cal-prod-2@x', 'Outra agenda');
select resolve_calendar_effect(
  :'intent_troca'::uuid, :'dono'::uuid, 'succeeded', '',
  jsonb_build_object('eventId', 'evento-1', 'etag', '"9d"', 'title', 'Reunião B2', 'cancelled', false, 'hasMeet', true,
    'durationMinutes', 90, 'crmVersion', 4, 'linkStatus', 'linked')
);
select is(
  (select count(*)::int from public.calendar_event_links where activity_id = (:'reuniao')::uuid and status <> 'unlinked'),
  1, 'resolver depois da troca de agenda NÃO cria um segundo vínculo'
);
select is(
  (select calendar_id from public.calendar_event_links where event_id = 'evento-1'),
  'cal-prod@x', 'o vínculo continua na agenda original'
);
select set_calendar_connection_calendar(:'conn_prod'::uuid, :'dono'::uuid, 'cal-prod@x', 'Agenda de produção');

-- Defesa em profundidade: intenção de outra conexão não grava no vínculo alheio.
insert into public.calendar_effect_intents (workspace_id, connection_id, activity_id, environment, operation, created_by)
values (:'ws'::uuid, (:'conn_adv')::uuid, (:'reuniao')::uuid, 'production', 'update', :'adv') returning id as intent_alheia \gset
select throws_ok(
  format($i$ select resolve_calendar_effect(%L::uuid, %L::uuid, 'succeeded', '', '{"eventId":"evento-1","cancelled":true}'::jsonb) $i$, :'intent_alheia', :'adv'),
  'P0001', 'calendar_link_mismatch', 'resolver não grava no vínculo de outra conexão'
);

-- ---------------------------------------------------------------------
-- 6) Conflitos: o valor perdedor é guardado, a auditoria não tem valores
-- ---------------------------------------------------------------------

select record_calendar_conflict(
  :'link'::uuid, :'dono'::uuid, 'schedule',
  '{"start":"2026-11-12T16:00:00Z"}'::jsonb, '{"start":"2026-11-13T09:00:00Z"}'::jsonb, 'google_prevails'
) as conflito \gset
select is(
  (select crm_value ->> 'start' from public.calendar_sync_conflicts where id = (:'conflito')::uuid),
  '2026-11-12T16:00:00Z', 'o valor do CRM que perdeu fica gravado'
);
select is(
  (select count(*)::int from public.audit_logs
   where workspace_id = :'ws'::uuid and action = 'calendar.conflict.recorded' and metadata::text ~ '(2026|crm_value|google_value)'),
  0, 'a auditoria do conflito guarda só o fato, nunca os valores'
);
select throws_ok(
  format($i$ select record_calendar_conflict(gen_random_uuid(), %L::uuid, 'title', '1'::jsonb, '2'::jsonb, 'google_prevails') $i$, :'dono'),
  'P0001', 'link_not_found', 'conflito sobre vínculo inexistente é recusado'
);
select throws_ok(
  format($i$ select record_calendar_conflict(%L::uuid, %L::uuid, 'title', '1'::jsonb, '2'::jsonb, 'inventado') $i$, :'link', :'dono'),
  '23514', null, 'resolução fora da lista é recusada pela constraint'
);
select set_config('request.headers', :'h_prev', true);
select throws_ok(
  format($i$ select record_calendar_conflict(%L::uuid, %L::uuid, 'title', '1'::jsonb, '2'::jsonb, 'google_prevails') $i$, :'link', :'dono'),
  'P0001', 'calendar_environment_mismatch', 'preview não registra conflito de vínculo de production'
);

-- ---------------------------------------------------------------------
-- 7) apply_google_values_to_activity: passa pelo gatilho do ambiente
-- ---------------------------------------------------------------------

select lock_version as v0 from public.activities where id = (:'reuniao')::uuid \gset

select throws_ok(
  format($i$ select apply_google_values_to_activity(%L::uuid, %L::uuid, %s, 'Título do Google', null) $i$, :'reuniao', :'dono', :'v0'),
  'P0001', 'calendar_environment_mismatch', 'preview não altera atividade vinculada a production'
);
select set_config('request.headers', :'h_prod', true);
select throws_ok(
  format($i$ select apply_google_values_to_activity(%L::uuid, %L::uuid, 1, 'x', null) $i$, :'tarefa', :'dono'),
  'P0001', 'calendar_environment_mismatch', 'atividade sem vínculo não recebe valores do Google'
);
select throws_ok(
  format($i$ select apply_google_values_to_activity(%L::uuid, %L::uuid, null, 'x', null) $i$, :'reuniao', :'dono'),
  'P0001', 'expected_version_required', 'sem a versão lida, nada é aplicado'
);

-- Edição do CRM depois da leitura: a versão esperada já não vale.
select count(*)::int as conflitos_antes from public.calendar_sync_conflicts \gset
select is(
  apply_google_values_to_activity(
    :'reuniao'::uuid, :'dono'::uuid, (:'v0')::bigint - 1, 'Sobrescrita indevida', '2026-12-01T10:00:00Z'::timestamptz,
    '[{"field":"title","crmValue":"x","googleValue":"y"}]'::jsonb
  ),
  null::bigint, 'versão desatualizada: devolve null e não aplica'
);
select is(
  (select jsonb_build_object('t', title, 'v', lock_version) from public.activities where id = (:'reuniao')::uuid),
  jsonb_build_object('t', 'Reunião B2', 'v', (:'v0')::bigint),
  'a edição do CRM (título e versão) permanece intacta'
);
select is(
  (select count(*)::int from public.calendar_sync_conflicts),
  :'conflitos_antes'::int, 'versão desatualizada não grava conflito'
);

select apply_google_values_to_activity(
  :'reuniao'::uuid, :'dono'::uuid, (:'v0')::bigint, 'Título do Google', '2026-11-13T09:00:00Z'::timestamptz,
  '[{"field":"schedule","crmValue":{"start":"2026-11-12T16:30:00Z"},"googleValue":{"start":"2026-11-13T09:00:00Z"}}]'::jsonb
) as versao \gset
select is(
  (select jsonb_build_object('t', title, 'd', due_at, 'h', has_time) from public.activities where id = (:'reuniao')::uuid),
  jsonb_build_object('t', 'Título do Google', 'd', '2026-11-13T09:00:00+00:00'::timestamptz, 'h', true),
  'o valor do Google é aplicado à atividade (título e horário)'
);
select is((:'versao')::bigint, (:'v0')::bigint + 1, 'a versão da atividade avança em 1 (controle de concorrência do CRM)');
select is(
  (select crm_value ->> 'start' from public.calendar_sync_conflicts
   where link_id = (:'link')::uuid and crm_value ->> 'start' = '2026-11-12T16:30:00Z'),
  '2026-11-12T16:30:00Z', 'o valor do CRM que perdeu é gravado NA MESMA transação em que o do Google é aplicado'
);
select throws_ok(
  format($i$ select apply_google_values_to_activity(%L::uuid, %L::uuid, %s, 'Outro', null, '[{"field":"inventado","crmValue":1,"googleValue":2}]'::jsonb) $i$, :'reuniao', :'dono', :'versao'),
  '23514', null, 'conflito inválido aborta a aplicação inteira'
);
select is(
  (select jsonb_build_object('t', title, 'v', lock_version) from public.activities where id = (:'reuniao')::uuid),
  jsonb_build_object('t', 'Título do Google', 'v', (:'versao')::bigint),
  'e a atividade fica como estava (nada de aplicação pela metade)'
);
select throws_ok(
  format($i$ select apply_google_values_to_activity(%L::uuid, %L::uuid, %s, 'x', null) $i$, :'reuniao', :'adv2', :'versao'),
  'P0001', 'activity_not_found', 'sem alcance ao lead, nada é aplicado'
);

-- ---------------------------------------------------------------------
-- 8) Cancelamento: o vínculo é desfeito, a atividade permanece
-- ---------------------------------------------------------------------

select begin_calendar_effect(:'conn_prod'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'delete', '{"cancel":true}'::jsonb) as intent_del \gset
select resolve_calendar_effect(
  :'intent_del'::uuid, :'dono'::uuid, 'succeeded', '',
  jsonb_build_object('eventId', 'evento-1', 'etag', '"10"', 'title', 'Título do Google', 'cancelled', true, 'hasMeet', true,
    'durationMinutes', 90, 'crmVersion', 5, 'linkStatus', 'unlinked')
);
select is(
  get_calendar_link(:'reuniao'::uuid, :'dono'::uuid),
  null, 'depois de cancelar não há vínculo ativo'
);
select is(
  (select count(*)::int from public.activities where id = (:'reuniao')::uuid),
  1, 'cancelar no Google NÃO apaga a atividade do CRM'
);

-- ---------------------------------------------------------------------
-- 9) Renovação do token de acesso
-- ---------------------------------------------------------------------

select store_calendar_access_token(:'conn_prod'::uuid, :'dono'::uuid, 'novo-access-cifrado', now() + interval '2 hours', '1');
select is(
  (select access_token_ciphertext from public.calendar_connections where id = (:'conn_prod')::uuid),
  'novo-access-cifrado', 'o novo token de acesso (já cifrado) é guardado'
);
select throws_ok(
  format($i$ select store_calendar_access_token(%L::uuid, %L::uuid, 'c', now(), '2') $i$, :'conn_prod', :'dono'),
  'P0001', 'key_version_mismatch', 'só com a versão de chave da conexão'
);
select throws_ok(
  format($i$ select store_calendar_access_token(%L::uuid, %L::uuid, 'c', now(), '1') $i$, :'conn_prod', :'leitor'),
  'P0001', 'connection_not_found', 'só o dono da conexão renova'
);
select set_config('request.headers', :'h_prev', true);
select throws_ok(
  format($i$ select store_calendar_access_token(%L::uuid, %L::uuid, 'c', now(), '1') $i$, :'conn_prod', :'dono'),
  'P0001', 'calendar_environment_mismatch', 'preview não renova token de conexão de production'
);

-- ---------------------------------------------------------------------
-- 10) Auditoria sem conteúdo
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from public.audit_logs
   where workspace_id = :'ws'::uuid and action like 'calendar.effect.%'
     and (metadata::text ~* '(etag|title|summary|Reunião|meet)')),
  0, 'a auditoria dos efeitos não guarda título, etag nem Meet'
);

select * from finish();
rollback;
