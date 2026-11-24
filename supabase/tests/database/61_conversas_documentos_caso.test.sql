-- pgTAP — Conversas + IA, painel do caso: DOCUMENTOS POR CASO.
--
-- Prova: superfície fechada (tabelas deny-all, bucket privado sem policy, funções de escrita só service_role);
-- portão de recebimento FECHADO por padrão (begin e finalize recusam, inclusive para o owner); com o portão
-- aberto: o documento pertence ao caso (dois casos do mesmo contato não se misturam, outro escritório não
-- enxerga), papéis de envio/conferência/remoção, alcance do lead, nome limpo e guardado como texto, limites,
-- idempotência (repetição e conflito), finalização só com o objeto no Storage e o tipo declarado, cancelamento
-- em duas fases com vencedor único contra a finalização, janela do link de envio (emissão mais recente) e
-- caminho vigiado na fila até a janela fechar (envio atrasado ou link reutilizado nunca vira órfão);
-- conferência com versão (sem sobrescrita silenciosa) e observação obrigatória na pendência; remoção em duas
-- fases (recusa enquanto o objeto existe); fila de limpeza nas exclusões; nada muda em trilhas, roteiro,
-- etapa, vínculo, mensagens ou automações; auditoria sem nome nem observação; exportação só com metadados;
-- anonimização bloqueada enquanto houver documento.
--
-- Fixtures do seed: ana=owner, carla=lawyer, elisa=viewer no Escritório Um; bruno=owner no Escritório Dois.
-- Aqui: bruno=sales e daniel=manager no Escritório Um. Dados e "arquivos" sintéticos (só a linha de
-- storage.objects, como o teste das propostas).

begin;
select plan(90);

\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set carla  '20000000-0000-0000-0000-000000000003'
\set daniel '20000000-0000-0000-0000-000000000004'
\set elisa  '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set sha     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

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
-- "Sobe" o arquivo: a linha de storage.objects no caminho que o begin reservou, com o tamanho dado.
create function pg_temp.subir(p_doc uuid, p_size bigint) returns void language sql security definer as $f$
  insert into storage.objects (bucket_id, name, metadata)
  select 'case-documents', storage_path, jsonb_build_object('size', p_size, 'mimetype', declared_type)
  from public.case_documents where id = p_doc
$f$;
-- Simula a remoção pela API do Storage. O Supabase real recusa DELETE direto em storage.objects
-- (storage.protect_delete) sem esta configuração da sessão; ela vale só nesta transação de teste.
create function pg_temp.apagar_objeto(p_doc uuid) returns void language sql security definer as $f$
  select set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects where bucket_id = 'case-documents'
    and name = (select storage_path from public.case_documents where id = p_doc)
$f$;
-- Fotografia do que um documento NÃO pode mexer.
create function pg_temp.lado(p_ws uuid) returns text language sql security definer as $f$
  select md5(concat_ws('|',
    (select string_agg(t.id::text || t.version || coalesce(t.attendance_status::text, '') || coalesce(t.case_progress_status::text, ''), ',' order by t.id) from public.status_tracks t where t.workspace_id = p_ws),
    (select count(*) from public.status_track_events e where e.workspace_id = p_ws),
    (select count(*) from public.case_service_events e where e.workspace_id = p_ws),
    (select string_agg(o.id::text || o.stage_id || o.status || o.lock_version, ',' order by o.id) from public.opportunities o where o.workspace_id = p_ws),
    (select string_agg(c.id::text || coalesce(c.opportunity_id::text, '-'), ',' order by c.id) from public.conversations c where c.workspace_id = p_ws),
    (select count(*) from public.messages m where m.workspace_id = p_ws),
    (select count(*) from public.case_notes x where x.workspace_id = p_ws),
    (select count(*) from public.stage_transitions s where s.workspace_id = p_ws),
    (select count(*) from public.automation_events a where a.workspace_id = p_ws),
    (select count(*) from public.outbox),
    (select count(*) from public.calendar_effect_intents),
    (select count(*) from public.whatsapp_outbox)))
$f$;

-- ---------------------------------------------------------------------
-- Dados de apoio: contato com DOIS casos (A aberto, lead da Ana; B ganho, lead sem responsável)
-- ---------------------------------------------------------------------

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select (create_contact(:'ws_um'::uuid, 'pf', 'Dora Documento', null, null, null)).id as co \gset
select create_lead(:'ws_um'::uuid, (:'co')::uuid, 'Imobiliário', 'D1', '{}'::text[], 'media', :'ana'::uuid) as lo1 \gset
select create_lead(:'ws_um'::uuid, (:'co')::uuid, 'Família', 'D2', '{}'::text[], 'media', null) as lo2 \gset
select create_opportunity((:'lo1')::uuid) as opa \gset
select create_opportunity((:'lo2')::uuid) as opb \gset
select win_opportunity((:'opb')::uuid, 0, 100000, 'fixed');
select pg_temp.login(:'bruno'::uuid);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Zeca Documento', null, null, null)).id as cz \gset
select create_lead(:'ws_dois'::uuid, (:'cz')::uuid, 'Cível', 'Z', '{}'::text[], 'media', :'bruno'::uuid) as lz \gset
select create_opportunity((:'lz')::uuid) as oz \gset
reset role;
select pg_temp.lado((:'ws_um')::uuid) as lado0 \gset

-- =====================================================================
-- 1) Superfície
-- =====================================================================

select ok(
  pg_temp.n($q$select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('case_documents', 'case_document_storage_cleanup', 'case_document_upload_gate') and c.relrowsecurity and c.relforcerowsecurity$q$) = 3
  and pg_temp.n($q$select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('case_documents', 'case_document_storage_cleanup', 'case_document_upload_gate')
      and grantee in ('anon', 'authenticated', 'service_role')$q$) = 0,
  'tabelas novas: RLS ligada e forçada, nenhum privilégio para os papéis de API');
select ok(
  (select not public and file_size_limit = 10485760 and allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png']
   from storage.buckets where id = 'case-documents')
  and pg_temp.n($q$select count(*) from pg_policies where schemaname = 'storage' and (qual like '%case-documents%' or with_check like '%case-documents%')$q$) = 0,
  'bucket case-documents privado, 10 MiB, só PDF/JPEG/PNG, sem nenhuma policy de Storage');
select is(
  pg_temp.n($q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('begin_case_document', 'finalize_case_document', 'begin_case_document_abandon',
      'finalize_case_document_abandon', 'begin_case_document_removal', 'finalize_case_document_removal', 'case_document_cleanup_claim',
      'case_document_cleanup_complete')
      and p.prosecdef and p.proconfig = array['search_path=""']
      and has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')$q$),
  8::bigint, 'as 8 funções de escrita do arquivo: SECURITY DEFINER, search_path vazio, SÓ service_role');
select is(
  pg_temp.n($q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('list_case_documents', 'get_case_document_for_download', 'set_case_document_review', 'get_pending_case_document')
      and p.prosecdef and p.proconfig = array['search_path=""']
      and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')$q$),
  4::bigint, 'as 4 funções de sessão: SECURITY DEFINER, search_path vazio, authenticated sim, anon não');
select is(
  pg_temp.n($q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'case_document%'
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('service_role', p.oid, 'execute'))$q$),
  0::bigint, 'as funções privadas novas não são chamáveis por papel de API');
select ok(
  not has_function_privilege('authenticated', 'private.privacy_export_payload(uuid,uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.privacy_retention_assess(uuid,uuid)', 'execute'),
  'exportação e avaliação recriadas continuam fechadas');
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok('select count(*) from public.case_documents', '42501', null, 'leitura direta da tabela recusada para quem tem sessão');
select throws_ok(format('select begin_case_document(%L, %L, %L, %L, %s, %L)', :'opa', :'ana', 'x.pdf', 'application/pdf', 10, gen_random_uuid()),
  '42501', null, 'owner com sessão não chama a reserva de envio (só service_role)');
reset role;

-- =====================================================================
-- 2) Portão de recebimento: FECHADO por padrão, para todos
-- =====================================================================

select is((select enabled from public.case_document_upload_gate), false, 'o portão nasce fechado');
set local role service_role;
select throws_ok(format('select begin_case_document(%L, %L, %L, %L, %s, %L)', :'opa', :'ana', 'contrato.pdf', 'application/pdf', 1000, 'f0000000-0000-0000-0000-000000000001'),
  'P0001', 'case_documents_upload_disabled', 'portão fechado: nem o owner reserva envio');
reset role;
select throws_ok('update public.case_document_upload_gate set enabled = true',
  '23514', null, 'abrir o portão exige a referência do registro da ativação do backup');

-- Abre (como faria a etapa operacional, com a referência) só para os testes seguintes; volta a fechar no fim.
update public.case_document_upload_gate set enabled = true, backup_activation_ref = 'teste pgTAP — sem backup real';

-- =====================================================================
-- 3) Envio: permissões, alcance, validação, idempotência
-- =====================================================================

set local role service_role;
select throws_ok(format('select begin_case_document(%L, %L, %L, %L, %s, %L)', :'opa', :'elisa', 'x.pdf', 'application/pdf', 10, gen_random_uuid()),
  'P0001', 'insufficient_permission', 'visualizador não envia');
select throws_ok(format('select begin_case_document(%L, %L, %L, %L, %s, %L)', :'opa', :'carla', 'x.pdf', 'application/pdf', 10, gen_random_uuid()),
  'P0001', 'opportunity_not_found', 'advogada fora do alcance (lead de outra pessoa): não encontrado');
select throws_ok(format('select begin_case_document(%L, %L, %L, %L, %s, %L)', :'oz', :'ana', 'x.pdf', 'application/pdf', 10, gen_random_uuid()),
  'P0001', 'opportunity_not_found', 'caso de outro escritório: não encontrado');
select throws_ok(format('select begin_case_document(%L, %L, %L, %L, %s, %L)', :'opa', :'ana', 'x.exe', 'application/x-msdownload', 10, gen_random_uuid()),
  'P0001', 'case_document_type_not_allowed', 'tipo fora de PDF/JPEG/PNG recusado');
select throws_ok(format('select begin_case_document(%L, %L, %L, %L, %s, %L)', :'opa', :'ana', 'grande.pdf', 'application/pdf', 10485761, gen_random_uuid()),
  'P0001', 'case_document_too_large', 'acima de 10 MiB recusado');
select throws_ok(format('select begin_case_document(%L, %L, %L, %L, %s, %L)', :'opa', :'ana', 'vazio.pdf', 'application/pdf', 0, gen_random_uuid()),
  'P0001', 'case_document_empty', 'arquivo vazio recusado');

-- Sales envia no caso A (lead da Ana: sales alcança); nome com caminho, controle e marca de direção é limpo.
select begin_case_document((:'opa')::uuid, (:'bruno')::uuid, E'C:\\fotos\\<img src=x onerror=alert(1)>matrícula\u202e.pdf', 'application/pdf', 2048,
  'f0000000-0000-0000-0000-000000000010'::uuid) as r1 \gset
select (:'r1'::jsonb ->> 'document_id') as d1 \gset
select ok(:'r1'::jsonb ->> 'status' = 'pending' and (:'r1'::jsonb ->> 'replayed')::boolean = false
  and :'r1'::jsonb ->> 'storage_path' = :'ws_um' || '/' || :'opa' || '/' || :'d1',
  'sales reserva o envio; caminho gerado pelo banco: escritório/caso/documento (sem o nome do arquivo)');
select is(pg_temp.t(format('select original_name from public.case_documents where id = %L', :'d1')), '<img src=x onerror=alert(1)>matrícula.pdf',
  'nome limpo (sem caminho nem marca de direção) e guardado como TEXTO, sem interpretação');
select begin_case_document((:'opa')::uuid, (:'bruno')::uuid, E'C:\\fotos\\<img src=x onerror=alert(1)>matrícula\u202e.pdf', 'application/pdf', 2048,
  'f0000000-0000-0000-0000-000000000010'::uuid) as r1b \gset
select ok((:'r1b'::jsonb ->> 'document_id') = :'d1' and (:'r1b'::jsonb ->> 'replayed')::boolean,
  'repetição com a mesma chave devolve o MESMO documento (nunca duplica)');
select throws_ok(format('select begin_case_document(%L, %L, %L, %L, %s, %L)', :'opa', :'bruno', 'outro.pdf', 'application/pdf', 2048, 'f0000000-0000-0000-0000-000000000010'),
  'P0001', 'idempotency_conflict', 'mesma chave com outro arquivo: conflito');
select throws_ok(format('select begin_case_document(%L, %L, %L, %L, %s, %L)', :'opb', :'bruno', 'matricula.pdf', 'application/pdf', 2048, 'f0000000-0000-0000-0000-000000000010'),
  'P0001', 'idempotency_conflict', 'mesma chave em OUTRO caso do mesmo contato: conflito, nunca reaproveita');
select is(pg_temp.n(format('select count(*) from public.case_documents where opportunity_id = %L', :'opa')), 1::bigint, 'uma linha só no caso A');

-- Finalização: só com o objeto no Storage, do mesmo tamanho, e com o tipo declarado.
select throws_ok(format('select finalize_case_document(%L, %L, %L, %s, %L)', :'d1', :'bruno', 'application/pdf', 2048, :'sha'),
  'P0001', 'document_object_missing_or_size_mismatch', 'sem objeto no Storage: não finaliza');
reset role;
select pg_temp.subir((:'d1')::uuid, 2048);
set local role service_role;
select throws_ok(format('select finalize_case_document(%L, %L, %L, %s, %L)', :'d1', :'bruno', 'application/pdf', 999, :'sha'),
  'P0001', 'document_object_missing_or_size_mismatch', 'tamanho diferente do objeto: não finaliza');
select throws_ok(format('select finalize_case_document(%L, %L, %L, %s, %L)', :'d1', :'bruno', 'image/png', 2048, :'sha'),
  'P0001', 'case_document_content_mismatch', 'conteúdo de outro tipo que o declarado: não finaliza');
select throws_ok(format('select finalize_case_document(%L, %L, %L, %s, %L)', :'d1', :'ana', 'application/pdf', 2048, :'sha'),
  'P0001', 'document_not_found', 'só quem iniciou o envio finaliza');
select lives_ok(format('select finalize_case_document(%L, %L, %L, %s, %L)', :'d1', :'bruno', 'application/pdf', 2048, :'sha'),
  'objeto presente, tamanho e tipo certos: finaliza');
select ok((finalize_case_document((:'d1')::uuid, (:'bruno')::uuid, 'application/pdf', 2048, :'sha') ->> 'replayed')::boolean,
  'finalizar de novo com os mesmos dados é repetição, sem trocar nada');
select throws_ok(format('select finalize_case_document(%L, %L, %L, %s, %L)', :'d1', :'bruno', 'application/pdf', 2048, repeat('b', 64)),
  'P0001', 'document_not_pending', 'nunca sobrescreve hash de documento pronto');
select ok((begin_case_document((:'opa')::uuid, (:'bruno')::uuid, E'C:\\fotos\\<img src=x onerror=alert(1)>matrícula\u202e.pdf', 'application/pdf', 2048,
  'f0000000-0000-0000-0000-000000000010'::uuid) ->> 'status') = 'ready',
  'repetição depois de pronto devolve o documento pronto (a tela só mostra o resultado)');

-- Documento pronto: o cancelamento é RECUSADO (a finalização venceu) e nada muda.
select throws_ok(format('select begin_case_document_abandon(%L, %L, %L)', :'d1', :'bruno', 'upload_interrupted'), 'P0001', 'document_not_pending',
  'documento já pronto: o cancelamento perde e não toca o arquivo');

-- Cancelamento em duas fases: a reserva (pendente → abandoning) vem ANTES de qualquer exclusão no Storage; a
-- linha só sai quando o objeto já não existe; o caminho continua vigiado enquanto o link de envio puder gravar.
select begin_case_document((:'opa')::uuid, (:'ana')::uuid, 'foto.png', 'image/png', 500, 'f0000000-0000-0000-0000-000000000011'::uuid) ->> 'document_id' as d2 \gset
reset role;
select pg_temp.subir((:'d2')::uuid, 500);
select pg_temp.t(format('select storage_path from public.case_documents where id = %L', :'d2')) as p2 \gset
set local role service_role;
select throws_ok(format('select begin_case_document_abandon(%L, %L, %L)', :'d2', :'bruno', 'x'), 'P0001', 'document_not_found', 'só quem iniciou cancela');
select is(begin_case_document_abandon((:'d2')::uuid, (:'ana')::uuid, 'case_document_content_invalid') ->> 'status', 'abandoning',
  'o cancelamento reserva a transição no banco');
select ok((begin_case_document_abandon((:'d2')::uuid, (:'ana')::uuid, 'outro') ->> 'replayed')::boolean, 'repetir a reserva é idempotente');
select throws_ok(format('select finalize_case_document(%L, %L, %L, %s, %L)', :'d2', :'ana', 'image/png', 500, :'sha'), 'P0001', 'document_not_pending',
  'reservado para cancelamento: a finalização perde (vencedor único)');
select throws_ok(format('select begin_case_document(%L, %L, %L, %L, %s, %L)', :'opa', :'ana', 'foto.png', 'image/png', 500, 'f0000000-0000-0000-0000-000000000011'),
  'P0001', 'document_not_pending', 'repetir o begin com o cancelamento reservado não emite link novo');
select throws_ok(format('select finalize_case_document_abandon(%L, %L)', :'d2', :'ana'), 'P0001', 'storage_object_still_present',
  'enquanto o objeto existe no Storage, a linha reservada não sai');
reset role;
select pg_temp.apagar_objeto((:'d2')::uuid);
set local role service_role;
select ok(finalize_case_document_abandon((:'d2')::uuid, (:'ana')::uuid), 'objeto apagado: a linha reservada sai');
select ok(not finalize_case_document_abandon((:'d2')::uuid, (:'ana')::uuid), 'concluir de novo é inofensivo');
select is(begin_case_document_abandon((:'d2')::uuid, (:'ana')::uuid, 'x') ->> 'status', 'absent', 'cancelar de novo é inofensivo (resposta perdida)');
reset role;
select ok(pg_temp.n(format($q$select count(*) from public.case_document_storage_cleanup where storage_path = %L and reason = 'envio_abandonado'
    and watch_until > clock_timestamp() + interval '2 hours 50 minutes'$q$, :'p2')) = 1,
  'sem objeto, mas com link de envio ainda válido: o caminho fica vigiado na fila até a janela fechar');
-- Envio atrasado com o link ainda válido (o Storage aceita: o link não é revogável): o objeto volta e está rastreado.
insert into storage.objects (bucket_id, name, metadata) values ('case-documents', :'p2', jsonb_build_object('size', 500, 'mimetype', 'image/png'));
select ok(pg_temp.n(format($q$select count(*) from public.case_document_storage_cleanup where storage_path = %L$q$, :'p2')) = 1,
  'o objeto gravado depois do cancelamento continua rastreado (nunca órfão)');
select is(pg_temp.n($q$select count(*) from public.audit_logs where action = 'case_document.upload_failed' and metadata ->> 'error_code' = 'case_document_content_invalid'$q$),
  1::bigint, 'falha do envio auditada com código fechado');

-- =====================================================================
-- 4) Leitura: o documento é do caso; dois casos do mesmo contato não se misturam
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'elisa'::uuid);
select is((select jsonb_array_length(list_case_documents((:'opa')::uuid) -> 'items')), 1, 'visualizador lê os documentos do caso A');
select is((select jsonb_array_length(list_case_documents((:'opb')::uuid) -> 'items')), 0, 'o caso B do MESMO contato não mostra o documento do caso A');
select ok((select list_case_documents((:'opa')::uuid) -> 'items' -> 0 ->> 'name') = '<img src=x onerror=alert(1)>matrícula.pdf'
  and (select list_case_documents((:'opa')::uuid) -> 'items' -> 0 ->> 'review_status') = 'recebido'
  and (select list_case_documents((:'opa')::uuid) -> 'items' -> 0) ? 'uploaded_by_name'
  and not ((select list_case_documents((:'opa')::uuid) -> 'items' -> 0) ? 'storage_path'),
  'item: nome, situação "recebido", autor — sem caminho do Storage');
select ok((get_case_document_for_download((:'d1')::uuid) ->> 'storagePath') is not null, 'visualizador obtém o caminho para o link temporário');
select pg_temp.login(:'carla'::uuid);
select throws_ok(format('select list_case_documents(%L)', :'opa'), 'P0001', 'opportunity_not_found', 'advogada fora do alcance não lista');
select throws_ok(format('select get_case_document_for_download(%L)', :'d1'), 'P0001', 'document_not_found', 'nem abre o documento fora do alcance');
select pg_temp.login(:'ana'::uuid);
select throws_ok(format('select get_pending_case_document(%L)', :'d1'), 'P0001', 'document_not_found', 'o caminho do envio só é lido pelo próprio autor (owner não lê o de outra pessoa)');
select pg_temp.login(:'bruno'::uuid);
select ok((get_pending_case_document((:'d1')::uuid) ->> 'storagePath') = :'ws_um' || '/' || :'opa' || '/' || :'d1', 'o autor lê o caminho gerado pelo banco');
reset role;

-- Janela do link de envio: conta da emissão MAIS RECENTE (repetição do begin) e só cresce.
set local role service_role;
select begin_case_document((:'opa')::uuid, (:'ana')::uuid, 'janela.pdf', 'application/pdf', 100, 'f0000000-0000-0000-0000-000000000014'::uuid) ->> 'document_id' as d5 \gset
reset role;
alter table public.case_documents disable trigger case_documents_guard;
update public.case_documents set created_at = clock_timestamp() - interval '4 hours', upload_window_until = clock_timestamp() - interval '1 hour'
where id = (:'d5')::uuid;
alter table public.case_documents enable trigger case_documents_guard;
set local role service_role;
select begin_case_document((:'opa')::uuid, (:'ana')::uuid, 'janela.pdf', 'application/pdf', 100, 'f0000000-0000-0000-0000-000000000014'::uuid) ->> 'status' as st5 \gset
reset role;
select ok(:'st5' = 'pending' and pg_temp.n(format($q$select count(*) from public.case_documents where id = %L
    and upload_window_until > clock_timestamp() + interval '2 hours 50 minutes'$q$, :'d5')) = 1,
  'repetir o begin (link novo) estende a janela a partir de agora, não de created_at');
select throws_ok(format($q$update public.case_documents set upload_window_until = upload_window_until - interval '1 minute' where id = %L$q$, :'d5'),
  'P0001', 'case_document_immutable', 'a janela do link nunca encolhe');
select throws_ok(format($q$update public.case_documents set upload_window_until = upload_window_until + interval '1 minute' where id = %L$q$, :'d1'),
  'P0001', 'case_document_immutable', 'documento pronto não ganha janela nova');

-- =====================================================================
-- 5) Conferência humana com versão
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'bruno'::uuid);
select throws_ok(format('select set_case_document_review(%L, %L, %L, %s)', :'d1', 'conferido', '', 0), 'P0001', 'insufficient_permission', 'sales não confere');
select pg_temp.login(:'elisa'::uuid);
select throws_ok(format('select set_case_document_review(%L, %L, %L, %s)', :'d1', 'conferido', '', 0), 'P0001', 'insufficient_permission', 'visualizador não confere');
select pg_temp.login(:'daniel'::uuid);
select throws_ok(format('select set_case_document_review(%L, %L, %L, %s)', :'d1', 'com_pendencia', '   ', 0), 'P0001', 'case_document_note_required', 'pendência exige observação');
select ok((set_case_document_review((:'d1')::uuid, 'com_pendencia', E'Falta a página 2\r\nda matrícula', 0) ->> 'review_version')::int = 1,
  'manager registra a pendência (versão 0 → 1)');
select pg_temp.login(:'ana'::uuid);
select throws_ok(format('select set_case_document_review(%L, %L, %L, %s)', :'d1', 'conferido', '', 0), 'P0001', 'case_document_review_conflict',
  'conferência com versão velha: conflito, nunca sobrescreve a do outro em silêncio');
select ok((select (r ->> 'review_status') = 'conferido' and (r ->> 'reviewed_by_name') is not null and (r ->> 'reviewed_at') is not null
  from (select set_case_document_review((:'d1')::uuid, 'conferido', '', 1) as r) x), 'com a versão atual: conferido, com quem e quando');
reset role;
select ok(pg_temp.t(format('select review_note from public.case_documents where id = %L', :'d1')) is null
  and pg_temp.n($q$select count(*) from public.audit_logs where action = 'case_document.reviewed' and metadata::text like '%matrícula%'$q$) = 0,
  'a observação da pendência não vai para a auditoria');

-- =====================================================================
-- 6) Nada muda além do documento
-- =====================================================================

select is(pg_temp.lado((:'ws_um')::uuid), :'lado0', 'enviar, abandonar e conferir não tocam trilhas, roteiro, etapa, vínculo, mensagens, observações, automações nem filas');

-- =====================================================================
-- 7) Remoção controlada em duas fases
-- =====================================================================

set local role service_role;
select throws_ok(format('select begin_case_document_removal(%L, %L, %L)', :'d1', :'bruno', 'duplicado'), 'P0001', 'insufficient_permission', 'sales não remove');
select throws_ok(format('select begin_case_document_removal(%L, %L, %L)', :'d1', :'ana', 'porque sim'), 'P0001', 'invalid_request', 'motivo fora da lista fechada recusado');
select ok((begin_case_document_removal((:'d1')::uuid, (:'ana')::uuid, 'duplicado') ->> 'replayed')::boolean = false, 'owner inicia a remoção');
select ok((begin_case_document_removal((:'d1')::uuid, (:'ana')::uuid, 'outro') ->> 'replayed')::boolean, 'retomar a remoção é idempotente (motivo original mantido)');
reset role;
select is(pg_temp.t(format('select removal_reason from public.case_documents where id = %L', :'d1')), 'duplicado', 'o motivo original fica');
set local role authenticated;
select pg_temp.login(:'elisa'::uuid);
select throws_ok(format('select get_case_document_for_download(%L)', :'d1'), 'P0001', 'document_not_found', 'em remoção, o documento não abre mais');
select is((select list_case_documents((:'opa')::uuid) -> 'items' -> 0 ->> 'status'), 'removing', 'a lista mostra a remoção pendente (nada some em silêncio)');
reset role;
set local role service_role;
select throws_ok(format('select finalize_case_document_removal(%L, %L)', :'d1', :'ana'), 'P0001', 'storage_object_still_present',
  'enquanto o arquivo existe no Storage, o registro não é apagado');
reset role;
select pg_temp.apagar_objeto((:'d1')::uuid);
set local role service_role;
select ok(finalize_case_document_removal((:'d1')::uuid, (:'ana')::uuid), 'arquivo saiu: o registro é apagado');
reset role;
select ok(pg_temp.n(format('select count(*) from public.case_documents where id = %L', :'d1')) = 0
  and pg_temp.n(format($q$select count(*) from public.case_document_storage_cleanup where document_id = %L and reason = 'remocao'
      and watch_until > clock_timestamp()$q$, :'d1')) = 1,
  'remoção concluída logo depois do envio: sem linha, mas o caminho fica vigiado enquanto o link de envio puder gravar');
select ok(pg_temp.n($q$select count(*) from public.audit_logs where action = 'case_document.removed' and metadata ->> 'reason' = 'duplicado' and metadata::text not like '%matr%'$q$) = 1,
  'remoção auditada com o motivo e sem o nome do arquivo');

-- =====================================================================
-- 8) Limpeza: envios cuja janela do link fechou, cancelamentos interrompidos e a fila
-- =====================================================================

set local role service_role;
select begin_case_document((:'opb')::uuid, (:'ana')::uuid, 'velho.pdf', 'application/pdf', 100, 'f0000000-0000-0000-0000-000000000012'::uuid) ->> 'document_id' as d3 \gset
reset role;
select pg_temp.subir((:'d3')::uuid, 100);
alter table public.case_documents disable trigger case_documents_guard;
update public.case_documents set created_at = clock_timestamp() - interval '4 hours', upload_window_until = clock_timestamp() - interval '1 hour'
where id = (:'d3')::uuid;
-- d5: criado há 4 horas, mas com link emitido agora (janela aberta) — não pode sair.
alter table public.case_documents enable trigger case_documents_guard;
set local role service_role;
select case_document_cleanup_claim(10) as claim \gset
reset role;
select ok(pg_temp.n(format('select count(*) from public.case_documents where id = %L', :'d3')) = 0
  and jsonb_array_length(:'claim'::jsonb -> 'objects') >= 2,
  'a limpeza tira o envio cuja janela do link fechou e devolve os objetos da fila (reservados)');
select ok(pg_temp.n(format('select count(*) from public.case_documents where id = %L and status = %L', :'d5', 'pending')) = 1,
  'envio antigo com link renovado (janela aberta) não sai na limpeza');
select id as q2 from public.case_document_storage_cleanup where storage_path = :'p2' \gset
set local role service_role;
select is((select jsonb_array_length(case_document_cleanup_claim(10) -> 'objects')), 0, 'outro processador não pega o que já está reservado');
select ok(not case_document_cleanup_complete((:'q2')::uuid), 'objeto ainda no Storage: continua na fila');
reset role;
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'case-documents' and name = :'p2';
set local role service_role;
select ok(not case_document_cleanup_complete((:'q2')::uuid), 'objeto apagado, mas o link ainda pode gravar: continua vigiado');
reset role;
select ok(pg_temp.n(format($q$select count(*) from public.case_document_storage_cleanup where id = %L
    and claimed_until between clock_timestamp() + interval '9 minutes' and clock_timestamp() + interval '11 minutes'$q$, :'q2')) = 1,
  'nova conferência marcada para até 10 minutos (envio atrasado é apagado logo)');
update public.case_document_storage_cleanup set watch_until = clock_timestamp() - interval '1 second' where id = (:'q2')::uuid;
set local role service_role;
select ok(case_document_cleanup_complete((:'q2')::uuid), 'objeto ausente e janela fechada: sai da fila');
reset role;

-- Cancelamento interrompido (objeto não saiu na hora): a limpeza o devolve para concluir.
set local role service_role;
select begin_case_document((:'opb')::uuid, (:'ana')::uuid, 'interrompido.pdf', 'application/pdf', 100, 'f0000000-0000-0000-0000-000000000015'::uuid) ->> 'document_id' as d6 \gset
select begin_case_document_abandon((:'d6')::uuid, (:'ana')::uuid, 'upload_interrupted');
reset role;
update public.case_documents set abandoned_at = clock_timestamp() - interval '3 minutes' where id = (:'d6')::uuid;
set local role service_role;
select ok((select bool_or(e ->> 'document_id' = :'d6') from jsonb_array_elements(case_document_cleanup_claim(10) -> 'abandons') e),
  'cancelamento reservado há mais de 2 minutos volta na limpeza para ser concluído');
select ok(finalize_case_document_abandon((:'d6')::uuid, null), 'a limpeza conclui o cancelamento (objeto nunca chegou)');
reset role;

-- Exclusão administrativa em cascata: o caminho do objeto vai para a fila (linha sem FK sobrevive).
set local role service_role;
select begin_case_document((:'opa')::uuid, (:'ana')::uuid, 'cascata.jpg', 'image/jpeg', 300, 'f0000000-0000-0000-0000-000000000013'::uuid) ->> 'document_id' as d4 \gset
reset role;
select pg_temp.subir((:'d4')::uuid, 300);
set local role service_role;
select lives_ok(format('select finalize_case_document(%L, %L, %L, %s, %L)', :'d4', :'ana', 'image/jpeg', 300, :'sha'), 'documento pronto no caso A');
reset role;

-- =====================================================================
-- 9) Privacidade
-- =====================================================================

select private.privacy_export_payload((:'ws_um')::uuid, (:'co')::uuid) as pacote \gset
select ok((select bool_and((e ->> 'file_content_included')::boolean = false and e ? 'name' and not (e ? 'storage_path') and not (e ? 'review_note'))
  from jsonb_array_elements(:'pacote'::jsonb -> 'case_documents') e)
  and jsonb_array_length(:'pacote'::jsonb -> 'case_documents') = 2,
  'exportação do titular: só os metadados (pronto e envio pendente), sem conteúdo, caminho nem observação interna');
select is(pg_temp.t(format($q$select private.privacy_retention_assess(%L, %L) -> 'reasons'$q$, :'ws_um', :'co'))::jsonb ? 'case_document_present', true,
  'avaliação da anonimização bloqueia com case_document_present');
select throws_ok(format('update public.contacts set anonymized_at = now() where id = %L', :'co'), 'P0001', 'case_document_present',
  'defesa em profundidade: a marca de anonimizado nunca é gravada com documento de caso');

select lives_ok(format('delete from public.opportunities where id = %L', :'opa'), 'exclusão administrativa do caso leva o documento em cascata');
select is(pg_temp.n($q$select count(*) from public.case_document_storage_cleanup where reason = 'exclusao'$q$), 1::bigint,
  'o arquivo do documento excluído em cascata entrou na fila de limpeza');

update public.case_document_upload_gate set enabled = false, backup_activation_ref = null;
select is((select enabled from public.case_document_upload_gate), false, 'portão fechado de novo ao fim do teste');

select * from finish();
rollback;
