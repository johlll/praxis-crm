-- pgTAP — Assistente: possíveis duplicidades e cadastro por conversa (20261128120000).
--
--   A) Assinaturas: sem execução anônima; a tabela de solicitações não é acessível pela API.
--   B) Possíveis duplicidades: telefone, e-mail, nome igual e parecido; mesclados, anonimizados e
--      outros escritórios ficam de fora; quem não é membro não consulta. Só dados do contato: nenhuma
--      contagem de leads (o alcance dos leads muda por perfil), provado com leads de dois responsáveis.
--   C) Cadastro: contato + lead pelo fluxo oficial (auditoria e fila de duplicidades), uma vez só por
--      solicitação; repetição devolve o mesmo cadastro; outra pessoa ou outros dados com a mesma chave
--      são recusados. A consulta do resultado já gravado devolve o mesmo cadastro para a mesma chave e
--      os mesmos dados (resposta perdida), recusa outros dados ou outra pessoa e não vaza entre escritórios.
--   D) Permissões e isolamento: visualizador e não membro recusados sem deixar rastro; contato de outro
--      escritório recusado; advogado e atendimento cadastram.
--
-- As chamadas simultâneas com a mesma chave são provadas fora do pgTAP, com duas conexões.

begin;
select plan(53);

\set ana    '20000000-0000-0000-0000-000000000001'
\set lucas  '20000000-0000-0000-0000-000000000011'
\set sofia  '20000000-0000-0000-0000-000000000012'
\set vitor  '20000000-0000-0000-0000-000000000013'
\set otavio '20000000-0000-0000-0000-000000000014'

create function pg_temp.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

set local role authenticated;
select pg_temp.as_user(:'otavio');
select (create_workspace_with_owner('Assistente A', 'assistente-a')).id as ws \gset
select pg_temp.as_user(:'ana');
select (create_workspace_with_owner('Assistente B', 'assistente-b')).id as ws_b \gset
reset role;

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'lucas', 'lawyer', 'active'),
  (:'ws'::uuid, :'sofia', 'sales', 'active'),
  (:'ws'::uuid, :'vitor', 'viewer', 'active');

-- Contatos já existentes.
insert into public.contacts (id, workspace_id, type, name, created_by, merged_into_contact_id, anonymized_at) values
  ('a6400000-0000-0000-0000-000000000001', :'ws'::uuid, 'pf', 'Ana Ribeiro', :'otavio', null, null),
  ('a6400000-0000-0000-0000-000000000002', :'ws'::uuid, 'pf', 'Ana Ribeyro', :'otavio', null, null),
  ('a6400000-0000-0000-0000-000000000003', :'ws'::uuid, 'pf', 'Bruno Telefone', :'otavio', null, null),
  ('a6400000-0000-0000-0000-000000000004', :'ws'::uuid, 'pf', 'Carla Email', :'otavio', null, null),
  ('a6400000-0000-0000-0000-000000000006', :'ws'::uuid, 'pf', 'Ana Ribeiro Antiga', :'otavio', null, now()),
  ('a6400000-0000-0000-0000-000000000008', :'ws'::uuid, 'pf', 'Helena Dois Responsaveis', :'otavio', null, null),
  ('a6400000-0000-0000-0000-000000000007', :'ws_b'::uuid, 'pf', 'Ana Ribeiro', :'ana', null, null);
insert into public.contacts (id, workspace_id, type, name, created_by, merged_into_contact_id) values
  ('a6400000-0000-0000-0000-000000000005', :'ws'::uuid, 'pf', 'Ana Ribeiro', :'otavio', 'a6400000-0000-0000-0000-000000000001');
insert into public.contact_phones (workspace_id, contact_id, value_normalized) values
  (:'ws'::uuid, 'a6400000-0000-0000-0000-000000000003', '+5511999990001');
insert into public.contact_emails (workspace_id, contact_id, value_normalized) values
  (:'ws'::uuid, 'a6400000-0000-0000-0000-000000000004', 'carla@exemplo.com');
-- Um contato com leads de dois responsáveis: o advogado só vê o dele (e os sem responsável).
insert into public.leads (id, workspace_id, contact_id, legal_area, assigned_to, created_by) values
  ('b6400000-0000-0000-0000-000000000001', :'ws'::uuid, 'a6400000-0000-0000-0000-000000000008', 'Família', :'otavio', :'otavio'),
  ('b6400000-0000-0000-0000-000000000002', :'ws'::uuid, 'a6400000-0000-0000-0000-000000000008', 'Cível', :'otavio', :'otavio'),
  ('b6400000-0000-0000-0000-000000000003', :'ws'::uuid, 'a6400000-0000-0000-0000-000000000008', 'Trabalhista', :'lucas', :'otavio');

-- A) Assinaturas e acesso.
select ok(not has_function_privilege('anon', 'public.assistant_find_contact_matches(uuid, text, text, text)', 'execute'),
  'anônimo não consulta duplicidades');
select ok(not has_function_privilege('anon', 'public.assistant_register_client(uuid, uuid, text, text, text, jsonb, jsonb, uuid)', 'execute'),
  'anônimo não cadastra');
select ok(not has_table_privilege('authenticated', 'public.assistant_requests', 'select'),
  'a tabela de solicitações não é lida pela API');
select ok((select relrowsecurity from pg_class where oid = 'public.assistant_requests'::regclass), 'RLS ligada, sem policy: ninguém lê nem grava direto');
select is((select count(*)::int from pg_policies where tablename = 'assistant_requests'), 0, 'nenhuma policy');
select ok(not has_function_privilege('anon', 'public.assistant_find_registration(uuid, uuid, text, text, text, jsonb, jsonb, uuid)', 'execute'),
  'anônimo não consulta confirmações');
select ok(not has_function_privilege('authenticated', 'private.assistant_payload_hash(text, text, text, jsonb, jsonb, uuid)', 'execute'),
  'a impressão dos dados é interna');
select is((select count(*)::int from pg_proc where proname in ('assistant_find_contact_matches', 'assistant_register_client', 'assistant_find_registration')), 3,
  'uma assinatura de cada função');

-- B) Possíveis duplicidades.
set local role authenticated;
select pg_temp.as_user(:'lucas');

select is(
  (select array_agg(m ->> 'contact_id' order by m ->> 'contact_id')
     from jsonb_array_elements(public.assistant_find_contact_matches(:'ws'::uuid, 'Ana Ribeiro')) m),
  array['a6400000-0000-0000-0000-000000000001', 'a6400000-0000-0000-0000-000000000002'],
  'nome igual e parecido aparecem; mesclado, anonimizado e outro escritório não'
);
select is(
  (select m -> 'signals' from jsonb_array_elements(public.assistant_find_contact_matches(:'ws'::uuid, 'Ana Ribeiro')) m
    where m ->> 'contact_id' = 'a6400000-0000-0000-0000-000000000001'),
  '["same_name"]'::jsonb, 'o motivo do nome igual vem por escrito');
select is(
  (select m -> 'signals' from jsonb_array_elements(public.assistant_find_contact_matches(:'ws'::uuid, 'Ana Ribeiro')) m
    where m ->> 'contact_id' = 'a6400000-0000-0000-0000-000000000002'),
  '["similar_name"]'::jsonb, 'o nome parecido vem como parecido, não como igual');
select is(
  (select jsonb_agg(m -> 'signals') from jsonb_array_elements(public.assistant_find_contact_matches(:'ws'::uuid, 'Pessoa Nova', '+5511999990001')) m),
  '[["phone"]]'::jsonb, 'mesmo telefone com nome diferente');
select is(
  (select jsonb_agg(m -> 'signals') from jsonb_array_elements(public.assistant_find_contact_matches(:'ws'::uuid, 'Pessoa Nova', null, 'CARLA@exemplo.com')) m),
  '[["email"]]'::jsonb, 'mesmo e-mail, sem diferença de maiúsculas');
select is(public.assistant_find_contact_matches(:'ws'::uuid, 'Zé Ninguém Diferente'), '[]'::jsonb, 'sem parecido: lista vazia');
select is(public.assistant_find_contact_matches(:'ws'::uuid, 'Carlos Email'), '[]'::jsonb,
  'só o sobrenome em comum não é aviso (Carla Email x Carlos Email)');
select is(public.assistant_find_contact_matches(:'ws'::uuid, '  '), '[]'::jsonb, 'sem dado: lista vazia');

-- Contato com leads de dois responsáveis: a resposta só traz dados do contato, igual para todo perfil.
select is(
  (select array_agg(k order by k) from jsonb_array_elements(public.assistant_find_contact_matches(:'ws'::uuid, 'Helena Dois Responsaveis')) m,
     jsonb_object_keys(m) k),
  array['contact_id', 'created_at', 'name', 'signals'], 'sem contagem de leads na resposta (advogado com 1 dos 3 leads)');
select public.assistant_find_contact_matches(:'ws'::uuid, 'Helena Dois Responsaveis') as helena_advogado \gset
select pg_temp.as_user(:'otavio');
select is(public.assistant_find_contact_matches(:'ws'::uuid, 'Helena Dois Responsaveis'), :'helena_advogado'::jsonb,
  'proprietário (vê os 3 leads) recebe exatamente a mesma resposta que o advogado');
select pg_temp.as_user(:'lucas');

select pg_temp.as_user(:'vitor');
select is(jsonb_array_length(public.assistant_find_contact_matches(:'ws'::uuid, 'Ana Ribeiro')), 2, 'visualizador também consulta (só leitura)');

select pg_temp.as_user(:'ana');
select throws_ok($$ select public.assistant_find_contact_matches('$$ || :'ws' || $$'::uuid, 'Ana Ribeiro') $$,
  'insufficient_permission', 'quem não é membro do escritório não consulta');
select is(
  (select m ->> 'contact_id' from jsonb_array_elements(public.assistant_find_contact_matches(:'ws_b'::uuid, 'Ana Ribeiro')) m),
  'a6400000-0000-0000-0000-000000000007', 'no próprio escritório, só o contato dele');

-- C) Cadastro.
select pg_temp.as_user(:'otavio');
select public.assistant_register_client(:'ws'::uuid, 'e6400000-0000-0000-0000-000000000001',
  'Daniela Nova', 'Imobiliário', 'Regularização de imóvel', '[{"value_normalized": "+5511988887777", "is_primary": false}]'::jsonb, '[]'::jsonb) as r1 \gset

select is((:'r1'::jsonb ->> 'replayed')::boolean, false, 'primeira confirmação cadastra');
select is((:'r1'::jsonb ->> 'contact_created')::boolean, true, 'contato novo criado');
reset role;
select is((select name from public.contacts where id = (:'r1'::jsonb ->> 'contact_id')::uuid), 'Daniela Nova', 'contato com o nome confirmado');
select is((select type::text from public.contacts where id = (:'r1'::jsonb ->> 'contact_id')::uuid), 'pf', 'pessoa física');
select is((select value_normalized from public.contact_phones where contact_id = (:'r1'::jsonb ->> 'contact_id')::uuid), '+5511988887777', 'telefone gravado');
select is(
  (select format('%s|%s|%s', contact_id = (:'r1'::jsonb ->> 'contact_id')::uuid, legal_area, summary) from public.leads where id = (:'r1'::jsonb ->> 'lead_id')::uuid),
  't|Imobiliário|Regularização de imóvel', 'lead do mesmo contato, com área e resumo');
select is(
  (select array_agg(action order by action) from public.audit_logs
    where workspace_id = :'ws'::uuid and resource_id in ((:'r1'::jsonb ->> 'contact_id')::uuid, (:'r1'::jsonb ->> 'lead_id')::uuid)),
  array['contact.created', 'lead.created'], 'auditoria das duas criações, pelo fluxo oficial');
set local role authenticated;

select is(public.assistant_register_client(:'ws'::uuid, 'e6400000-0000-0000-0000-000000000001',
  'Daniela Nova', 'Imobiliário', 'Regularização de imóvel', '[{"value_normalized": "+5511988887777", "is_primary": false}]'::jsonb, '[]'::jsonb) - 'replayed',
  :'r1'::jsonb - 'replayed', 'repetir a confirmação devolve o mesmo cadastro');
select is((public.assistant_register_client(:'ws'::uuid, 'e6400000-0000-0000-0000-000000000001',
  'Daniela Nova', 'Imobiliário', 'Regularização de imóvel', '[{"value_normalized": "+5511988887777", "is_primary": false}]'::jsonb, '[]'::jsonb) ->> 'replayed')::boolean,
  true, 'e diz que foi repetição');
reset role;
select is((select count(*)::int from public.contacts where workspace_id = :'ws'::uuid and name = 'Daniela Nova'), 1, 'um contato só');
select is((select count(*)::int from public.leads l join public.contacts c on c.id = l.contact_id where c.name = 'Daniela Nova'), 1, 'um lead só');
set local role authenticated;

-- Resposta perdida: a nova tentativa consulta primeiro o resultado já gravado.
select is(public.assistant_find_registration(:'ws'::uuid, 'e6400000-0000-0000-0000-000000000001',
  'Daniela Nova', 'Imobiliário', 'Regularização de imóvel', '[{"value_normalized": "+5511988887777", "is_primary": false}]'::jsonb, '[]'::jsonb),
  (:'r1'::jsonb - 'replayed') || '{"replayed": true}'::jsonb, 'mesma chave e mesmos dados: devolve o cadastro já gravado');
select is(
  (select m ->> 'contact_id' from jsonb_array_elements(public.assistant_find_contact_matches(:'ws'::uuid, 'Daniela Nova', '+5511988887777')) m),
  :'r1'::jsonb ->> 'contact_id', 'sem essa consulta, a busca de duplicidade apontaria o próprio contato recém-criado');
select is(public.assistant_find_registration(:'ws'::uuid, 'e6400000-0000-0000-0000-0000000000ff', 'Daniela Nova', 'Imobiliário'),
  null::jsonb, 'chave nunca usada: nada gravado');
select throws_ok($$ select public.assistant_find_registration('$$ || :'ws' || $$'::uuid, 'e6400000-0000-0000-0000-000000000001',
  'Daniela Corrigida', 'Imobiliário', 'Regularização de imóvel', '[{"value_normalized": "+5511988887777", "is_primary": false}]'::jsonb, '[]'::jsonb) $$,
  'assistant_request_conflict', 'consulta com a mesma chave e outros dados é recusada');

select throws_ok($$ select public.assistant_register_client('$$ || :'ws' || $$'::uuid, 'e6400000-0000-0000-0000-000000000001',
  'Daniela Corrigida', 'Imobiliário', 'Regularização de imóvel', '[{"value_normalized": "+5511988887777", "is_primary": false}]'::jsonb, '[]'::jsonb) $$,
  'assistant_request_conflict', 'a mesma chave com outros dados é recusada');
select pg_temp.as_user(:'sofia');
select throws_ok($$ select public.assistant_register_client('$$ || :'ws' || $$'::uuid, 'e6400000-0000-0000-0000-000000000001',
  'Daniela Nova', 'Imobiliário', 'Regularização de imóvel', '[{"value_normalized": "+5511988887777", "is_primary": false}]'::jsonb, '[]'::jsonb) $$,
  'assistant_request_conflict', 'a mesma chave por outra pessoa é recusada');
select throws_ok($$ select public.assistant_find_registration('$$ || :'ws' || $$'::uuid, 'e6400000-0000-0000-0000-000000000001',
  'Daniela Nova', 'Imobiliário', 'Regularização de imóvel', '[{"value_normalized": "+5511988887777", "is_primary": false}]'::jsonb, '[]'::jsonb) $$,
  'assistant_request_conflict', 'outra pessoa não consulta a confirmação de quem cadastrou');
select pg_temp.as_user(:'ana');
select is(public.assistant_find_registration(:'ws_b'::uuid, 'e6400000-0000-0000-0000-000000000001',
  'Daniela Nova', 'Imobiliário', 'Regularização de imóvel', '[{"value_normalized": "+5511988887777", "is_primary": false}]'::jsonb, '[]'::jsonb),
  null::jsonb, 'a mesma chave em outro escritório não acha nada');

-- Contato existente: só o lead é criado.
select pg_temp.as_user(:'lucas');
select public.assistant_register_client(:'ws'::uuid, 'e6400000-0000-0000-0000-000000000002',
  'Ana Ribeiro', 'Família', null, '[]'::jsonb, '[]'::jsonb, 'a6400000-0000-0000-0000-000000000001') as r2 \gset
select is(:'r2'::jsonb ->> 'contact_id', 'a6400000-0000-0000-0000-000000000001', 'advogado cadastra caso no contato existente escolhido');
select is((:'r2'::jsonb ->> 'contact_created')::boolean, false, 'sem contato novo');
reset role;
select is((select count(*)::int from public.contacts where workspace_id = :'ws'::uuid and name = 'Ana Ribeiro'), 2,
  'nenhum "Ana Ribeiro" a mais (o ativo e o mesclado de antes)');
set local role authenticated;

select pg_temp.as_user(:'sofia');
select ok((public.assistant_register_client(:'ws'::uuid, 'e6400000-0000-0000-0000-000000000003',
  'Eduardo Atendimento', 'Trabalhista') ->> 'lead_id') is not null, 'atendimento cadastra');

-- D) Permissões e isolamento.
select pg_temp.as_user(:'vitor');
select throws_ok($$ select public.assistant_register_client('$$ || :'ws' || $$'::uuid, 'e6400000-0000-0000-0000-000000000004',
  'Fabio Visualizador', 'Cível') $$, 'insufficient_permission', 'visualizador não cadastra');
select throws_ok($$ select public.assistant_find_registration('$$ || :'ws' || $$'::uuid, 'e6400000-0000-0000-0000-000000000001',
  'Daniela Nova', 'Imobiliário') $$, 'insufficient_permission', 'visualizador não consulta confirmações');

select pg_temp.as_user(:'ana');
select throws_ok($$ select public.assistant_register_client('$$ || :'ws' || $$'::uuid, 'e6400000-0000-0000-0000-000000000005',
  'Gabi Outro Escritório', 'Cível') $$, 'insufficient_permission', 'membro de outro escritório não cadastra neste');

select pg_temp.as_user(:'otavio');
select throws_ok($$ select public.assistant_register_client('$$ || :'ws' || $$'::uuid, 'e6400000-0000-0000-0000-000000000006',
  'Ana Ribeiro', 'Cível', null, '[]'::jsonb, '[]'::jsonb, 'a6400000-0000-0000-0000-000000000007') $$,
  'contact_not_found', 'contato de outro escritório é recusado');
select throws_ok($$ select public.assistant_register_client('$$ || :'ws' || $$'::uuid, 'e6400000-0000-0000-0000-000000000007',
  'Ana Ribeiro', 'Cível', null, '[]'::jsonb, '[]'::jsonb, 'a6400000-0000-0000-0000-000000000005') $$,
  'contact_already_merged', 'contato mesclado é recusado');
select throws_ok($$ select public.assistant_register_client('$$ || :'ws' || $$'::uuid, 'e6400000-0000-0000-0000-000000000008',
  '   ', 'Cível') $$, '23514', null, 'nome vazio é recusado pela regra do contato');

reset role;
select is(
  (select count(*)::int from public.assistant_requests where workspace_id = :'ws'::uuid
     and request_id in ('e6400000-0000-0000-0000-000000000004', 'e6400000-0000-0000-0000-000000000005',
                        'e6400000-0000-0000-0000-000000000006', 'e6400000-0000-0000-0000-000000000007',
                        'e6400000-0000-0000-0000-000000000008')),
  0, 'tentativas recusadas não deixam solicitação reservada');
select is((select count(*)::int from public.contacts where workspace_id = :'ws'::uuid and name in ('Fabio Visualizador', 'Gabi Outro Escritório')), 0,
  'tentativas recusadas não criam contato');
select is((select count(*)::int from public.assistant_requests where workspace_id = :'ws'::uuid), 3, 'três solicitações concluídas');

select * from finish();
rollback;
