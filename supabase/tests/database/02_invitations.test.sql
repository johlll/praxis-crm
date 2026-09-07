-- pgTAP — convites: expiração, cancelamento, reuso e o papel vindo sempre
-- do convite (nunca do convidado).

begin;
select plan(14);

\set ana        '20000000-0000-0000-0000-000000000001'
\set carla      '20000000-0000-0000-0000-000000000003'
\set daniel     '20000000-0000-0000-0000-000000000004'
\set ws_um      '10000000-0000-0000-0000-000000000001'

set local role authenticated;

-- -----------------------------------------------------------------
-- 1) Convite expirado (seed: expires_at no passado, status ainda
--    'pending') — accept deve falhar, e a linha deve virar 'expired'.
-- -----------------------------------------------------------------
-- Testamos a expiração isolada com um convite fabricado aqui mesmo para o
-- e-mail de Carla (que já existe em auth.users pelo seed) — o
-- seed-token-expirado original serve para o teste de leitura/preview, este
-- é para o accept.
set local role postgres;
insert into public.workspace_invitations (
  workspace_id, email, role, status, token_hash, invited_by, expires_at
) values (
  :'ws_um'::uuid, 'compartilhado.seed@praxis.test', 'viewer', 'pending',
  encode(extensions.digest('token-teste-expirado', 'sha256'), 'hex'),
  :'ana'::uuid, now() - interval '1 hour'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);

select throws_ok(
  $i$ select public.accept_workspace_invitation('token-teste-expirado') $i$,
  'P0001',
  'invitation_expired',
  'Aceitar convite expirado falha com invitation_expired'
);

-- O UPDATE que a função tentava fazer antes de levantar a exceção seria
-- desfeito junto com ela (Postgres não tem sub-transação implícita dentro
-- de uma função) — por isso a função nem tenta mais, e o status
-- corretamente CONTINUA 'pending' aqui. "Expirado" é derivado na leitura
-- (ver preview_workspace_invitation), nunca persistido por uma tentativa
-- de aceite que falhou.
set local role postgres;
select is(
  (select status from public.workspace_invitations where token_hash = encode(extensions.digest('token-teste-expirado', 'sha256'), 'hex'))::text,
  'pending',
  'O convite expirado continua com status=pending — quem persiste isso é um cron futuro, não o accept que falhou'
);

-- -----------------------------------------------------------------
-- 2) Convite cancelado (seed: id 30000000-...-003, status='cancelled').
-- -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'daniel', 'role', 'authenticated')::text, true);

select throws_ok(
  $i$ select public.accept_workspace_invitation('seed-token-cancelado') $i$,
  'P0001',
  'invitation_not_pending',
  'Aceitar convite cancelado falha com invitation_not_pending'
);

-- -----------------------------------------------------------------
-- 3) Convite reutilizado: aceitar um convite pendente de verdade, depois
--    tentar de novo — a segunda tentativa tem que falhar. Usa Daniel (já
--    existe em auth.users pelo seed) e um convite fresco criado aqui —
--    não dá para reaproveitar o seed-token-pendente porque ele mira num
--    e-mail sem auth.users correspondente, e criar um auth.users direto
--    no teste fugiria do que o seed já garante.
-- -----------------------------------------------------------------
set local role postgres;
insert into public.workspace_invitations (
  workspace_id, email, role, status, token_hash, invited_by, expires_at
) values (
  :'ws_um'::uuid, 'sem-membership.seed@praxis.test', 'viewer', 'pending',
  encode(extensions.digest('token-teste-reuso', 'sha256'), 'hex'),
  :'ana'::uuid, now() + interval '7 days'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'daniel', 'role', 'authenticated')::text, true);

select lives_ok(
  $i$ select public.accept_workspace_invitation('token-teste-reuso') $i$,
  'Primeira tentativa de aceitar o convite pendente funciona'
);

select throws_ok(
  $i$ select public.accept_workspace_invitation('token-teste-reuso') $i$,
  'P0001',
  'invitation_not_pending',
  'Segunda tentativa (reuso) do mesmo token falha com invitation_not_pending'
);

set local role postgres;
select is(
  (select role from public.memberships where workspace_id = :'ws_um'::uuid and user_id = :'daniel'::uuid)::text,
  'viewer',
  'O papel da nova membership é exatamente o do convite (viewer) — não o que o convidado poderia ter pedido'
);

-- -----------------------------------------------------------------
-- 4) accept_workspace_invitation não tem parâmetro de papel — prova
--    estrutural de que o convidado não pode pedir um papel diferente.
-- -----------------------------------------------------------------
select is(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'accept_workspace_invitation'
      and p.pronargs = 1
  )::int,
  1,
  'accept_workspace_invitation aceita só o token — nenhum parâmetro de papel para o convidado manipular'
);

-- -----------------------------------------------------------------
-- 5) E-mail não corresponde ao convite: falha.
-- -----------------------------------------------------------------
set local role postgres;
insert into public.workspace_invitations (
  workspace_id, email, role, status, token_hash, invited_by, expires_at
) values (
  :'ws_um'::uuid, 'outro-email@praxis.test', 'viewer', 'pending',
  encode(extensions.digest('token-teste-email-errado', 'sha256'), 'hex'),
  :'ana'::uuid, now() + interval '7 days'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'daniel', 'role', 'authenticated')::text, true);

select throws_ok(
  $i$ select public.accept_workspace_invitation('token-teste-email-errado') $i$,
  'P0001',
  'invitation_email_mismatch',
  'Aceitar convite com e-mail de sessão diferente do e-mail convidado falha'
);

-- -----------------------------------------------------------------
-- 6) Convite inexistente / token errado.
-- -----------------------------------------------------------------
select throws_ok(
  $i$ select public.accept_workspace_invitation('token-que-nao-existe') $i$,
  'P0001',
  'invitation_not_found',
  'Token que não bate com hash nenhum falha com invitation_not_found'
);

-- -----------------------------------------------------------------
-- 7) Criar convite: só owner/admin. Carla é lawyer (nem owner nem admin).
-- -----------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);

select throws_ok(
  format($i$ select public.create_workspace_invitation(%L, 'novo@praxis.test', 'viewer') $i$, :'ws_um'),
  'P0001',
  'insufficient_permission',
  'Carla (lawyer) não pode criar convite — só owner/admin'
);

select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

select lives_ok(
  format($i$ select public.create_workspace_invitation(%L, 'valido@praxis.test', 'viewer') $i$, :'ws_um'),
  'Ana (owner) consegue criar convite'
);

-- -----------------------------------------------------------------
-- 8) Admin não pode convidar outro owner — só owner concede owner.
--    Carla vira admin do Escritório Um só para este teste (direto via
--    postgres, sem passar pela RPC — o que está sob teste é a checagem
--    dentro de create_workspace_invitation, não update_membership_role).
-- -----------------------------------------------------------------
set local role postgres;
update public.memberships set role = 'admin' where workspace_id = :'ws_um'::uuid and user_id = :'carla'::uuid;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);

select throws_ok(
  format($i$ select public.create_workspace_invitation(%L, 'seria-owner@praxis.test', 'owner') $i$, :'ws_um'),
  'P0001',
  'insufficient_permission',
  'Carla, agora admin, não pode convidar alguém como owner — só um owner concede owner'
);

select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

select lives_ok(
  format($i$ select public.create_workspace_invitation(%L, 'novo-owner@praxis.test', 'owner') $i$, :'ws_um'),
  'Ana (owner de verdade) consegue convidar alguém como owner'
);

set local role postgres;
update public.memberships set role = 'lawyer' where workspace_id = :'ws_um'::uuid and user_id = :'carla'::uuid;
set local role authenticated;

-- -----------------------------------------------------------------
-- 9) Cancelar convite: só owner/admin, e só se ainda pendente.
-- -----------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);

select throws_ok(
  $i$ select public.cancel_workspace_invitation('30000000-0000-0000-0000-000000000001') $i$,
  'P0001',
  'insufficient_permission',
  'Carla (lawyer) não pode cancelar convite alheio'
);

select * from finish();
rollback;
