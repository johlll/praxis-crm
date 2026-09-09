-- pgTAP — A3: regras de detecção de duplicidade, exatamente como
-- documentado em docs/decisoes/a3-duplicidades.md (definido ANTES desta
-- função existir). Fixtures próprias, via RPC de verdade.

begin;
select plan(10);

insert into public.workspaces (id, name, slug, created_by)
values ('a0000000-0000-0000-0000-00000000a010', 'A3 Teste Dedup', 'a3-teste-dedup', (select id from auth.users limit 1));

\set ws       'a0000000-0000-0000-0000-00000000a010'
\set ana      '20000000-0000-0000-0000-000000000001'

insert into public.memberships (workspace_id, user_id, role, status)
values (:'ws'::uuid, :'ana'::uuid, 'owner', 'active');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

-- -----------------------------------------------------------------
-- 1) CPF igual → strong.
-- -----------------------------------------------------------------
\set blind_x '\\xcccc0000000000000000000000000000000000000000000000000000000009'
\set cipher_x '\\xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

select (create_contact(:'ws'::uuid, 'pf', 'Carla Ferreira', null, null, null, '[]'::jsonb, '[]'::jsonb,
  encode(:'cipher_x'::bytea, 'base64'), encode(:'blind_x'::bytea, 'base64'), '1')).id as contact_cpf_a \gset
select (create_contact(:'ws'::uuid, 'pf', 'Carla F.', null, null, null, '[]'::jsonb, '[]'::jsonb,
  encode(:'cipher_x'::bytea, 'base64'), encode(:'blind_x'::bytea, 'base64'), '1')).id as contact_cpf_b \gset

select is(
  (
    select tier::text from public.duplicate_candidates
    where least(contact_a_id, contact_b_id) = least((:'contact_cpf_a')::uuid, (:'contact_cpf_b')::uuid)
      and greatest(contact_a_id, contact_b_id) = greatest((:'contact_cpf_a')::uuid, (:'contact_cpf_b')::uuid)
  ),
  'strong',
  'CPF igual gera candidato strong'
);

select ok(
  (
    select signals from public.duplicate_candidates
    where least(contact_a_id, contact_b_id) = least((:'contact_cpf_a')::uuid, (:'contact_cpf_b')::uuid)
  ) @> '[{"type":"cpf_exact"}]'::jsonb,
  'O sinal cpf_exact está registrado no motivo'
);

-- -----------------------------------------------------------------
-- 2) Telefone compartilhado, sem CPF → review, NUNCA strong (telefone
--    compartilhado não é prova de identidade).
-- -----------------------------------------------------------------
select (create_contact(:'ws'::uuid, 'pf', 'Família Souza (Mãe)', null, null, null,
  jsonb_build_array(jsonb_build_object('value_normalized', '+5511988887777', 'is_primary', true)),
  '[]'::jsonb)).id as contact_phone_a \gset
select (create_contact(:'ws'::uuid, 'pf', 'Família Souza (Filho)', null, null, null,
  jsonb_build_array(jsonb_build_object('value_normalized', '+5511988887777', 'is_primary', true)),
  '[]'::jsonb)).id as contact_phone_b \gset

select is(
  (
    select tier::text from public.duplicate_candidates
    where least(contact_a_id, contact_b_id) = least((:'contact_phone_a')::uuid, (:'contact_phone_b')::uuid)
      and greatest(contact_a_id, contact_b_id) = greatest((:'contact_phone_a')::uuid, (:'contact_phone_b')::uuid)
  ),
  'review',
  'Telefone compartilhado gera candidato de revisão, não strong'
);

-- -----------------------------------------------------------------
-- 3) Nome parecido SEM cidade compatível → nenhum candidato.
-- -----------------------------------------------------------------
select (create_contact(:'ws'::uuid, 'pf', 'José Roberto Almeida', null, null, null)).id as contact_name_a \gset
select (create_contact(:'ws'::uuid, 'pf', 'José Roberto Almeida Junior', null, null, null)).id as contact_name_b \gset

select is(
  (
    select count(*)::int from public.duplicate_candidates
    where least(contact_a_id, contact_b_id) = least((:'contact_name_a')::uuid, (:'contact_name_b')::uuid)
      and greatest(contact_a_id, contact_b_id) = greatest((:'contact_name_a')::uuid, (:'contact_name_b')::uuid)
  ),
  0,
  'Nome parecido sozinho (sem cidade) não gera candidato nenhum'
);

-- -----------------------------------------------------------------
-- 4) Nome parecido + cidade/UF compatível → low.
-- -----------------------------------------------------------------
select (create_contact(:'ws'::uuid, 'pf', 'Mariana Costa Lima', 'Curitiba', 'PR', null)).id as contact_city_a \gset
select (create_contact(:'ws'::uuid, 'pf', 'Mariana Costa Lima Silva', 'Curitiba', 'PR', null)).id as contact_city_b \gset

select is(
  (
    select tier::text from public.duplicate_candidates
    where least(contact_a_id, contact_b_id) = least((:'contact_city_a')::uuid, (:'contact_city_b')::uuid)
      and greatest(contact_a_id, contact_b_id) = greatest((:'contact_city_a')::uuid, (:'contact_city_b')::uuid)
  ),
  'low',
  'Nome parecido + cidade/UF compatível gera candidato de confiança baixa'
);

-- -----------------------------------------------------------------
-- 5) priority nunca é apresentado como probabilidade — só é um inteiro de
--    ordenação; conferimos que o strong > review > low, nada além disso.
-- -----------------------------------------------------------------
select ok(
  (
    select min(priority) from public.duplicate_candidates where tier = 'strong'
  ) > (
    select max(priority) from public.duplicate_candidates where tier = 'review'
  ),
  'priority de strong é sempre maior que qualquer review (só ordena a fila)'
);
select ok(
  (
    select min(priority) from public.duplicate_candidates where tier = 'review'
  ) > (
    select max(priority) from public.duplicate_candidates where tier = 'low'
  ),
  'priority de review é sempre maior que qualquer low'
);

-- -----------------------------------------------------------------
-- 6) Corrigir o telefone remove o candidato PENDENTE que dependia só dele
--    (a listagem reflete o estado atual, não sinal morto).
-- -----------------------------------------------------------------
select remove_contact_phone(
  (select id from public.contact_phones where contact_id = (:'contact_phone_b')::uuid)
);
select add_contact_phone((:'contact_phone_b')::uuid, '+5511900000000', true);

select is(
  (
    select count(*)::int from public.duplicate_candidates
    where least(contact_a_id, contact_b_id) = least((:'contact_phone_a')::uuid, (:'contact_phone_b')::uuid)
      and greatest(contact_a_id, contact_b_id) = greatest((:'contact_phone_a')::uuid, (:'contact_phone_b')::uuid)
      and status = 'pending'
  ),
  0,
  'Depois de corrigir o telefone, o candidato pendente que só dependia dele some'
);

-- -----------------------------------------------------------------
-- 7) Descartar um candidato não volta sozinho — só reabre se um humano
--    reconsiderar (fora do escopo desta função de detecção).
-- -----------------------------------------------------------------
select dismiss_duplicate_candidate(
  (
    select id from public.duplicate_candidates
    where least(contact_a_id, contact_b_id) = least((:'contact_cpf_a')::uuid, (:'contact_cpf_b')::uuid)
      and greatest(contact_a_id, contact_b_id) = greatest((:'contact_cpf_a')::uuid, (:'contact_cpf_b')::uuid)
  )
);

-- Roda a detecção de novo (via update trivial) — status descartado não
-- deve reabrir sozinho.
select update_contact_basic_fields((:'contact_cpf_a')::uuid, 'Carla Ferreira', null, null, null);

select is(
  (
    select status::text from public.duplicate_candidates
    where least(contact_a_id, contact_b_id) = least((:'contact_cpf_a')::uuid, (:'contact_cpf_b')::uuid)
      and greatest(contact_a_id, contact_b_id) = greatest((:'contact_cpf_a')::uuid, (:'contact_cpf_b')::uuid)
  ),
  'dismissed',
  'Um candidato descartado não reabre sozinho quando a detecção roda de novo'
);

-- audit_logs não tem GRANT para authenticated (sem tela nesta fase).
reset role;
select is(
  (
    select count(*)::int from public.audit_logs
    where action = 'duplicate_candidate.dismissed'
      and workspace_id = :'ws'::uuid
  ),
  1,
  'Descartar um candidato é auditado'
);

select * from finish();
rollback;
