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
  email_change, email_change_token_new, email_change_token_current,
  phone_change, phone_change_token, reauthentication_token,
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
    '', '', '', '', '', '',
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
    '', '', '', '', '', '',
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
    '', '', '', '', '', '',
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
    '', '', '', '', '', '',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Daniel Sem Workspace (seed)"}',
    false, false, false, now(), now()
  );

-- ---------------------------------------------------------------------
-- auth.identities — sem esta linha por usuário, o login por senha falha
-- no GoTrue com "Database error querying schema": a consulta de login
-- espera uma identidade do provider 'email' vinculada ao usuário, não
-- só a linha em auth.users. `provider_id` é o próprio id do usuário,
-- convenção do GoTrue para o provider 'email'.
-- ---------------------------------------------------------------------

insert into auth.identities (
  provider_id, user_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) values
  (
    '20000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    jsonb_build_object(
      'sub', '20000000-0000-0000-0000-000000000001',
      'email', 'owner-a.seed@praxis.test',
      'email_verified', true
    ),
    'email', now(), now(), now()
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000002',
    jsonb_build_object(
      'sub', '20000000-0000-0000-0000-000000000002',
      'email', 'owner-b.seed@praxis.test',
      'email_verified', true
    ),
    'email', now(), now(), now()
  ),
  (
    '20000000-0000-0000-0000-000000000003',
    '20000000-0000-0000-0000-000000000003',
    jsonb_build_object(
      'sub', '20000000-0000-0000-0000-000000000003',
      'email', 'compartilhado.seed@praxis.test',
      'email_verified', true
    ),
    'email', now(), now(), now()
  ),
  (
    '20000000-0000-0000-0000-000000000004',
    '20000000-0000-0000-0000-000000000004',
    jsonb_build_object(
      'sub', '20000000-0000-0000-0000-000000000004',
      'email', 'sem-membership.seed@praxis.test',
      'email_verified', true
    ),
    'email', now(), now(), now()
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

-- ---------------------------------------------------------------------
-- A3 — contatos fictícios, demonstrando cada nível de duplicidade sem
-- nenhuma mesclagem automática (ver docs/decisoes/a3-duplicidades.md).
--
-- INSERT direto (não via create_contact()): o seed roda como o papel que
-- aplica as migrations, sem sessão/auth.uid() de verdade para a função
-- SECURITY DEFINER usar — por isso os duplicate_candidates também são
-- inseridos diretamente aqui, reproduzindo à mão o que a função de
-- detecção geraria (mesmo formato de sinais/tier/priority), só para o
-- seed já nascer com a fila de revisão populada para demonstração.
--
-- CPF cifrado com a MESMA chave de teste fixa que
-- .github/workflows/ci.yml declara em CONTACTS_KEY_VERSIONS — nunca uma
-- chave real, nunca um CPF real. Regenerar com
-- `node scripts/gen-seed-contact-secrets.mjs` se o formato de cifra mudar.
-- ---------------------------------------------------------------------

insert into public.contacts (id, workspace_id, type, name, city, uf, preferred_channel, created_by) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'pf', 'Carla Ferreira', 'São Paulo', 'SP', 'whatsapp', '20000000-0000-0000-0000-000000000001'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'pf', 'Carla Ferreira Advocacia', 'São Paulo', 'SP', 'email', '20000000-0000-0000-0000-000000000001'),
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'pf', 'Roberto Silva', null, null, 'whatsapp', '20000000-0000-0000-0000-000000000001'),
  ('40000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'pf', 'Roberto Silva Filho', null, null, 'whatsapp', '20000000-0000-0000-0000-000000000001'),
  ('40000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'pf', 'Mariana Costa Lima', 'Curitiba', 'PR', null, '20000000-0000-0000-0000-000000000001'),
  ('40000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'pf', 'Mariana Costa Lima Souza', 'Curitiba', 'PR', null, '20000000-0000-0000-0000-000000000001'),
  ('40000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000002', 'pf', 'Cliente do Escritório Dois', 'Rio de Janeiro', 'RJ', 'telefone', '20000000-0000-0000-0000-000000000002');

insert into public.contact_phones (workspace_id, contact_id, value_normalized, is_primary) values
  ('10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '+5511999990001', true),
  ('10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003', '+5511988887777', true),
  ('10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000004', '+5511988887777', true);

insert into public.contact_emails (workspace_id, contact_id, value_normalized, is_primary) values
  ('10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'carla.ferreira@exemplo.test', true),
  ('10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', 'contato@carlaferreiraadv.test', true);

-- CPF fictício "222.222.222-22" — mesmo valor nos dois contatos do
-- workspace 1 (candidato forte) e também no contato do workspace 2 (prova
-- de isolamento: blind_index diferente, sem correlação possível).
insert into public.contact_sensitive (contact_id, workspace_id, cpf_cnpj_ciphertext, cpf_cnpj_blind_index, key_version) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '\xb5efed95fbc07f376b183c4637644d8c02d4cb47dcb440ebcc78aff45b51a5264c420e20a9c43b', '\x81d397237f442d17cf13d282ce408243b5a54c68e83e9e64d6d0d1352d331e0f', '1'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '\xe57f700c28718d41958bde1fb794ed7ec49b0754f7973619e9465c19b094e8cd8a31e7ff0a504c', '\x81d397237f442d17cf13d282ce408243b5a54c68e83e9e64d6d0d1352d331e0f', '1'),
  ('40000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000002', '\x67062489b413f0af1ee5136eda800b44a9caa5a747494be215725b95c2790e9e31fcacd18a4f0e', '\xc78f719d4f0e5f202cf56a3fd906bc21d4c149019d2e5bae913f5bcfc84dd7da', '1');

insert into public.duplicate_candidates (workspace_id, contact_a_id, contact_b_id, signals, tier, priority) values
  (
    '10000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002',
    '[{"type":"cpf_exact"}]'::jsonb, 'strong', 101
  ),
  (
    '10000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000004',
    '[{"type":"phone_exact"}]'::jsonb, 'review', 51
  ),
  (
    '10000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000005', '40000000-0000-0000-0000-000000000006',
    '[{"type":"name_city_similarity","score":0.8,"city":"Curitiba","uf":"PR"}]'::jsonb, 'low', 11
  );
