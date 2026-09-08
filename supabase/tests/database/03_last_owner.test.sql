-- pgTAP — o último owner de um workspace nunca pode ser removido nem
-- rebaixado, mas deixa de ser o caso assim que existe um segundo owner.

begin;
select plan(7);

\set ana    '20000000-0000-0000-0000-000000000001'
\set carla  '20000000-0000-0000-0000-000000000003'
\set ws_um  '10000000-0000-0000-0000-000000000001'

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

-- -----------------------------------------------------------------
-- 1) Ana é a única owner do Escritório Um — não pode rebaixar a si mesma.
-- -----------------------------------------------------------------
select throws_ok(
  format(
    $i$ select public.update_membership_role(
          (select id from public.memberships where workspace_id = %L and user_id = %L),
          'admin'
        ) $i$,
    :'ws_um', :'ana'
  ),
  'P0001',
  'cannot_demote_last_owner',
  'Ana não consegue rebaixar a si mesma — é a única owner do Escritório Um'
);

-- -----------------------------------------------------------------
-- 2) Nem remover.
-- -----------------------------------------------------------------
select throws_ok(
  format(
    $i$ select public.remove_membership(
          (select id from public.memberships where workspace_id = %L and user_id = %L)
        ) $i$,
    :'ws_um', :'ana'
  ),
  'P0001',
  'cannot_remove_last_owner',
  'Ana não consegue se auto-remover — é a única owner do Escritório Um'
);

-- -----------------------------------------------------------------
-- 3) Um admin (não owner) não pode promover ninguém a owner — só quem já
--    é owner concede o papel de owner. Carla vira admin só para este
--    teste, depois volta a lawyer para não afetar o passo seguinte.
-- -----------------------------------------------------------------
set local role postgres;
update public.memberships set role = 'admin' where workspace_id = :'ws_um'::uuid and user_id = :'carla'::uuid;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);

select throws_ok(
  format(
    $i$ select public.update_membership_role(
          (select id from public.memberships where workspace_id = %L and user_id = %L),
          'owner'
        ) $i$,
    :'ws_um', :'carla'
  ),
  'P0001',
  'insufficient_permission',
  'Carla, como admin (não owner), não consegue promover a si mesma a owner'
);

set local role postgres;
update public.memberships set role = 'lawyer' where workspace_id = :'ws_um'::uuid and user_id = :'carla'::uuid;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

-- -----------------------------------------------------------------
-- 4) Promove Carla a owner também — agora há dois. (Ana, que É owner,
--    pode conceder o papel de owner — diferente do passo 3.)
-- -----------------------------------------------------------------
select lives_ok(
  format(
    $i$ select public.update_membership_role(
          (select id from public.memberships where workspace_id = %L and user_id = %L),
          'owner'
        ) $i$,
    :'ws_um', :'carla'
  ),
  'Ana promove Carla a owner — agora existem dois owners no Escritório Um'
);

-- -----------------------------------------------------------------
-- 5) Com dois owners, rebaixar um deles funciona.
-- -----------------------------------------------------------------
select lives_ok(
  format(
    $i$ select public.update_membership_role(
          (select id from public.memberships where workspace_id = %L and user_id = %L),
          'lawyer'
        ) $i$,
    :'ws_um', :'carla'
  ),
  'Com dois owners, rebaixar um deles de volta funciona normalmente'
);

-- -----------------------------------------------------------------
-- 6) De volta a um único owner (Ana) — remove volta a ser bloqueado.
-- -----------------------------------------------------------------
select throws_ok(
  format(
    $i$ select public.remove_membership(
          (select id from public.memberships where workspace_id = %L and user_id = %L)
        ) $i$,
    :'ws_um', :'ana'
  ),
  'P0001',
  'cannot_remove_last_owner',
  'Depois de Carla voltar a lawyer, Ana (única owner de novo) continua protegida'
);

-- -----------------------------------------------------------------
-- 7) A proteção não se aplica a quem NÃO é owner — remover a Carla
--    (lawyer) funciona livremente.
-- -----------------------------------------------------------------
select lives_ok(
  format(
    $i$ select public.remove_membership(
          (select id from public.memberships where workspace_id = %L and user_id = %L)
        ) $i$,
    :'ws_um', :'carla'
  ),
  'Remover um membro que não é owner (Carla, lawyer) funciona sem restrição'
);

select * from finish();
rollback;
