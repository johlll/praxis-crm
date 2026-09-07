-- pgTAP — isolamento entre workspaces (o critério de aceite central da A2).
--
-- Roda contra o banco local subido por `supabase start`/CI, já com o seed
-- fictício de supabase/seed.sql aplicado. `set local role`/`request.jwt.
-- claims` simulam a sessão de cada usuário exatamente como o PostgREST
-- monta a partir do JWT — é a mesma checagem que vale em produção.

begin;
select plan(24);

-- Atalhos para os UUIDs fixos do seed.
\set ana        '20000000-0000-0000-0000-000000000001'
\set bruno      '20000000-0000-0000-0000-000000000002'
\set carla      '20000000-0000-0000-0000-000000000003'
\set daniel     '20000000-0000-0000-0000-000000000004'
\set ws_um      '10000000-0000-0000-0000-000000000001'
\set ws_dois    '10000000-0000-0000-0000-000000000002'

-- -----------------------------------------------------------------
-- 1) Sem sessão (role anon / sem claims): nada é visível.
-- -----------------------------------------------------------------
-- Nenhuma policy desta migration é `to anon` — com FORCE ROW LEVEL
-- SECURITY, o papel anon já cai no default-deny sem precisar limpar
-- request.jwt.claims (que nem chegou a ser setado nesta transação).
set local role anon;

select is(
  (select count(*) from public.workspaces)::int, 0,
  'anon não enxerga nenhum workspace'
);
select is(
  (select count(*) from public.memberships)::int, 0,
  'anon não enxerga nenhuma membership'
);

-- -----------------------------------------------------------------
-- 2) Ana (owner só do Escritório Um) só vê o próprio workspace.
-- -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

select is(
  (select count(*) from public.workspaces)::int, 1,
  'Ana enxerga exatamente 1 workspace'
);
select ok(
  exists(select 1 from public.workspaces where id = :'ws_um'::uuid),
  'Ana enxerga o Escritório Um'
);
select ok(
  not exists(select 1 from public.workspaces where id = :'ws_dois'::uuid),
  'Ana NÃO enxerga o Escritório Dois'
);
select is(
  (select count(*) from public.memberships where workspace_id = :'ws_dois'::uuid)::int, 0,
  'Ana não lê memberships do Escritório Dois — a policy de memberships filtra por workspace_id in auth_workspace_ids()'
);

-- -----------------------------------------------------------------
-- 3) Bruno (owner só do Escritório Dois) é o espelho de Ana — prova que
--    não é coincidência de dados, é a policy filtrando de verdade.
-- -----------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);

select is(
  (select count(*) from public.workspaces)::int, 1,
  'Bruno enxerga exatamente 1 workspace'
);
select ok(
  exists(select 1 from public.workspaces where id = :'ws_dois'::uuid),
  'Bruno enxerga o Escritório Dois'
);
select ok(
  not exists(select 1 from public.workspaces where id = :'ws_um'::uuid),
  'Bruno NÃO enxerga o Escritório Um'
);

-- -----------------------------------------------------------------
-- 4) Carla é membro dos dois — deve ver ambos, com os papéis corretos.
-- -----------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);

select is(
  (select count(*) from public.workspaces)::int, 2,
  'Carla enxerga os 2 workspaces dos quais é membro'
);
select is(
  (select role from public.memberships where workspace_id = :'ws_um'::uuid and user_id = :'carla'::uuid)::text,
  'lawyer',
  'Carla é lawyer no Escritório Um'
);
select is(
  (select role from public.memberships where workspace_id = :'ws_dois'::uuid and user_id = :'carla'::uuid)::text,
  'sales',
  'Carla é sales no Escritório Dois'
);

-- -----------------------------------------------------------------
-- 5) Daniel não tem membership nenhuma — não vê workspace algum. É o caso
--    "usuário sem membership não acessa" no nível do banco (a rota em si é
--    testada em e2e, mas a garantia de dado começa aqui).
-- -----------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'daniel', 'role', 'authenticated')::text, true);

select is(
  (select count(*) from public.workspaces)::int, 0,
  'Daniel (sem membership) não enxerga nenhum workspace'
);
select is(
  (select count(*) from public.memberships)::int, 0,
  'Daniel (sem membership) não enxerga nenhuma membership'
);

-- -----------------------------------------------------------------
-- 6) "workspace adulterado" simulado: mesmo pedindo explicitamente pelo id
--    do Escritório Dois, Daniel/Ana continuam sem ver nada — prova que a
--    policy não confia em nada que "pareça" ter vindo do cliente, só na
--    membership real.
-- -----------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select is(
  (select count(*) from public.workspaces where id = :'ws_dois'::uuid)::int, 0,
  'Ana pedindo direto pelo id do Escritório Dois ainda recebe zero linhas'
);

-- -----------------------------------------------------------------
-- 7) INSERT/UPDATE/DELETE direto do cliente em workspaces/memberships são
--    negados — mesmo para o próprio owner. Só as funções RPC escrevem.
-- -----------------------------------------------------------------
select throws_ok(
  $i$ insert into public.workspaces (name, slug) values ('Invasão', 'invasao') $i$,
  '42501',
  null,
  'INSERT direto em workspaces é negado mesmo para um owner autenticado'
);

select throws_ok(
  format(
    $i$ insert into public.memberships (workspace_id, user_id, role, status) values (%L, %L, 'owner', 'active') $i$,
    :'ws_um', :'daniel'
  ),
  '42501',
  null,
  'Ana não consegue se autoconceder — nem conceder a outra pessoa — membership por INSERT direto'
);

select throws_ok(
  format($i$ update public.memberships set role = 'owner' where workspace_id = %L and user_id = %L $i$, :'ws_um', :'carla'),
  '42501',
  null,
  'UPDATE direto de role em memberships é negado — só update_membership_role()'
);

select throws_ok(
  format($i$ delete from public.memberships where workspace_id = %L and user_id = %L $i$, :'ws_um', :'carla'),
  '42501',
  null,
  'DELETE direto em memberships é negado — só remove_membership()'
);

-- -----------------------------------------------------------------
-- 8) audit_logs: só owner/admin do workspace enxergam, e nunca por INSERT
--    direto do cliente (as funções RPC escrevem sozinhas).
-- -----------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select is(
  (select count(*) from public.audit_logs where workspace_id = :'ws_um'::uuid)::int, 0,
  'Carla (lawyer, não admin/owner) não enxerga audit_logs do Escritório Um mesmo sendo membro'
);

select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type) values (%L, %L, 'forjado', 'x') $i$,
    :'ws_um', :'ana'
  ),
  '42501',
  null,
  'INSERT direto em audit_logs é negado mesmo para o owner — só as funções RPC audita'
);

-- -----------------------------------------------------------------
-- 9) users: perfil visível só para si mesmo ou quem compartilha workspace.
-- -----------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select ok(
  exists(select 1 from public.users where id = :'carla'::uuid),
  'Ana vê o perfil de Carla — compartilham o Escritório Um'
);
select ok(
  not exists(select 1 from public.users where id = :'bruno'::uuid),
  'Ana NÃO vê o perfil de Bruno — não compartilham workspace nenhum'
);

select set_config('request.jwt.claims', json_build_object('sub', :'daniel', 'role', 'authenticated')::text, true);
select is(
  (select count(*) from public.users where id <> :'daniel'::uuid)::int, 0,
  'Daniel (sem membership em lugar nenhum) só vê o próprio perfil'
);

select * from finish();
rollback;
