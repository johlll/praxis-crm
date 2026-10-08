-- pgTAP — B2: o ambiente precisa ser AUTENTICADO pelo servidor, não só declarado.
--
-- ACHADO DE REVISÃO (PR #24): `private.request_environment()` lia
-- `X-Praxis-Env` direto de `request.headers`. Derivar o cabeçalho de
-- VERCEL_ENV no cliente de servidor não impede que um usuário autenticado
-- chame o PostgREST diretamente e envie o mesmo texto. A primeira versão
-- deste arquivo reproduzia o ataque (JWT `authenticated` de um usuário
-- autorizado à atividade, RPC EXISTENTE de alteração, cabeçalho forjado
-- `production`, sem passar pelo servidor) e FALHAVA: a atividade vinculada a
-- production era alterada.
--
-- Correção: o cabeçalho passou a ser assinado (`ambiente.expira.hmac`) com
-- uma chave por ambiente que o usuário não tem. Aqui: cabeçalho forjado,
-- sem assinatura, com assinatura de outra chave, vencido, com validade
-- absurda e ausente são todos recusados em TODOS os caminhos existentes de
-- edição/exclusão; o caminho legítimo continua funcionando; e as checagens
-- de usuário, papel e alcance seguem valendo. Nenhuma chave real aparece
-- aqui: são valores de teste, só desta transação.

begin;
select plan(23);

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

-- Cabeçalhos montados AQUI, como superusuário: o usuário autenticado não lê
-- a tabela de chaves (provado abaixo) e, no ataque, não os tem.
select pg_temp.hdr('production') as h_prod \gset
select pg_temp.hdr('preview') as h_prev \gset
select pg_temp.hdr('production', 'preview') as h_chave_errada \gset
select pg_temp.hdr('production', null, extract(epoch from now())::bigint - 10) as h_vencido \gset
select pg_temp.hdr('production', null, extract(epoch from now())::bigint + 7200) as h_eterno \gset
select json_build_object('x-praxis-env', 'production.' || (extract(epoch from now())::bigint + 600) || '.' || repeat('0', 64))::text as h_assinatura_falsa \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Teste B2 confiança', 'teste-b2-confianca')).id as ws \gset
reset role;

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'adv', 'lawyer', 'active'),
  (:'ws'::uuid, :'adv2', 'lawyer', 'active'),
  (:'ws'::uuid, :'leitor', 'viewer', 'active');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_contact(:'ws'::uuid, 'pf', 'Cliente B2 confiança', null, null, null)).id as contact \gset
select create_lead(:'ws'::uuid, (:'contact')::uuid, 'Trabalhista', 'Lead B2 confiança', '{}'::text[], 'media', :'adv'::uuid) as lead \gset
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'meeting'::activity_type, p_title := 'Reunião vinculada',
  p_due_date := (current_date + 5), p_due_time := '15:00'::time
) as reuniao \gset
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'task'::activity_type, p_title := 'Tarefa sem vínculo',
  p_due_date := (current_date + 5)
) as tarefa \gset
reset role;

-- Vínculo de production, pelo caminho legítimo de servidor (service_role).
select set_config('request.headers', :'h_prod', true);
select connect_calendar_account(:'ws'::uuid, :'dono'::uuid, 'dono@v.test', array['escopo'], 'refresh', 'access', now(), '1') as conn \gset
select set_calendar_connection_calendar(:'conn'::uuid, :'dono'::uuid, 'cal@x', 'Agenda');
select create_calendar_event_link(:'conn'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'evento-1');

-- ---------------------------------------------------------------------
-- 1) A conta é a mesma no servidor (TypeScript) e no banco
-- ---------------------------------------------------------------------

select is(
  private.environment_signature('production', 4102444800, 'chave-de-teste-b2-0123456789-abcdef'),
  '82f3a8b1e7357ce1e497589faa6cb83466404c45e1143fb84d8316fda4cadcc4',
  'vetor compartilhado com tests/unit/b2-calendar-environment.test.ts: SQL e Node assinam igual'
);

-- ---------------------------------------------------------------------
-- 2) O usuário autenticado não alcança as chaves nem o verificador
-- ---------------------------------------------------------------------

select is(
  has_table_privilege('authenticated', 'public.calendar_environment_keys', 'select')
    or has_table_privilege('anon', 'public.calendar_environment_keys', 'select'),
  false, 'anon/authenticated não têm SELECT na tabela de chaves'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select throws_ok($i$ select * from public.calendar_environment_keys $i$, '42501', null, 'o usuário autenticado não lê as chaves');
select throws_ok($i$ select private.request_environment() $i$, '42501', null, 'o usuário autenticado não chama o verificador de ambiente');
reset role;

-- ---------------------------------------------------------------------
-- 3) ATAQUE: usuário AUTORIZADO à atividade, RPC existente, sem o servidor
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);

select set_config('request.headers', '{"x-praxis-env":"production"}', true);
select throws_ok(
  format($i$ select update_activity(%L::uuid, 0::bigint, p_notes := 'forjado') $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch',
  'cabeçalho "production" FORJADO (sem assinatura) não altera atividade vinculada a production'
);

select set_config('request.headers', :'h_assinatura_falsa', true);
select throws_ok(
  format($i$ select update_activity(%L::uuid, 0::bigint, p_notes := 'forjado') $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch', 'assinatura inventada (formato válido) é recusada'
);

select set_config('request.headers', :'h_chave_errada', true);
select throws_ok(
  format($i$ select update_activity(%L::uuid, 0::bigint, p_notes := 'forjado') $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch', 'afirmar production com a chave de PREVIEW é recusado'
);

select set_config('request.headers', :'h_vencido', true);
select throws_ok(
  format($i$ select update_activity(%L::uuid, 0::bigint, p_notes := 'forjado') $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch', 'cabeçalho com assinatura correta mas VENCIDO é recusado'
);

select set_config('request.headers', :'h_eterno', true);
select throws_ok(
  format($i$ select update_activity(%L::uuid, 0::bigint, p_notes := 'forjado') $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch', 'cabeçalho com validade absurda (> 1 h) é recusado'
);

select set_config('request.headers', '', true);
select throws_ok(
  format($i$ select update_activity(%L::uuid, 0::bigint, p_notes := 'sem cabeçalho') $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch', 'sem cabeçalho a atividade vinculada também é recusada (falha fechada)'
);

-- Os mesmos ataques pelos outros caminhos EXISTENTES de alteração/exclusão.
select set_config('request.headers', '{"x-praxis-env":"production"}', true);
select throws_ok(
  format($i$ select delete_activity(%L::uuid) $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch', 'delete_activity com cabeçalho forjado é recusado'
);
select throws_ok(
  format($i$ select complete_activity(%L::uuid, 0::bigint) $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch', 'complete_activity com cabeçalho forjado é recusado'
);
select throws_ok(
  format($i$ select reschedule_activity(%L::uuid, 0::bigint, current_date + 6, '10:00'::time) $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch', 'reschedule_activity com cabeçalho forjado é recusado'
);
select throws_ok(
  format($i$ select reassign_activity(%L::uuid, 0::bigint, %L::uuid) $i$, :'reuniao', :'adv'),
  'P0001', 'calendar_environment_mismatch', 'reassign_activity com cabeçalho forjado é recusado'
);

-- Cabeçalho LEGÍTIMO, mas de outro ambiente (o acidente real do banco
-- compartilhado): continua recusado.
select set_config('request.headers', :'h_prev', true);
select throws_ok(
  format($i$ select update_activity(%L::uuid, 0::bigint, p_notes := 'preview') $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch', 'preview legítimo não altera atividade vinculada a production'
);
select throws_ok(
  format($i$ select delete_activity(%L::uuid) $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch', 'preview legítimo não exclui atividade vinculada a production'
);
reset role;

select is(
  (select notes from public.activities where id = (:'reuniao')::uuid),
  null, 'depois de todas as recusas a atividade segue exatamente como estava'
);

-- ---------------------------------------------------------------------
-- 4) Caminho legítimo e checagens de usuário, papel e alcance preservadas
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'leitor', 'role', 'authenticated')::text, true);
select set_config('request.headers', :'h_prod', true);
select throws_ok(
  format($i$ select update_activity(%L::uuid, 0::bigint, p_notes := 'leitor') $i$, :'reuniao'),
  'P0001', 'insufficient_permission', 'com ambiente legítimo, viewer continua sem permissão de editar'
);

select set_config('request.jwt.claims', json_build_object('sub', :'adv2', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select update_activity(%L::uuid, 0::bigint, p_notes := 'fora do alcance') $i$, :'reuniao'),
  'P0001', 'activity_not_found', 'com ambiente legítimo, advogado sem alcance ao lead continua sem acesso'
);

select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select lives_ok(
  format($i$ select update_activity(%L::uuid, 0::bigint, p_notes := 'ok legítimo') $i$, :'reuniao'),
  'caminho legítimo: servidor do ambiente dono do vínculo altera a atividade vinculada'
);
select lives_ok(
  format($i$ select complete_activity(%L::uuid, 1::bigint) $i$, :'reuniao'),
  'caminho legítimo também conclui a atividade vinculada'
);
reset role;

select is(
  (select notes from public.activities where id = (:'reuniao')::uuid),
  'ok legítimo', 'a alteração legítima valeu e nenhuma das forjadas'
);

-- Atividade SEM vínculo segue editável sem cabeçalho nenhum.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select set_config('request.headers', '', true);
select lives_ok(
  format($i$ select update_activity(%L::uuid, 0::bigint, p_notes := 'tarefa livre') $i$, :'tarefa'),
  'atividade sem vínculo continua editável, sem cabeçalho'
);
reset role;

select * from finish();
rollback;
