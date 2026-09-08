-- pgTAP — A3: mesclagem transacional, reversão, e recusa de sobrescrever
-- silenciosamente quando algo foi editado depois da mesclagem.

begin;
select plan(14);

insert into public.workspaces (id, name, slug, created_by)
values
  ('a0000000-0000-0000-0000-00000000a020', 'A3 Teste Merge Um', 'a3-teste-merge-um', (select id from auth.users limit 1)),
  ('a0000000-0000-0000-0000-00000000a021', 'A3 Teste Merge Dois', 'a3-teste-merge-dois', (select id from auth.users limit 1));

\set ws       'a0000000-0000-0000-0000-00000000a020'
\set ws_outro 'a0000000-0000-0000-0000-00000000a021'
\set ana      '20000000-0000-0000-0000-000000000001'
\set carla    '20000000-0000-0000-0000-000000000003'

insert into public.memberships (workspace_id, user_id, role, status)
values
  (:'ws'::uuid, :'ana'::uuid, 'owner', 'active'),
  (:'ws_outro'::uuid, :'ana'::uuid, 'owner', 'active'),
  -- Carla é lawyer — tem permissão de editar contato, mas NÃO de mesclar
  -- (mesclar é só owner/admin/manager).
  (:'ws'::uuid, :'carla'::uuid, 'lawyer', 'active');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

select (create_contact(:'ws'::uuid, 'pf', 'Roberto Kept', 'Belo Horizonte', 'MG', 'whatsapp',
  jsonb_build_array(jsonb_build_object('value_normalized', '+5531999990001', 'is_primary', true)),
  jsonb_build_array(jsonb_build_object('value_normalized', 'roberto.kept@example.com', 'is_primary', true))
)).id as kept_id \gset

select (create_contact(:'ws'::uuid, 'pf', 'Roberto Merged', 'Belo Horizonte', 'MG', 'email',
  jsonb_build_array(jsonb_build_object('value_normalized', '+5531999990002', 'is_primary', true)),
  jsonb_build_array(jsonb_build_object('value_normalized', 'roberto.merged@example.com', 'is_primary', true))
)).id as merged_id \gset

select (create_contact(:'ws_outro'::uuid, 'pf', 'Contato de outro workspace', null, null, null)).id as other_ws_id \gset

-- -----------------------------------------------------------------
-- 1) Lawyer não pode mesclar — só owner/admin/manager.
-- -----------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select merge_contacts(%L::uuid, %L::uuid) $i$, :'kept_id', :'merged_id'),
  'P0001', 'insufficient_permission',
  'Lawyer não pode mesclar contatos'
);
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

-- -----------------------------------------------------------------
-- 2) Mesclagem entre workspaces é negada.
-- -----------------------------------------------------------------
select throws_ok(
  format($i$ select merge_contacts(%L::uuid, %L::uuid) $i$, :'kept_id', :'other_ws_id'),
  'P0001', 'cross_workspace_merge_denied',
  'Mesclar contatos de workspaces diferentes é negado'
);

-- -----------------------------------------------------------------
-- 3) Mesclagem de verdade: telefones/e-mails de merged migram para kept,
--    merged fica com merged_into_contact_id apontando para kept.
-- -----------------------------------------------------------------
select lives_ok(
  format($i$ select merge_contacts(%L::uuid, %L::uuid, '{"city":"a"}'::jsonb) $i$, :'kept_id', :'merged_id'),
  'Mesclagem de Roberto Merged em Roberto Kept é bem-sucedida'
);

select is(
  (select merged_into_contact_id from public.contacts where id = (:'merged_id')::uuid),
  (:'kept_id')::uuid,
  'merged_id aponta para kept_id depois da mesclagem'
);

select is(
  (select count(*)::int from public.contact_phones where contact_id = (:'kept_id')::uuid),
  2,
  'Os dois telefones (de kept e de merged) agora pertencem a kept'
);
select is(
  (select count(*)::int from public.contact_emails where contact_id = (:'kept_id')::uuid),
  2,
  'Os dois e-mails agora pertencem a kept'
);

-- -----------------------------------------------------------------
-- 4) Contato já mesclado não pode ser mesclado de novo.
-- -----------------------------------------------------------------
select throws_ok(
  format($i$ select merge_contacts(%L::uuid, %L::uuid) $i$, :'kept_id', :'merged_id'),
  'P0001', 'contact_already_merged',
  'Mesclar um contato já mesclado de novo é negado'
);

-- -----------------------------------------------------------------
-- 5) Reversão: sem edição posterior, desfaz sem erro e restaura tudo.
-- -----------------------------------------------------------------
-- contact_merges não tem GRANT nenhum para authenticated (sem tela de
-- histórico nesta fase, ver 20260908050400_a3_table_grants.sql) — a
-- própria checagem de teste precisa do papel padrão para ler.
reset role;
select (select id from public.contact_merges where merged_contact_id = (:'merged_id')::uuid) as merge_id \gset
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

select lives_ok(
  format($i$ select unmerge_contact(%L::uuid) $i$, :'merge_id'),
  'Desfazer a mesclagem funciona quando nada mudou depois'
);

select is(
  (select merged_into_contact_id from public.contacts where id = (:'merged_id')::uuid),
  null,
  'merged_id volta a ser um contato independente'
);
select is(
  (select count(*)::int from public.contact_phones where contact_id = (:'merged_id')::uuid),
  1,
  'O telefone de merged voltou para merged'
);

-- -----------------------------------------------------------------
-- 6) Mescla de novo, edita um dado movido, e tenta desfazer — deve
--    recusar (não sobrescrever silenciosamente).
-- -----------------------------------------------------------------
select merge_contacts((:'kept_id')::uuid, (:'merged_id')::uuid) as _ignore \gset

select (select id from public.contact_phones where contact_id = (:'kept_id')::uuid and value_normalized = '+5531999990002') as moved_phone_id \gset

-- Edita o telefone que veio de merged, agora sob kept — simula "uso normal
-- depois da mesclagem", pelo caminho real (RPC), não UPDATE direto (que a
-- RLS/GRANT já negam para o cliente de qualquer forma).
select update_contact_phone((:'moved_phone_id')::uuid, '+5531999990099');

-- now() é fixo durante toda a transação no Postgres — dentro deste único
-- teste, o updated_at gravado pela mesclagem e o gravado pela edição
-- acima seriam idênticos, mascarando o cenário que só existe de verdade
-- quando as duas ações acontecem em requisições (transações) diferentes.
-- Desliga o trigger só para simular a passagem de tempo neste fixture —
-- nunca representa como o app se comporta de verdade. ALTER TABLE exige
-- ser dono da tabela — volta ao papel padrão só para isto, authenticated
-- não teria esse privilégio (nem deveria).
reset role;
alter table public.contact_phones disable trigger contact_phones_set_updated_at;
update public.contact_phones set updated_at = updated_at + interval '1 minute' where id = (:'moved_phone_id')::uuid;
alter table public.contact_phones enable trigger contact_phones_set_updated_at;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

reset role;
select (select id from public.contact_merges where merged_contact_id = (:'merged_id')::uuid and undone_at is null) as merge_id_2 \gset
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

select throws_ok(
  format($i$ select unmerge_contact(%L::uuid) $i$, :'merge_id_2'),
  'P0001',
  null,
  'Desfazer é recusado quando algo movido foi editado depois da mesclagem'
);

-- Nada mudou de verdade: o telefone editado continua com kept, com o
-- valor editado — a recusa não deixou o dado num estado intermediário.
select is(
  (select contact_id from public.contact_phones where id = (:'moved_phone_id')::uuid),
  (:'kept_id')::uuid,
  'Depois da recusa, o telefone editado continua com kept — nada foi movido pela metade'
);
select is(
  (select value_normalized from public.contact_phones where id = (:'moved_phone_id')::uuid),
  '+5531999990099',
  'O valor editado não foi sobrescrito pela tentativa de desfazer'
);

-- -----------------------------------------------------------------
-- 7) A mesclagem em si sempre é auditada em audit_logs (que também não
--    tem GRANT para authenticated — mesmo motivo, sem tela nesta fase).
-- -----------------------------------------------------------------
reset role;
select is(
  (select count(*)::int from public.audit_logs where action = 'contact.merged' and workspace_id = :'ws'::uuid),
  2,
  'As duas mesclagens (original + repetida) foram auditadas'
);

select * from finish();
rollback;
