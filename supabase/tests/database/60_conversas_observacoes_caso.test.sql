-- pgTAP — Conversas + IA, painel do caso: OBSERVAÇÕES POR CASO.
--
-- Prova: superfície fechada; a observação pertence ao caso (dois casos do mesmo contato não se misturam,
-- outro escritório não enxerga); permissões de escrita (owner, admin, manager, lawyer, sales) e leitura
-- (inclui visualizador); alcance do lead; texto com quebras de linha preservado e HTML guardado como texto;
-- limites; idempotência (repetição, conflito, outro escritório); nenhum efeito colateral em trilhas,
-- roteiro, etapa, vínculo, mensagens ou notas do lead; auditoria sem o texto; paginação com horários iguais;
-- imutabilidade; caso sem número nem roteiro aceita observação; exportação só com a existência;
-- anonimização apaga e bloqueia; exclusão em cascata.
--
-- Fixtures do seed: ana=owner, carla=lawyer, elisa=viewer no Escritório Um; bruno=owner no Escritório Dois.
-- Aqui: bruno=sales e daniel=manager no Escritório Um. Dados sintéticos.

begin;
select plan(67);

\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set carla  '20000000-0000-0000-0000-000000000003'
\set daniel '20000000-0000-0000-0000-000000000004'
\set elisa  '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws_um'::uuid, :'bruno'::uuid, 'sales', 'active'),
  (:'ws_um'::uuid, :'daniel'::uuid, 'manager', 'active');

create function pg_temp.login(p_user uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$f$;
create function pg_temp.n(p_sql text) returns bigint language plpgsql security definer as $f$
declare v bigint;
begin
  execute p_sql into v;
  return v;
end;
$f$;
create function pg_temp.t(p_sql text) returns text language plpgsql security definer as $f$
declare v text;
begin
  execute p_sql into v;
  return v;
end;
$f$;
-- Percorre as observações pela RPC, página a página pelo cursor, até acabar. Devolve "páginas:id1,id2,...".
create function pg_temp.walk(p_opp uuid, p_limit int) returns text language plpgsql as $f$
declare
  v_before timestamptz;
  v_before_id uuid;
  v_items jsonb;
  v_more boolean := true;
  v_ids text[] := '{}';
  v_pages int := 0;
begin
  while v_more loop
    select r.items, r.has_more into v_items, v_more from public.list_case_notes(p_opp, v_before, v_before_id, p_limit) r;
    v_pages := v_pages + 1;
    exit when jsonb_array_length(v_items) = 0;
    v_ids := v_ids || array(select e ->> 'id' from jsonb_array_elements(v_items) with ordinality x(e, o) order by o);
    v_before := (v_items -> -1 ->> 'created_at')::timestamptz;
    v_before_id := (v_items -> -1 ->> 'id')::uuid;
    if v_pages > 200 then
      raise exception 'paginação sem fim';
    end if;
  end loop;
  return v_pages || ':' || array_to_string(v_ids, ',');
end;
$f$;
-- Fotografia do que uma observação NÃO pode mexer.
create function pg_temp.lado(p_ws uuid) returns text language sql security definer as $f$
  select md5(concat_ws('|',
    (select string_agg(t.id::text || t.version || coalesce(t.attendance_status::text, '') || coalesce(t.case_progress_status::text, ''), ',' order by t.id) from public.status_tracks t where t.workspace_id = p_ws),
    (select count(*) from public.status_track_events e where e.workspace_id = p_ws),
    (select count(*) from public.case_service_events e where e.workspace_id = p_ws),
    (select string_agg(o.id::text || o.stage_id || o.status, ',' order by o.id) from public.opportunities o where o.workspace_id = p_ws),
    (select string_agg(c.id::text || coalesce(c.opportunity_id::text, '-'), ',' order by c.id) from public.conversations c where c.workspace_id = p_ws),
    (select count(*) from public.messages m where m.workspace_id = p_ws),
    (select count(*) from public.lead_notes x where x.workspace_id = p_ws),
    (select count(*) from public.stage_transitions s where s.workspace_id = p_ws),
    (select count(*) from public.automation_events a where a.workspace_id = p_ws)))
$f$;

-- ---------------------------------------------------------------------
-- Dados de apoio
-- ---------------------------------------------------------------------

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
-- Contato O com dois leads (um da Ana, outro sem responsável): A aberto e B ganho; N aberto (sem número).
select (create_contact(:'ws_um'::uuid, 'pf', 'Olga Observação', null, null, null)).id as co \gset
select create_lead(:'ws_um'::uuid, (:'co')::uuid, 'Imobiliário', 'O1', '{}'::text[], 'media', :'ana'::uuid) as lo1 \gset
select create_lead(:'ws_um'::uuid, (:'co')::uuid, 'Família', 'O2', '{}'::text[], 'media', null) as lo2 \gset
select create_opportunity((:'lo1')::uuid) as opa \gset
select create_opportunity((:'lo2')::uuid) as opb \gset
select win_opportunity((:'opb')::uuid, 0, 100000, 'fixed');
select create_lead_note((:'lo1')::uuid, 'Nota GERAL do lead, não é observação de caso') as nota_lead \gset
select pg_temp.login(:'bruno'::uuid);
-- Bruno ainda é dono do Escritório Dois.
select (create_contact(:'ws_dois'::uuid, 'pf', 'Zuleica Observação', null, null, null)).id as cz \gset
select create_lead(:'ws_dois'::uuid, (:'cz')::uuid, 'Cível', 'Z', '{}'::text[], 'media', :'bruno'::uuid) as lz \gset
select create_opportunity((:'lz')::uuid) as oz \gset
reset role;
select pg_temp.lado((:'ws_um')::uuid) as lado0 \gset

-- =====================================================================
-- 1) Superfície
-- =====================================================================

select ok(
  pg_temp.n($q$select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'case_notes' and c.relrowsecurity and c.relforcerowsecurity$q$) = 1
  and pg_temp.n($q$select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'case_notes' and grantee in ('anon', 'authenticated', 'service_role')$q$) = 0,
  'case_notes: RLS ligada e forçada, nenhum privilégio para os papéis de API');
select is(
  pg_temp.n($q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'case_note%'
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('service_role', p.oid, 'execute'))$q$),
  0::bigint, 'as funções privadas novas não são chamáveis por papel de API');
select is(
  pg_temp.n($q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('add_case_note', 'list_case_notes')
      and p.prosecdef and p.proconfig = array['search_path=""']
      and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')$q$),
  2::bigint, 'as 2 funções públicas: SECURITY DEFINER, search_path vazio, authenticated sim, anon não');
select ok(
  not has_function_privilege('authenticated', 'private.privacy_export_payload(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.privacy_anonymize_contact(uuid,uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.privacy_anonymize_contact(uuid,uuid)', 'execute'),
  'exportação e anonimização recriadas continuam fechadas');
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok('select count(*) from public.case_notes', '42501', null, 'leitura direta da tabela recusada para quem tem sessão');
reset role;

-- =====================================================================
-- 2) Escrita: permissões, alcance e validação
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select add_case_note((:'opa')::uuid, E'  Cliente acompanha pelo WhatsApp.\r\nDocumentos conferidos.\n\nAguardar análise.  ', 'e0000000-0000-0000-0000-000000000001'::uuid) as n1 \gset
select is(:'n1'::jsonb ->> 'body', E'Cliente acompanha pelo WhatsApp.\nDocumentos conferidos.\n\nAguardar análise.',
  'texto gravado com as quebras de linha (CRLF vira LF), só as bordas aparadas');
select is(:'n1'::jsonb ->> 'replayed', 'false', 'primeira gravação não é repetição');
select ok(:'n1'::jsonb ->> 'author_name' is not null and :'n1'::jsonb ->> 'created_at' is not null, 'autor e horário registrados');
select ok(not (:'n1'::jsonb ? 'idempotency_key') and not (:'n1'::jsonb ? 'request_fingerprint'), 'a resposta não expõe chave nem impressão do pedido');
select add_case_note((:'opa')::uuid, '<script>alert(1)</script><b>negrito</b>', 'e0000000-0000-0000-0000-000000000002'::uuid) as n_html \gset
select is(:'n_html'::jsonb ->> 'body', '<script>alert(1)</script><b>negrito</b>', 'HTML é guardado como TEXTO, sem interpretar (a tela escapa)');

select throws_ok(format('select add_case_note(%L, %L, %L)', :'opa', E'  \n\t ', 'e0000000-0000-0000-0000-000000000003'), 'P0001', 'case_note_body_required', 'texto vazio recusado');
select throws_ok(format('select add_case_note(%L, %L, %L)', :'opa', repeat('a', 4001), 'e0000000-0000-0000-0000-000000000004'), 'P0001', 'case_note_too_long', 'mais de 4000 caracteres recusado');
select lives_ok(format('select add_case_note(%L, %L, %L)', :'opa', repeat('b', 4000), 'e0000000-0000-0000-0000-000000000005'), 'exatamente 4000 caracteres aceito');
select throws_ok(format('select add_case_note(%L, %L, null)', :'opa', 'x'), 'P0001', 'invalid_request', 'sem chave de idempotência: recusado');
select throws_ok(format('select add_case_note(%L, %L, %L)', '00000000-0000-4000-8000-000000000000', 'x', 'e0000000-0000-0000-0000-000000000006'), 'P0001', 'opportunity_not_found', 'caso inexistente');

-- Papéis com escrita (faixa de lead_note.edit) no caso B (lead sem responsável, todos alcançam).
select pg_temp.login(:'daniel'::uuid);
select lives_ok(format('select add_case_note(%L, %L, %L)', :'opb', 'Observação do gestor', 'e0000000-0000-0000-0000-000000000011'), 'gestor acrescenta');
select pg_temp.login(:'carla'::uuid);
select lives_ok(format('select add_case_note(%L, %L, %L)', :'opb', 'Observação da advogada', 'e0000000-0000-0000-0000-000000000012'), 'advogada acrescenta no caso que alcança');
select throws_ok(format('select add_case_note(%L, %L, %L)', :'opa', 'x', 'e0000000-0000-0000-0000-000000000013'), 'P0001', 'opportunity_not_found', 'advogada: caso de lead alheio não aparece');
select pg_temp.login(:'bruno'::uuid);
select lives_ok(format('select add_case_note(%L, %L, %L)', :'opb', 'Observação do atendimento', 'e0000000-0000-0000-0000-000000000014'), 'atendimento (sales) acrescenta');
select pg_temp.login(:'elisa'::uuid);
select throws_ok(format('select add_case_note(%L, %L, %L)', :'opb', 'x', 'e0000000-0000-0000-0000-000000000015'), 'P0001', 'insufficient_permission', 'visualizador não acrescenta');
select ok((select jsonb_array_length(r.items) from list_case_notes((:'opb')::uuid) r) = 3, 'visualizador LÊ as observações do caso');
reset role;

-- Outro escritório: não enxerga nem escreve.
set local role authenticated;
select pg_temp.login(:'bruno'::uuid);
select lives_ok(format('select add_case_note(%L, %L, %L)', :'oz', 'Observação no Escritório Dois', 'e0000000-0000-0000-0000-000000000001'),
  'a MESMA chave em outro escritório grava normalmente');
select pg_temp.login(:'ana'::uuid);
select throws_ok(format('select * from list_case_notes(%L)', :'oz'), 'P0001', 'opportunity_not_found', 'caso de outro escritório: não encontrado (leitura)');
select throws_ok(format('select add_case_note(%L, %L, %L)', :'oz', 'x', 'e0000000-0000-0000-0000-000000000021'), 'P0001', 'opportunity_not_found', 'caso de outro escritório: não encontrado (escrita)');
reset role;

-- =====================================================================
-- 3) Idempotência
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select is(add_case_note((:'opa')::uuid, E'Cliente acompanha pelo WhatsApp.\nDocumentos conferidos.\n\nAguardar análise.', 'e0000000-0000-0000-0000-000000000001'::uuid) ->> 'replayed', 'true',
  'resposta perdida: o MESMO pedido repetido devolve o registro gravado');
select is(add_case_note((:'opa')::uuid, E'  Cliente acompanha pelo WhatsApp.\r\nDocumentos conferidos.\n\nAguardar análise.  ', 'e0000000-0000-0000-0000-000000000001'::uuid) ->> 'id', :'n1'::jsonb ->> 'id',
  'repetição com o mesmo texto antes da normalização: o mesmo registro');
select throws_ok(format('select add_case_note(%L, %L, %L)', :'opa', 'Outro texto', 'e0000000-0000-0000-0000-000000000001'), 'P0001', 'idempotency_conflict', 'mesma chave com outro texto: conflito');
select throws_ok(format('select add_case_note(%L, %L, %L)', :'opb', E'Cliente acompanha pelo WhatsApp.\nDocumentos conferidos.\n\nAguardar análise.', 'e0000000-0000-0000-0000-000000000001'), 'P0001', 'idempotency_conflict', 'mesma chave em outro caso: conflito (não grava no alvo novo)');
reset role;
select is(pg_temp.n(format('select count(*) from public.case_notes where opportunity_id = %L', :'opa')), 3::bigint, 'o caso A tem exatamente as 3 observações aceitas');
select is(pg_temp.n(format('select count(*) from public.case_notes where opportunity_id = %L', :'opb')), 3::bigint, 'o caso B tem as 3 dele');

-- =====================================================================
-- 4) Caso é o dono: dois casos do mesmo contato não se misturam; notas do lead intactas
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select is(
  (select string_agg(e ->> 'opportunity_id', ',') from list_case_notes((:'opa')::uuid) r, jsonb_array_elements(r.items) e),
  :'opa' || ',' || :'opa' || ',' || :'opa', 'a lista do caso A só traz observações do caso A');
select ok(
  not exists (select 1 from list_case_notes((:'opb')::uuid) r, jsonb_array_elements(r.items) e where e ->> 'body' like 'Cliente acompanha%'),
  'nada do caso A aparece no caso B do mesmo contato');
select ok(
  not exists (select 1 from list_case_notes((:'opa')::uuid) r, jsonb_array_elements(r.items) e where e ->> 'body' like 'Nota GERAL%'),
  'a nota geral do lead não vira observação de caso');
reset role;
select is(pg_temp.t(format('select body from public.lead_notes where id = %L', :'nota_lead')), 'Nota GERAL do lead, não é observação de caso', 'a nota geral do lead continua intacta');
select is(pg_temp.n(format('select count(*) from public.lead_notes where lead_id in (%L, %L)', :'lo1', :'lo2')), 1::bigint, 'nenhuma nota do lead criada nem migrada');
select is(pg_temp.n(format('select count(*) from public.opportunity_case_numbers where opportunity_id = %L', :'opa')), 0::bigint,
  'caso aberto sem número interno aceitou observação (não exige número nem roteiro)');

-- =====================================================================
-- 5) Nenhum efeito colateral; auditoria sem o texto
-- =====================================================================

select is(pg_temp.lado((:'ws_um')::uuid), :'lado0', 'trilhas, versões, roteiro, etapa, vínculo, mensagens, notas do lead e automações: tudo igual');
select is(pg_temp.n($q$select count(*) from public.audit_logs where action = 'opportunity.case_note_added'$q$), 7::bigint, 'uma auditoria por observação gravada (repetições não auditam de novo)');
select is(pg_temp.n($q$select count(*) from public.audit_logs where action = 'opportunity.case_note_added'
    and (metadata::text ilike '%Cliente acompanha%' or metadata::text ilike '%script%' or metadata ? 'body')$q$), 0::bigint, 'a auditoria não copia o texto');
select is(pg_temp.t(format($q$select string_agg(k, ',' order by k) from public.audit_logs a, jsonb_object_keys(a.metadata) k
    where a.action = 'opportunity.case_note_added' and a.resource_id = %L and a.metadata ->> 'note_id' = %L$q$, :'opa', :'n1'::jsonb ->> 'id')),
  'length,note_id', 'auditoria: só o id da observação e o tamanho');

-- =====================================================================
-- 6) Imutável
-- =====================================================================

select throws_ok(format('update public.case_notes set body = %L where id = %L', 'alterado', :'n1'::jsonb ->> 'id'), 'P0001', 'case_note_immutable', 'o registro não muda (nem pelo dono do banco)');

-- =====================================================================
-- 7) Paginação: muitas observações, horários iguais (empate só pelo id)
-- =====================================================================

insert into public.case_notes (workspace_id, opportunity_id, body, created_by, created_at, idempotency_key, request_fingerprint)
select (:'ws_um')::uuid, (:'opb')::uuid, 'Observação em lote ' || i, (:'ana')::uuid,
       timestamptz '2026-11-10 10:00:00.123456+00' + (i / 6) * interval '1 second', gen_random_uuid(), 'lote'
from generate_series(0, 59) i;
select pg_temp.t(format($q$select string_agg(id::text, ',' order by created_at desc, id desc) from public.case_notes where opportunity_id = %L$q$, :'opb')) as esperado \gset
select pg_temp.n(format('select count(*) from public.case_notes where opportunity_id = %L', :'opb')) as total \gset
set local role authenticated;
select pg_temp.login(:'elisa'::uuid);
select is(pg_temp.walk((:'opb')::uuid, 10), ceil((:'total')::numeric / 10)::int || ':' || :'esperado', 'páginas de 10: todas, na ordem do banco, sem repetir nem pular');
select is(pg_temp.walk((:'opb')::uuid, 7), ceil((:'total')::numeric / 7)::int || ':' || :'esperado', 'páginas de 7 cortando grupos de horário igual: o mesmo resultado');
select is((select jsonb_array_length(r.items) from list_case_notes((:'opb')::uuid, null, null, 500) r), 50, 'o limite por página é 50');
select throws_ok(format('select * from list_case_notes(%L, %L, null)', :'opb', '2026-11-10 10:00:00+00'), 'P0001', 'invalid_cursor', 'cursor pela metade é recusado');
select is(
  (select count(*) from unnest(string_to_array(split_part(pg_temp.walk((:'opa')::uuid, 10), ':', 2), ',')) x where x = any(string_to_array(:'esperado', ','))),
  0::bigint, 'as páginas do caso A não trazem nada do caso B');
reset role;

-- =====================================================================
-- 8) Exportação do titular: só a existência
-- =====================================================================

select private.privacy_export_payload((:'ws_um')::uuid, (:'co')::uuid) as pacote \gset
select is(jsonb_array_length(:'pacote'::jsonb -> 'case_notes'), (:'total')::int + 3, 'exportação: uma entrada por observação dos casos do titular');
select is(
  (select string_agg(k, ',' order by k) from jsonb_object_keys(:'pacote'::jsonb #> '{case_notes,0}') k),
  'created_at,id,opportunity_id', 'exportação: só id, caso e data (sem texto nem autor)');
select ok((:'pacote'::jsonb)::text not like '%Cliente acompanha%' and (:'pacote'::jsonb)::text not like '%Observação em lote%',
  'o texto das observações não aparece no arquivo');
select ok(jsonb_array_length(:'pacote'::jsonb -> 'lead_notes') = 1 and not (:'pacote'::jsonb #> '{lead_notes,0}' ? 'body'),
  'as notas do lead seguem como antes (existência, sem texto)');
select ok(not exists (select 1 from jsonb_array_elements(:'pacote'::jsonb -> 'case_notes') e where e ->> 'opportunity_id' = :'oz'),
  'nada do outro escritório');

-- =====================================================================
-- 9) Anonimização: apaga, confere e bloqueia depois
-- =====================================================================

-- Contato P com um caso perdido e observações.
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select (create_contact(:'ws_um'::uuid, 'pf', 'Paulo Privado', null, null, null)).id as cp \gset
select create_lead(:'ws_um'::uuid, (:'cp')::uuid, 'Trabalhista', 'P', '{}'::text[], 'media', :'ana'::uuid) as lp \gset
select create_opportunity((:'lp')::uuid) as opp_p \gset
select add_case_note((:'opp_p')::uuid, 'CPF do cliente anotado: 123.456.789-00', 'e0000000-0000-0000-0000-000000000031'::uuid);
select add_case_note((:'opp_p')::uuid, 'Segunda observação com dado pessoal', 'e0000000-0000-0000-0000-000000000032'::uuid);
reset role;
update public.opportunities set status = 'lost', lost_reason_id = (select id from public.lost_reasons where workspace_id = (:'ws_um')::uuid order by position limit 1)
where id = (:'opp_p')::uuid;
select is(pg_temp.n(format('select count(*) from public.case_notes where opportunity_id = %L', :'opp_p')), 2::bigint, 'antes: o caso perdido tem 2 observações');
select lives_ok(format('select private.privacy_anonymize_contact(%L, %L)', :'ws_um', :'cp'), 'anonimização roda com observações no caso');
select is(pg_temp.n(format('select count(*) from public.case_notes where opportunity_id = %L', :'opp_p')), 0::bigint, 'depois: as observações foram APAGADAS');
select is(pg_temp.n(format($q$select count(*) from public.audit_logs where resource_id = %L and action = 'opportunity.case_note_added' and metadata <> '{}'::jsonb$q$, :'opp_p')), 0::bigint,
  'a auditoria das observações perdeu o metadata (só ação, ator e data ficam)');
select is(pg_temp.n($q$select count(*) from public.audit_logs where metadata::text like '%123.456.789-00%'$q$), 0::bigint, 'o texto não sobrou em nenhuma auditoria');
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select is((select jsonb_array_length(r.items) from list_case_notes((:'opp_p')::uuid) r), 0, 'o painel não mostra nada do caso anonimizado');
select throws_ok(format('select add_case_note(%L, %L, %L)', :'opp_p', 'nova', 'e0000000-0000-0000-0000-000000000033'), 'P0001', 'contact_anonymized', 'depois da anonimização, nada novo entra (função)');
select throws_ok(format('select add_case_note(%L, %L, %L)', :'opp_p', 'CPF do cliente anotado: 123.456.789-00', 'e0000000-0000-0000-0000-000000000031'), 'P0001', 'contact_anonymized',
  'nem a repetição de um pedido antigo traz o texto de volta');
reset role;
select throws_ok(
  format('insert into public.case_notes (workspace_id, opportunity_id, body, created_by, idempotency_key, request_fingerprint) values (%L, %L, %L, %L, gen_random_uuid(), %L)',
    :'ws_um', :'opp_p', 'direto', :'ana', 'x'),
  'P0001', 'contact_anonymized', 'depois da anonimização, nada novo entra (escritor direto)');

-- Conferência final da anonimização: uma observação que não sai desfaz tudo.
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select (create_contact(:'ws_um'::uuid, 'pf', 'Quésia Quebra', null, null, null)).id as cq \gset
select create_lead(:'ws_um'::uuid, (:'cq')::uuid, 'Cível', 'Q', '{}'::text[], 'media', :'ana'::uuid) as lq \gset
select create_opportunity((:'lq')::uuid) as opp_q \gset
select add_case_note((:'opp_q')::uuid, 'Observação que resiste', 'e0000000-0000-0000-0000-000000000041'::uuid);
reset role;
update public.opportunities set status = 'lost', lost_reason_id = (select id from public.lost_reasons where workspace_id = (:'ws_um')::uuid order by position limit 1)
where id = (:'opp_q')::uuid;
create function pg_temp.barra() returns trigger language plpgsql as $f$ begin return null; end; $f$;
create trigger obs_test_barra before delete on public.case_notes for each row execute function pg_temp.barra();
select throws_ok(format('select private.privacy_anonymize_contact(%L, %L)', :'ws_um', :'cq'), 'P0001', 'anonymization_incomplete',
  'se uma observação não puder ser apagada, a anonimização inteira é desfeita');
drop trigger obs_test_barra on public.case_notes;
select ok(pg_temp.t(format('select name from public.contacts where id = %L', :'cq')) = 'Quésia Quebra'
  and pg_temp.n(format('select count(*) from public.case_notes where opportunity_id = %L', :'opp_q')) = 1,
  'nada foi anonimizado pela metade');

-- =====================================================================
-- 10) Exclusão administrativa em cascata
-- =====================================================================

select lives_ok(format('delete from public.opportunities where id = %L', :'opa'), 'excluir a oportunidade leva as observações');
select is(pg_temp.n(format('select count(*) from public.case_notes where opportunity_id = %L', :'opa')), 0::bigint, 'nada do caso excluído sobra');
select lives_ok(format('delete from public.opportunities where id = %L', :'opb'), 'excluir a outra oportunidade (ganha) leva as observações dela');
select is(pg_temp.n(format('select count(*) from public.case_notes where opportunity_id = %L', :'opb')), 0::bigint, 'nada dela sobra');
select ok(pg_temp.n(format('select count(*) from public.case_notes where opportunity_id = %L', :'oz')) = 1, 'o outro escritório não foi tocado');

select * from finish();
rollback;
