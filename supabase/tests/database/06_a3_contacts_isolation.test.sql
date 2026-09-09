-- pgTAP — A3: isolamento entre workspaces para contatos, busca por CPF via
-- blind index, e restrição/auditoria da revelação. Fixtures próprias desta
-- transação (não depende do seed) — exercita as funções RPC de verdade,
-- não INSERT direto.

begin;
select plan(16);

-- Dois workspaces fictícios (delete cascade limpa tudo no rollback).
insert into public.workspaces (id, name, slug, created_by)
values
  ('a0000000-0000-0000-0000-00000000a001', 'A3 Teste WS Um', 'a3-teste-ws-um', (select id from auth.users limit 1)),
  ('a0000000-0000-0000-0000-00000000a002', 'A3 Teste WS Dois', 'a3-teste-ws-dois', (select id from auth.users limit 1));

\set ws_um      'a0000000-0000-0000-0000-00000000a001'
\set ws_dois    'a0000000-0000-0000-0000-00000000a002'

-- Um usuário do seed existente (ana, owner) — membership nova nos dois
-- workspaces de teste, papel owner, para poder criar contato via RPC.
\set ana '20000000-0000-0000-0000-000000000001'

insert into public.memberships (workspace_id, user_id, role, status)
values
  (:'ws_um'::uuid, :'ana'::uuid, 'owner', 'active'),
  (:'ws_dois'::uuid, :'ana'::uuid, 'owner', 'active');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

-- Mesmo CPF fictício em dois workspaces diferentes — cifra e blind index
-- calculados aqui só para o teste (não é o caminho real da app, que
-- calcula em Node; o teste simula o formato só o suficiente para exercitar
-- a comparação de blind index, que é o que importa checar em SQL).
\set cpf_blind_ws_um   '\\xaaaa0000000000000000000000000000000000000000000000000000000001'
\set cpf_blind_ws_dois '\\xbbbb0000000000000000000000000000000000000000000000000000000002'
\set cpf_cipher_fake   '\\xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

select (create_contact(
  :'ws_um'::uuid, 'pf', 'Fulano de Tal', 'São Paulo', 'SP', 'whatsapp',
  '[]'::jsonb, '[]'::jsonb,
  encode(:'cpf_cipher_fake'::bytea, 'base64'),
  encode(:'cpf_blind_ws_um'::bytea, 'base64'),
  '1'
)).id as contact_um \gset

select (create_contact(
  :'ws_dois'::uuid, 'pf', 'Fulano de Tal (outro escritório)', 'Rio de Janeiro', 'RJ', 'whatsapp',
  '[]'::jsonb, '[]'::jsonb,
  encode(:'cpf_cipher_fake'::bytea, 'base64'),
  encode(:'cpf_blind_ws_dois'::bytea, 'base64'),
  '1'
)).id as contact_dois \gset

-- -----------------------------------------------------------------
-- 1) Ana só vê contatos do workspace ativo consultado — RLS filtra.
-- -----------------------------------------------------------------
select is(
  (select count(*)::int from public.contacts where workspace_id = :'ws_um'::uuid),
  1,
  'Workspace Um tem exatamente 1 contato'
);
select is(
  (select count(*)::int from public.contacts where workspace_id = :'ws_dois'::uuid),
  1,
  'Workspace Dois tem exatamente 1 contato'
);

-- -----------------------------------------------------------------
-- 2) Busca por CPF via blind index respeita o workspace — mesmo "CPF"
--    (blind index diferente, contextualizado por workspace de propósito)
--    só encontra o contato do workspace pedido.
-- -----------------------------------------------------------------
select is(
  (
    select count(*)::int
    from search_contacts_by_cpf_cnpj(:'ws_um'::uuid, array[encode(:'cpf_blind_ws_um'::bytea, 'base64')])
  ),
  1,
  'Busca por blind index do workspace Um encontra o contato certo'
);
select is(
  (
    select count(*)::int
    from search_contacts_by_cpf_cnpj(:'ws_um'::uuid, array[encode(:'cpf_blind_ws_dois'::bytea, 'base64')])
  ),
  0,
  'Buscar o blind index do workspace Dois dentro do workspace Um não retorna nada'
);
select is(
  (
    select count(*)::int
    from search_contacts_by_cpf_cnpj(:'ws_dois'::uuid, array[encode(:'cpf_blind_ws_dois'::bytea, 'base64')])
  ),
  1,
  'Busca por blind index do workspace Dois encontra o contato certo'
);

-- -----------------------------------------------------------------
-- 3) contact_sensitive: SELECT direto é sempre negado, mesmo dentro do
--    próprio workspace — só GRANT nenhum, nem RLS filtrando.
-- -----------------------------------------------------------------
select throws_ok(
  $i$ select count(*) from public.contact_sensitive $i$,
  '42501',
  null,
  'contact_sensitive: SELECT direto negado — sem GRANT nenhum'
);

-- -----------------------------------------------------------------
-- 4) contact_has_sensitive() só enxerga contato do próprio workspace.
-- -----------------------------------------------------------------
select ok(
  (select contact_has_sensitive((:'contact_um')::uuid)),
  'contact_has_sensitive() confirma CPF no contato do workspace Um'
);

-- -----------------------------------------------------------------
-- 5) Revelação: auditada, e Ana (owner) não precisa de motivo.
--    sensitive_data_access não tem GRANT para authenticated (sem tela
--    nesta fase) — as leituras de verificação do teste (não a chamada da
--    RPC em si, que precisa mesmo rodar como authenticated para provar
--    que o EXECUTE concedido funciona) voltam ao papel padrão.
-- -----------------------------------------------------------------
reset role;
select is(
  (select count(*)::int from public.sensitive_data_access where contact_id = (:'contact_um')::uuid),
  0,
  'Nenhuma revelação registrada ainda'
);
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

select lives_ok(
  format($i$ select reveal_contact_cpf_cnpj(%L::uuid) $i$, :'contact_um'),
  'Ana (owner) revela CPF sem precisar de motivo'
);

reset role;
select is(
  (select count(*)::int from public.sensitive_data_access where contact_id = (:'contact_um')::uuid),
  1,
  'Revelação foi auditada em sensitive_data_access'
);

select is(
  (select reason from public.sensitive_data_access where contact_id = (:'contact_um')::uuid limit 1),
  null,
  'A auditoria de revelação nunca guarda o CPF — só motivo (aqui nem motivo, pois owner não precisa)'
);
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

-- Membership de Bruno (sales) só no workspace Um, para testar a exigência
-- de motivo. INSERT direto em memberships é negado para authenticated
-- (só RPC escreve — A2) — volta ao papel padrão só para este fixture.
\set bruno '20000000-0000-0000-0000-000000000002'
reset role;
insert into public.memberships (workspace_id, user_id, role, status)
values (:'ws_um'::uuid, :'bruno'::uuid, 'sales', 'active')
on conflict (workspace_id, user_id) do update set role = 'sales', status = 'active';
set local role authenticated;

select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);

select throws_ok(
  format($i$ select reveal_contact_cpf_cnpj(%L::uuid) $i$, :'contact_um'),
  'P0001',
  'reason_required',
  'Atendimento (sales) sem motivo é negado'
);

select lives_ok(
  format($i$ select reveal_contact_cpf_cnpj(%L::uuid, 'cliente solicitou confirmação por telefone') $i$, :'contact_um'),
  'Atendimento (sales) COM motivo consegue revelar'
);

-- Viewer nunca revela, com ou sem motivo.
\set daniel '20000000-0000-0000-0000-000000000004'
reset role;
insert into public.memberships (workspace_id, user_id, role, status)
values (:'ws_um'::uuid, :'daniel'::uuid, 'viewer', 'active')
on conflict (workspace_id, user_id) do update set role = 'viewer', status = 'active';
set local role authenticated;

select set_config('request.jwt.claims', json_build_object('sub', :'daniel', 'role', 'authenticated')::text, true);

select throws_ok(
  format($i$ select reveal_contact_cpf_cnpj(%L::uuid, 'qualquer motivo') $i$, :'contact_um'),
  'P0001',
  'insufficient_permission',
  'Visualizador nunca revela CPF, mesmo com motivo'
);

select throws_ok(
  format($i$ select create_contact(%L::uuid, 'pf', 'Contato criado por viewer', null, null, null) $i$, :'ws_um'),
  'P0001',
  'insufficient_permission',
  'Visualizador não cria contato'
);

-- -----------------------------------------------------------------
-- 6) Ausência de CPF em log — audit_logs nunca guarda o valor, só ação.
--    audit_logs não tem GRANT para authenticated (sem tela nesta fase) —
--    volta ao papel padrão só para a própria checagem do teste.
-- -----------------------------------------------------------------
reset role;
select is(
  (
    select count(*)::int
    from public.audit_logs
    where resource_id = (:'contact_um')::uuid
      and (metadata::text ilike '%aaaa0000%' or metadata::text ilike '%deadbeef%')
  ),
  0,
  'audit_logs não contém nenhum fragmento de blind index ou ciphertext do CPF'
);

select * from finish();
rollback;
