-- pgTAP — B2: o ambiente precisa ser AUTENTICADO pelo servidor, não só declarado.
--
-- REPRODUÇÃO (achado de revisão da PR #24): `private.request_environment()`
-- lia `X-Praxis-Env` direto de `request.headers`. Derivar o cabeçalho de
-- VERCEL_ENV no cliente de servidor não impede que um usuário autenticado
-- chame o PostgREST diretamente e envie o mesmo cabeçalho. Este arquivo
-- reproduz exatamente isso: JWT `authenticated` de um usuário autorizado à
-- atividade, chamando uma RPC EXISTENTE de alteração com um cabeçalho
-- forjado `production`, sem passar pelo servidor do CRM.
--
-- Contra o código ANTES da correção a asserção abaixo falha (a atividade
-- vinculada a production é alterada).

begin;
select plan(1);

\set dono '20000000-0000-0000-0000-000000000001'

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Teste B2 confiança', 'teste-b2-confianca')).id as ws \gset
select (create_contact(:'ws'::uuid, 'pf', 'Cliente B2 confiança', null, null, null)).id as contact \gset
select create_lead(:'ws'::uuid, (:'contact')::uuid, 'Trabalhista', 'Lead B2 confiança', '{}'::text[], 'media', null) as lead \gset
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'meeting'::activity_type, p_title := 'Reunião vinculada',
  p_due_date := (current_date + 5), p_due_time := '15:00'::time
) as reuniao \gset
reset role;

-- Vínculo de production, criado pelo caminho de servidor (service_role).
select set_config('request.headers', '{"x-praxis-env":"production"}', true);
select connect_calendar_account(:'ws'::uuid, :'dono'::uuid, 'dono@v.test', array['escopo'], 'refresh', 'access', now(), '1') as conn \gset
select set_calendar_connection_calendar(:'conn'::uuid, :'dono'::uuid, 'cal@x', 'Agenda');
select create_calendar_event_link(:'conn'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'evento-1');

-- ATAQUE: o usuário autorizado, sem passar pelo servidor do CRM, chama a
-- RPC existente com o cabeçalho declarando production.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select set_config('request.headers', '{"x-praxis-env":"production"}', true);
select throws_ok(
  format($i$ select update_activity(%L::uuid, 0::bigint, p_notes := 'alterado por cabeçalho forjado') $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch',
  'cabeçalho X-Praxis-Env FORJADO por um usuário não altera atividade vinculada a production'
);
reset role;

select * from finish();
rollback;
