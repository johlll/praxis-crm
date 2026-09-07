-- Seed exclusivamente fictício, para desenvolvimento local e para os
-- testes de isolamento (pgTAP) e e2e (Playwright) — NUNCA dado real.
-- Aplicado por `supabase db reset` (local/CI), nunca contra o projeto
-- hospedado de desenvolvimento nem, muito menos, produção.
--
-- UUIDs fixos de propósito (prefixo 1000... para workspace, 2000... para
-- usuário) — os testes referenciam estes valores diretamente.
--
-- Senha de todos os usuários fictícios: "praxis-seed-nao-e-senha-real".
-- Gerada com pgcrypto (crypt/gen_salt) em vez de um hash fabricado à mão,
-- para ser um bcrypt de verdade que o GoTrue aceita — não um valor
-- inventado (nada aqui é credencial real; é justamente o oposto: dado
-- fictício reproduzível para o CI logar como esses usuários).

-- ---------------------------------------------------------------------
-- auth.users — a trigger private.handle_new_auth_user() cria a linha
-- correspondente em public.users sozinha (lê raw_user_meta_data).
-- ---------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin, is_sso_user, is_anonymous,
  created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000001',
    'authenticated', 'authenticated',
    'owner-a.seed@praxis.test',
    extensions.crypt('praxis-seed-nao-e-senha-real', extensions.gen_salt('bf')),
    now(), '', '',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Ana Owner (seed)"}',
    false, false, false, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000002',
    'authenticated', 'authenticated',
    'owner-b.seed@praxis.test',
    extensions.crypt('praxis-seed-nao-e-senha-real', extensions.gen_salt('bf')),
    now(), '', '',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Bruno Owner (seed)"}',
    false, false, false, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000003',
    'authenticated', 'authenticated',
    'compartilhado.seed@praxis.test',
    extensions.crypt('praxis-seed-nao-e-senha-real', extensions.gen_salt('bf')),
    now(), '', '',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Carla Compartilhada (seed)"}',
    false, false, false, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000004',
    'authenticated', 'authenticated',
    'sem-membership.seed@praxis.test',
    extensions.crypt('praxis-seed-nao-e-senha-real', extensions.gen_salt('bf')),
    now(), '', '',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Daniel Sem Workspace (seed)"}',
    false, false, false, now(), now()
  );

-- ---------------------------------------------------------------------
-- workspaces — inseridos diretamente (não via RPC): o seed roda como
-- `postgres`, que tem bypass de RLS; created_by seria sobrescrito pela
-- trigger de qualquer forma.
-- ---------------------------------------------------------------------

insert into public.workspaces (id, name, slug, created_by) values
  (
    '10000000-0000-0000-0000-000000000001',
    'Escritório Um (seed)',
    'escritorio-um-seed',
    '20000000-0000-0000-0000-000000000001'
  ),
  (
    '10000000-0000-0000-0000-000000000002',
    'Escritório Dois (seed)',
    'escritorio-dois-seed',
    '20000000-0000-0000-0000-000000000002'
  );

-- ---------------------------------------------------------------------
-- memberships
--   Ana   -> owner  no Escritório Um
--   Bruno -> owner  no Escritório Dois
--   Carla -> lawyer no Escritório Um, sales no Escritório Dois (o "membro
--            de ambos" pedido pela seção 9)
--   Daniel -> nenhuma (o "usuário sem membership")
-- ---------------------------------------------------------------------

insert into public.memberships (workspace_id, user_id, role, status) values
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'owner', 'active'),
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'owner', 'active'),
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'lawyer', 'active'),
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000003', 'sales', 'active');

-- ---------------------------------------------------------------------
-- workspace_invitations — os quatro estados pedidos pela seção 9.
-- token_hash fictício (hash de um token que não corresponde a nada real;
-- os testes de aceite geram e usam token próprio via
-- create_workspace_invitation()/accept_workspace_invitation()).
-- ---------------------------------------------------------------------

insert into public.workspace_invitations (
  id, workspace_id, email, role, status, token_hash, invited_by,
  expires_at, accepted_at, accepted_by, cancelled_at
) values
  (
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'convite.pendente.seed@praxis.test',
    'viewer',
    'pending',
    encode(extensions.digest('seed-token-pendente', 'sha256'), 'hex'),
    '20000000-0000-0000-0000-000000000001',
    now() + interval '7 days',
    null, null, null
  ),
  (
    '30000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001',
    'convite.expirado.seed@praxis.test',
    'viewer',
    'pending',
    encode(extensions.digest('seed-token-expirado', 'sha256'), 'hex'),
    '20000000-0000-0000-0000-000000000001',
    now() - interval '1 day',
    null, null, null
  ),
  (
    '30000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000001',
    'convite.cancelado.seed@praxis.test',
    'sales',
    'cancelled',
    encode(extensions.digest('seed-token-cancelado', 'sha256'), 'hex'),
    '20000000-0000-0000-0000-000000000001',
    now() + interval '7 days',
    null, null, now()
  ),
  (
    '30000000-0000-0000-0000-000000000004',
    '10000000-0000-0000-0000-000000000001',
    'compartilhado.seed@praxis.test',
    'lawyer',
    'accepted',
    encode(extensions.digest('seed-token-aceito', 'sha256'), 'hex'),
    '20000000-0000-0000-0000-000000000001',
    now() + interval '7 days',
    now() - interval '1 day',
    '20000000-0000-0000-0000-000000000003',
    null
  );
