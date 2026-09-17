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
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000005',
    'authenticated', 'authenticated',
    'viewer.seed@praxis.test',
    extensions.crypt('praxis-seed-nao-e-senha-real', extensions.gen_salt('bf')),
    now(), '', '',
    '', '', '', '', '', '',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Elisa Viewer (seed)"}',
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
  ),
  (
    '20000000-0000-0000-0000-000000000005',
    '20000000-0000-0000-0000-000000000005',
    jsonb_build_object(
      'sub', '20000000-0000-0000-0000-000000000005',
      'email', 'viewer.seed@praxis.test',
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
--            de ambos" pedido pela seção 9; sales também serve pro e2e da
--            A3 provar que atendimento precisa de motivo pra revelar CPF)
--   Daniel -> nenhuma (o "usuário sem membership")
--   Elisa  -> viewer no Escritório Um (e2e da A3: viewer nunca revela CPF,
--             nenhum dos outros 4 usuários tinha esse papel disponível)
-- ---------------------------------------------------------------------

insert into public.memberships (workspace_id, user_id, role, status) values
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'owner', 'active'),
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'owner', 'active'),
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'lawyer', 'active'),
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000003', 'sales', 'active'),
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', 'viewer', 'active');

-- ---------------------------------------------------------------------
-- pipelines (A5) — os workspaces do seed são inseridos diretamente
-- acima, não via create_workspace_with_owner(), então o pipeline
-- padrão (que essa função cria) e o backfill da migration da A5 (que
-- só alcança workspaces que já existiam ANTES da migration rodar)
-- nunca chegam até eles. Replica aqui a mesma estrutura: um pipeline
-- "Comercial" com as 8 etapas do protótipo aprovado, por workspace.
-- ---------------------------------------------------------------------

insert into public.pipelines (id, workspace_id, name, is_default, created_by) values
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Comercial', true, '20000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Comercial', true, '20000000-0000-0000-0000-000000000002');

insert into public.pipeline_stages (workspace_id, pipeline_id, name, position)
select w.workspace_id, w.pipeline_id, s.name, s.position
from (values
  ('10000000-0000-0000-0000-000000000001'::uuid, '50000000-0000-0000-0000-000000000001'::uuid),
  ('10000000-0000-0000-0000-000000000002'::uuid, '50000000-0000-0000-0000-000000000002'::uuid)
) as w(workspace_id, pipeline_id)
cross join (values
  ('Fazer primeiro contato', 0),
  ('Qualificar oportunidade', 1),
  ('Verificar aderência e conflito', 2),
  ('Agendar consulta', 3),
  ('Realizar consulta', 4),
  ('Enviar proposta', 5),
  ('Negociar honorários', 6),
  ('Aguardar assinatura', 7)
) as s(name, position);

insert into public.lost_reasons (workspace_id, label, position)
select w.workspace_id, r.label, r.position
from (values
  ('10000000-0000-0000-0000-000000000001'::uuid),
  ('10000000-0000-0000-0000-000000000002'::uuid)
) as w(workspace_id)
cross join (values
  ('Honorários acima do orçamento', 0),
  ('Escolheu outro escritório', 1),
  ('Sem viabilidade jurídica', 2),
  ('Cliente desistiu', 3),
  ('Sem retorno do cliente', 4)
) as r(label, position);

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

-- =====================================================================
-- A10 — Visão geral: dois escritórios EXCLUSIVAMENTE para o dashboard,
-- com usuários próprios. Nenhum dado abaixo toca o Escritório Um/Dois
-- nem os usuários acima: os testes das fases anteriores continuam
-- enxergando exatamente o que enxergavam (independência pedida).
--
--   Paula  -> owner   no Escritório Painel (seed)
--   Lucas  -> lawyer  no Escritório Painel (seed)
--   Sofia  -> sales   no Escritório Painel (seed)
--   Vitor  -> viewer  no Escritório Painel (seed)
--   Otávio -> owner   no Escritório Painel B (seed) — isolamento
--
-- Os dados comerciais vêm do gerador determinístico mais abaixo (o mesmo
-- usado por scripts/a10-demo-workspace.mjs no praxis-crm-dev), com datas
-- relativas ao dia do `db reset` no fuso do escritório.
-- =====================================================================

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change, email_change_token_new, email_change_token_current,
  phone_change, phone_change_token, reauthentication_token,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin, is_sso_user, is_anonymous,
  created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
  extensions.crypt('praxis-seed-nao-e-senha-real', extensions.gen_salt('bf')),
  now(), '', '', '', '', '', '', '', '',
  '{"provider":"email","providers":["email"]}',
  jsonb_build_object('full_name', u.full_name),
  false, false, false, now(), now()
from (values
  ('20000000-0000-0000-0000-000000000010'::uuid, 'painel.owner.seed@praxis.test', 'Paula Painel (seed)'),
  ('20000000-0000-0000-0000-000000000011'::uuid, 'painel.lawyer.seed@praxis.test', 'Lucas Advogado (seed)'),
  ('20000000-0000-0000-0000-000000000012'::uuid, 'painel.sales.seed@praxis.test', 'Sofia Atendimento (seed)'),
  ('20000000-0000-0000-0000-000000000013'::uuid, 'painel.viewer.seed@praxis.test', 'Vitor Visualizador (seed)'),
  ('20000000-0000-0000-0000-000000000014'::uuid, 'painel-b.owner.seed@praxis.test', 'Otávio Painel B (seed)')
) as u(id, email, full_name);

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select u.id::text, u.id, jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), 'email', now(), now(), now()
from auth.users u
where u.id in (
  '20000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000012', '20000000-0000-0000-0000-000000000013',
  '20000000-0000-0000-0000-000000000014'
);

insert into public.workspaces (id, name, slug, created_by) values
  ('10000000-0000-0000-0000-000000000010', 'Escritório Painel (seed)', 'escritorio-painel-seed', '20000000-0000-0000-0000-000000000010'),
  ('10000000-0000-0000-0000-000000000011', 'Escritório Painel B (seed)', 'escritorio-painel-b-seed', '20000000-0000-0000-0000-000000000014');

-- is_demo só existe a partir da migration da A10; o CI também aplica
-- este seed num banco parado na versão anterior
-- (scripts/check-upgrade-proposal-counter.sh).
do $demo_flag$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspaces' and column_name = 'is_demo'
  ) then
    execute $u$ update public.workspaces set is_demo = true
      where id in ('10000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000011') $u$;
  end if;
end;
$demo_flag$;

insert into public.memberships (workspace_id, user_id, role, status) values
  ('10000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000010', 'owner', 'active'),
  ('10000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000011', 'lawyer', 'active'),
  ('10000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000012', 'sales', 'active'),
  ('10000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000013', 'viewer', 'active'),
  ('10000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000014', 'owner', 'active');

insert into public.pipelines (id, workspace_id, name, is_default, created_by) values
  ('50000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000010', 'Comercial', true, '20000000-0000-0000-0000-000000000010'),
  ('50000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000011', 'Comercial', true, '20000000-0000-0000-0000-000000000014');

insert into public.pipeline_stages (workspace_id, pipeline_id, name, position)
select w.workspace_id, w.pipeline_id, s.name, s.position
from (values
  ('10000000-0000-0000-0000-000000000010'::uuid, '50000000-0000-0000-0000-000000000010'::uuid),
  ('10000000-0000-0000-0000-000000000011'::uuid, '50000000-0000-0000-0000-000000000011'::uuid)
) as w(workspace_id, pipeline_id)
cross join (values
  ('Fazer primeiro contato', 0),
  ('Qualificar oportunidade', 1),
  ('Verificar aderência e conflito', 2),
  ('Agendar consulta', 3),
  ('Realizar consulta', 4),
  ('Enviar proposta', 5),
  ('Negociar honorários', 6),
  ('Aguardar assinatura', 7)
) as s(name, position);

insert into public.lost_reasons (workspace_id, label, position)
select w.workspace_id, r.label, r.position
from (values
  ('10000000-0000-0000-0000-000000000010'::uuid),
  ('10000000-0000-0000-0000-000000000011'::uuid)
) as w(workspace_id)
cross join (values
  ('Honorários acima do orçamento', 0),
  ('Escolheu outro escritório', 1),
  ('Sem viabilidade jurídica', 2),
  ('Cliente desistiu', 3),
  ('Sem retorno do cliente', 4)
) as r(label, position);

select set_config('praxis.demo_targets', $targets$[
  {"workspace_id": "10000000-0000-0000-0000-000000000010",
   "pipeline_id": "50000000-0000-0000-0000-000000000010",
   "owner": "20000000-0000-0000-0000-000000000010",
   "lawyer": "20000000-0000-0000-0000-000000000011",
   "sales": "20000000-0000-0000-0000-000000000012",
   "leads": 64},
  {"workspace_id": "10000000-0000-0000-0000-000000000011",
   "pipeline_id": "50000000-0000-0000-0000-000000000011",
   "owner": "20000000-0000-0000-0000-000000000014",
   "lawyer": null, "sales": null,
   "leads": 12}
]$targets$, false);

-- >>> A10 demo generator (reaproveitado por scripts/a10-demo-workspace.mjs — não mudar os marcadores)
-- Gera, para cada alvo de `praxis.demo_targets`, leads, oportunidades,
-- transições, atividades, propostas, clientes e handoffs fictícios.
-- Determinístico: tudo sai do índice do lead (aritmética modular), com
-- datas relativas ao dia atual no fuso do escritório. Só INSERT, sempre
-- no workspace do alvo.
do $a10_demo$
declare
  v_tz constant text := 'America/Sao_Paulo';
  v_first constant text[] := array[
    'Marina', 'Bruno', 'Tatiane', 'Rogério', 'Helena', 'Diego', 'Patrícia', 'Otávio', 'Lívia', 'Caio',
    'Renata', 'Gustavo', 'Aline', 'Fábio', 'Juliana', 'Márcio', 'Carolina', 'Eduardo', 'Sabrina', 'Vinícius'
  ];
  v_last constant text[] := array[
    'Sales', 'Tavares', 'Peixoto', 'Kruger', 'Serra', 'Moraes', 'Albuquerque', 'Nunes', 'Farias', 'Queiroz',
    'Barros', 'Teixeira', 'Rezende', 'Campos', 'Moura', 'Pacheco', 'Leal', 'Andrade', 'Siqueira', 'Prado'
  ];
  v_companies constant text[] := array[
    'Transportes Mairi', 'Construtora Nova Casa', 'Condomínio Alto da Serra', 'Metalúrgica Vale Verde', 'Clínica Bem Viver'
  ];
  v_areas constant text[] := array['Trabalhista', 'Tributário', 'Empresarial', 'Família', 'Previdenciário', 'Cível'];
  v_cities constant text[] := array['São Paulo', 'Campinas', 'Santos', 'Curitiba', 'Belo Horizonte'];
  v_ufs constant text[] := array['SP', 'SP', 'SP', 'PR', 'MG'];
  -- Dias que ficam na borda de algum período (7, 30, 90 e anteriores).
  v_edge_days constant integer[] := array[6, 13, 29, 59, 89, 179];
  v_target jsonb;
  v_ws uuid;
  v_pipeline uuid;
  v_owner uuid;
  v_lawyer uuid;
  v_sales uuid;
  v_n integer;
  v_stages uuid[];
  v_reasons uuid[];
  v_today date;
  i integer;
  k integer;
  p integer;
  v_day integer;
  v_won_day integer;
  v_contact uuid;
  v_lead uuid;
  v_opp uuid;
  v_client uuid;
  v_assignee uuid;
  v_actor uuid;
  v_lead_created timestamptz;
  v_opp_created timestamptz;
  v_target_pos integer;
  v_moves integer;
  v_status public.opportunity_status;
  v_finish timestamptz;
  v_step interval;
  v_at timestamptz;
  v_prev_at timestamptz;
  v_won_at timestamptz;
  v_value bigint;
  v_fee public.fee_model;
  v_proposal_at timestamptz;
  v_seq integer;
begin
  for v_target in select * from jsonb_array_elements(current_setting('praxis.demo_targets')::jsonb)
  loop
    v_ws := (v_target ->> 'workspace_id')::uuid;
    v_pipeline := (v_target ->> 'pipeline_id')::uuid;
    v_owner := (v_target ->> 'owner')::uuid;
    v_lawyer := coalesce((v_target ->> 'lawyer')::uuid, v_owner);
    v_sales := coalesce((v_target ->> 'sales')::uuid, v_owner);
    v_n := (v_target ->> 'leads')::integer;
    v_today := (now() at time zone v_tz)::date;
    v_seq := 0;

    select array_agg(id order by position) into v_stages
    from public.pipeline_stages where pipeline_id = v_pipeline and workspace_id = v_ws;
    select array_agg(id order by position) into v_reasons
    from public.lost_reasons where workspace_id = v_ws and active;

    if coalesce(array_length(v_stages, 1), 0) <> 8 or coalesce(array_length(v_reasons, 1), 0) = 0 then
      raise exception 'demo generator: pipeline com 8 etapas e motivos de perda são obrigatórios no alvo';
    end if;

    for i in 1..v_n loop
      -- Dia de criação: 8 leads nos últimos 6 dias, os demais espalhados
      -- até 177 dias atrás. Dias de borda são evitados, para que um reset
      -- perto da meia-noite não troque um lead de período.
      v_day := case
        when i <= 8 then (i - 1) % 6
        when i <= 30 then 8 + (i * 7) % 21
        when i <= 50 then 31 + (i * 11) % 58
        else 91 + (i * 13) % 87
      end;
      if v_day = any (v_edge_days) then
        v_day := v_day + 1;
      end if;

      v_lead_created := least(
        ((v_today - v_day)::timestamp + make_interval(hours => 9 + i % 6, mins => (i * 7) % 60)) at time zone v_tz,
        now() - make_interval(mins => 30 + i)
      );

      v_assignee := case i % 4 when 0 then null when 1 then v_owner when 2 then v_lawyer else v_sales end;
      v_actor := coalesce(v_assignee, v_owner);

      insert into public.contacts (workspace_id, type, name, city, uf, preferred_channel, created_by, created_at, updated_at)
      values (
        v_ws,
        (case when i % 9 = 0 then 'pj' else 'pf' end)::public.contact_type,
        case when i % 9 = 0 then v_companies[1 + (i / 9) % 5] || ' ' || i
             else v_first[1 + i % 20] || ' ' || v_last[1 + (i * 7 + (i / 20) * 11) % 20] end,
        v_cities[1 + i % 5],
        v_ufs[1 + i % 5],
        (array['whatsapp', 'email', 'telefone']::public.contact_channel[])[1 + i % 3],
        v_owner, v_lead_created, v_lead_created
      )
      returning id into v_contact;

      insert into public.leads (workspace_id, contact_id, legal_area, summary, priority, assigned_to, created_by, created_at, updated_at)
      values (
        v_ws, v_contact, v_areas[1 + i % 6],
        'Caso fictício de demonstração nº ' || i || '.',
        (array['baixa', 'media', 'alta']::public.lead_priority[])[1 + i % 3],
        v_assignee, v_owner, v_lead_created, v_lead_created
      )
      returning id into v_lead;

      -- Primeiro contato registrado para todo lead.
      insert into public.activities (
        workspace_id, lead_id, type, title, assigned_to, due_at, has_time, status, completed_at,
        created_by, created_at, updated_at
      )
      values (
        v_ws, v_lead, 'call', 'Primeiro contato', v_assignee,
        v_lead_created + interval '10 minutes', true, 'done',
        least(v_lead_created + interval '15 minutes', now() - interval '1 minute'),
        v_owner, v_lead_created, v_lead_created
      );

      -- Um lead em cada sete fica sem oportunidade; quatro leads têm duas.
      for k in 1..(case when i in (5, 12, 26, 40) then 2 else 1 end) loop
        continue when k = 1 and i % 7 = 3;

        v_opp_created := least(
          v_lead_created + make_interval(hours => 1 + (k - 1) * 30),
          now() - make_interval(mins => 20)
        );
        v_opp_created := greatest(v_opp_created, v_lead_created);
        v_target_pos := (i * 5 + k) % 8;
        v_status := case
          when (i + k) % 5 = 0 and v_target_pos >= 4 then 'won'
          when (i + k) % 6 = 1 and v_target_pos >= 1 then 'lost'
          else 'open'
        end::public.opportunity_status;
        v_value := case
          when i % 8 = 7 and v_status <> 'won' then null
          else ((i * 7919 + k) % 90 + 3)::bigint * 50000
        end;
        v_fee := (array['fixed', 'contingency', 'fixed_contingency']::public.fee_model[])[1 + (i + k) % 3];
        v_won_at := null;

        if v_status = 'won' then
          if v_day >= 91 then
            -- Lead antigo (criado há mais de 90 dias) que ganhou nos
            -- últimos 30 dias: precisa aparecer no período do ganho.
            v_won_day := 1 + i % 20;
            if v_won_day in (6, 13) then
              v_won_day := v_won_day + 1;
            end if;
            v_won_at := ((v_today - v_won_day)::timestamp + interval '15 hours') at time zone v_tz;
          else
            v_won_at := least(v_opp_created + make_interval(days => v_target_pos + 2), now() - interval '1 hour');
          end if;
          v_won_at := greatest(v_won_at, v_opp_created + interval '10 minutes');
          v_finish := v_won_at;
        elsif v_status = 'lost' then
          v_finish := least(v_opp_created + make_interval(days => v_target_pos + 1), now() - interval '2 hours');
        else
          -- Abertas: última movimentação há 1 dia (ativa) ou há 12 dias
          -- (parada), nunca antes da criação.
          v_finish := now() - case when i % 3 = 0 then interval '12 days' else interval '1 day' end;
        end if;
        v_finish := greatest(v_finish, v_opp_created + interval '5 minutes');

        insert into public.opportunities (
          workspace_id, lead_id, pipeline_id, stage_id, value_cents, fee_model, probability, forecast_date,
          stage_entered_at, status, lost_reason_id, signed_at, won_at, created_by, created_at, updated_at
        )
        values (
          v_ws, v_lead, v_pipeline, v_stages[1 + v_target_pos],
          v_value,
          case when v_value is null then null else v_fee end,
          case when v_status = 'open' then least(90, 10 * (v_target_pos + 1)) end,
          case when v_status = 'open' and i % 4 <> 0 then v_today + ((i * 3) % 80 - 10) end,
          v_finish, v_status,
          case when v_status = 'lost' then v_reasons[1 + i % array_length(v_reasons, 1)] end,
          case when v_status = 'won' and i % 2 = 0 then (v_won_at at time zone v_tz)::date end,
          v_won_at, v_owner, v_opp_created, v_finish
        )
        returning id into v_opp;

        -- Transições até a etapa alvo, em tempos crescentes. Uma em cada
        -- onze volta uma etapa e reentra: a reentrada não pode duplicar a
        -- contagem do funil.
        v_moves := v_target_pos + case when i % 11 = 0 and v_target_pos >= 3 then 2 else 0 end;
        v_step := case when v_moves > 0 then (v_finish - v_opp_created) / v_moves else interval '0' end;
        v_prev_at := v_opp_created;
        for p in 1..v_target_pos loop
          v_at := v_opp_created + v_step * p;
          insert into public.stage_transitions (
            workspace_id, opportunity_id, from_stage_id, to_stage_id, actor_user_id, occurred_at, seconds_in_previous_stage
          )
          values (v_ws, v_opp, v_stages[p], v_stages[p + 1], v_actor, v_at, extract(epoch from (v_at - v_prev_at))::bigint);
          v_prev_at := v_at;
        end loop;
        if v_moves > v_target_pos then
          v_at := v_opp_created + v_step * (v_target_pos + 1);
          insert into public.stage_transitions (
            workspace_id, opportunity_id, from_stage_id, to_stage_id, actor_user_id, occurred_at, seconds_in_previous_stage
          )
          values (v_ws, v_opp, v_stages[v_target_pos + 1], v_stages[v_target_pos], v_actor, v_at, extract(epoch from (v_at - v_prev_at))::bigint);
          v_prev_at := v_at;
          v_at := v_finish;
          insert into public.stage_transitions (
            workspace_id, opportunity_id, from_stage_id, to_stage_id, actor_user_id, occurred_at, seconds_in_previous_stage
          )
          values (v_ws, v_opp, v_stages[v_target_pos], v_stages[v_target_pos + 1], v_actor, v_at, extract(epoch from (v_at - v_prev_at))::bigint);
        end if;

        -- Consulta (reunião) concluída ao sair de "Realizar consulta";
        -- agendada quando a oportunidade aberta está nessa etapa.
        if v_target_pos >= 5 then
          v_at := greatest(v_opp_created + interval '1 minute', v_opp_created + v_step * 5 - interval '1 hour');
          insert into public.activities (
            workspace_id, lead_id, opportunity_id, type, title, assigned_to, due_at, has_time, status, completed_at,
            created_by, created_at, updated_at
          )
          values (
            v_ws, v_lead, v_opp, 'meeting', 'Consulta inicial', v_assignee,
            v_at - interval '1 minute', true, 'done', v_at, v_owner, v_opp_created, v_at
          );
        elsif v_target_pos = 4 and v_status = 'open' then
          insert into public.activities (
            workspace_id, lead_id, opportunity_id, type, title, assigned_to, due_at, has_time, status,
            created_by, created_at, updated_at
          )
          values (
            v_ws, v_lead, v_opp, 'meeting', 'Consulta agendada', v_assignee,
            now() + make_interval(days => 1 + i % 5), true, 'pending', v_owner, v_opp_created, v_opp_created
          );
        end if;

        if v_status = 'open' then
          if i % 9 in (2, 5) then
            insert into public.activities (
              workspace_id, lead_id, opportunity_id, type, title, assigned_to, due_at, has_time, status,
              created_by, created_at, updated_at
            )
            values (
              v_ws, v_lead, v_opp, 'call', 'Retornar ligação', v_assignee,
              now() - make_interval(days => 2 + i % 3), true, 'pending', v_owner, v_opp_created, v_opp_created
            );
          end if;
          if i % 3 = 1 then
            insert into public.activities (
              workspace_id, lead_id, opportunity_id, type, title, assigned_to, due_at, has_time, status,
              created_by, created_at, updated_at
            )
            values (
              v_ws, v_lead, v_opp, 'task', 'Enviar documentos pendentes', v_assignee,
              now() + make_interval(days => 2 + i % 10), true, 'pending', v_owner, v_opp_created, v_opp_created
            );
          end if;
          if i % 5 = 2 then
            insert into public.activities (
              workspace_id, lead_id, opportunity_id, type, title, assigned_to, due_at, has_time, status,
              created_by, created_at, updated_at
            )
            values (
              v_ws, v_lead, v_opp,
              (case when i % 2 = 0 then 'call' else 'deadline' end)::public.activity_type,
              case when i % 2 = 0 then 'Ligação de acompanhamento' else 'Prazo: enviar minuta' end,
              v_assignee,
              case when i % 2 = 0 then (v_today::timestamp + interval '16 hours') at time zone v_tz
                   else (v_today::timestamp + interval '23 hours 59 minutes 59 seconds') at time zone v_tz end,
              i % 2 = 0, 'pending', v_owner, v_opp_created, v_opp_created
            );
          end if;
        end if;

        -- Proposta com envio registrado a partir de "Negociar honorários"
        -- (e em todo ganho que passou de "Enviar proposta").
        if v_target_pos >= 6 or (v_status = 'won' and v_target_pos >= 5) then
          v_seq := v_seq + 1;
          v_proposal_at := greatest(v_opp_created + interval '2 minutes', v_finish - interval '1 day');
          insert into public.proposals (
            workspace_id, lead_id, opportunity_id, number, value_cents, fee_model, status,
            sent_channels, sent_at, decided_at, created_by, created_at, updated_at
          )
          values (
            v_ws, v_lead, v_opp, 'DEMO-' || lpad(v_seq::text, 4, '0'),
            coalesce(v_value, 500000), v_fee,
            (case v_status when 'won' then 'aceita' when 'lost' then 'recusada' else 'enviada' end)::public.proposal_status,
            array['email']::public.proposal_channel[], v_proposal_at,
            case when v_status in ('won', 'lost') then greatest(v_proposal_at, v_finish) end,
            v_owner, v_proposal_at - interval '1 minute', v_proposal_at
          );
        end if;

        -- Ganho: cliente (um ativo por contato) e handoff pendente, como
        -- win_opportunity() faz.
        if v_status = 'won' then
          v_client := null;
          insert into public.clients (workspace_id, contact_id, owner_user_id, created_at, updated_at)
          values (v_ws, v_contact, v_assignee, v_won_at, v_won_at)
          on conflict (workspace_id, contact_id) where status = 'ativo' do nothing
          returning id into v_client;
          if v_client is null then
            select id into v_client from public.clients
            where workspace_id = v_ws and contact_id = v_contact and status = 'ativo';
          end if;
          insert into public.client_handoffs (workspace_id, client_id, opportunity_id, created_at, updated_at)
          values (v_ws, v_client, v_opp, v_won_at, v_won_at);
        end if;
      end loop;
    end loop;
  end loop;
end;
$a10_demo$;
-- <<< A10 demo generator
