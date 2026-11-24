#!/usr/bin/env bash
# Documentos por caso — valida a ATUALIZAÇÃO a partir da versão publicada (observações por caso, #361), com casos,
# observações, PDF de proposta e exportação gravados ANTES da migration:
#
#   1. recria o banco local só até a migration das observações (20261122120000);
#   2. grava um contato com dois casos (um ganho, um perdido), uma observação, uma proposta com PDF pronto e o
#      objeto dele no Storage, e guarda a exportação do titular e a avaliação de anonimização de outro contato;
#   3. aplica a migration pendente;
#   4. confere:
#      - nenhum documento de caso foi criado, migrado nem associado por inferência (o PDF da proposta continua só
#        da proposta, no bucket dela);
#      - o portão de recebimento nasce FECHADO e o bucket novo é privado;
#      - a exportação devolve EXATAMENTE o mesmo em todas as seções antigas; a seção nova existe e está vazia;
#      - a avaliação de anonimização devolve o mesmo para quem não tem documento;
#      - nenhuma linha de negócio foi alterada (contatos, leads, oportunidades, observações, propostas e seus
#        documentos, objetos do Storage, trilhas, auditoria);
#      - depois da atualização, um documento de caso bloqueia a anonimização com `case_document_present`.
#
# Recria o banco local, por isso roda no fim e termina na versão atual. Tudo fictício.
set -euo pipefail

PREVIOUS_VERSION="20261122120000"
DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
WS_UM="10000000-0000-0000-0000-000000000001"
CONTATO="7d000000-0000-0000-0000-000000000001"
LEAD="7d000000-0000-0000-0000-0000000000a1"
OPP_GANHA="7d000000-0000-0000-0000-0000000000b1"
OPP_PERDIDA="7d000000-0000-0000-0000-0000000000b2"
CONTATO_P="7d000000-0000-0000-0000-000000000002"
LEAD_P="7d000000-0000-0000-0000-0000000000a2"
OPP_P="7d000000-0000-0000-0000-0000000000b3"

psql_db() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

echo "== 1. banco na versão anterior ($PREVIOUS_VERSION)"
supabase db reset --local --version "$PREVIOUS_VERSION"

echo "== 2. casos, observação, proposta com PDF e objeto no Storage gravados pela versão anterior"
psql_db <<SQL
insert into public.contacts (id, workspace_id, type, name, created_by) values
  ('$CONTATO', '$WS_UM', 'pf', 'Contato (upgrade documentos)', '$ANA'),
  ('$CONTATO_P', '$WS_UM', 'pf', 'Contato arquivado (upgrade documentos)', '$ANA');
insert into public.leads (id, workspace_id, contact_id, legal_area, status, created_by, assigned_to) values
  ('$LEAD', '$WS_UM', '$CONTATO', 'Usucapião', 'ativo', '$ANA', null),
  ('$LEAD_P', '$WS_UM', '$CONTATO_P', 'Trabalhista', 'ativo', '$ANA', null);
insert into public.opportunities (id, workspace_id, lead_id, pipeline_id, stage_id, created_by)
select v.id, '$WS_UM', v.lead, p.id,
  (select s.id from public.pipeline_stages s where s.pipeline_id = p.id and not s.is_won and not s.is_lost order by s.position limit 1),
  '$ANA'
from public.pipelines p
cross join (values ('$OPP_GANHA'::uuid, '$LEAD'::uuid), ('$OPP_PERDIDA'::uuid, '$LEAD'::uuid), ('$OPP_P'::uuid, '$LEAD_P'::uuid)) v(id, lead)
where p.workspace_id = '$WS_UM' and p.is_default;

do \$seed\$
declare
  v_prop uuid;
  v_doc record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
  perform public.win_opportunity('$OPP_GANHA', 0, 150000, 'fixed');
  perform public.add_case_note('$OPP_GANHA', 'Observação gravada ANTES', gen_random_uuid());
  v_prop := public.create_proposal('$OPP_GANHA', 150000, 'fixed');
  select * into v_doc from public.begin_proposal_document(v_prop, '$ANA');
  insert into storage.objects (bucket_id, name, metadata) values ('proposal-documents', v_doc.storage_path, jsonb_build_object('size', 4321));
  perform public.finalize_proposal_document(v_doc.document_id, repeat('d', 64), 4321, '$ANA');
end
\$seed\$;
update public.opportunities set status = 'lost', lost_reason_id = (select id from public.lost_reasons where workspace_id = '$WS_UM' order by position limit 1)
where id in ('$OPP_PERDIDA', '$OPP_P');

create table public.doc_upgrade_before as
  select 'export' as k, private.privacy_export_payload('$WS_UM', '$CONTATO') as body
  union all select 'assess_p', private.privacy_retention_assess('$WS_UM', '$CONTATO_P');
create table public.doc_upgrade_rows as
  select 'contacts' as t, md5(string_agg(x::text, '|' order by x.id)) as h from public.contacts x
  union all select 'leads', md5(string_agg(x::text, '|' order by x.id)) from public.leads x
  union all select 'opportunities', md5(string_agg(x::text, '|' order by x.id)) from public.opportunities x
  union all select 'case_notes', md5(string_agg(x::text, '|' order by x.id)) from public.case_notes x
  union all select 'proposals', md5(string_agg(x::text, '|' order by x.id)) from public.proposals x
  union all select 'proposal_documents', md5(string_agg(x::text, '|' order by x.id)) from public.proposal_documents x
  union all select 'storage_objects', md5(string_agg(x.bucket_id || x.name || coalesce(x.metadata::text, ''), '|' order by x.bucket_id, x.name)) from storage.objects x
  union all select 'status_tracks', md5(string_agg(x::text, '|' order by x.id)) from public.status_tracks x
  union all select 'audit_logs', md5(string_agg(x::text, '|' order by x.id)) from public.audit_logs x;
SQL

echo "== 3. migration pendente"
supabase migration up --local

echo "== 4. conferências"
psql_db <<SQL
do \$check\$
declare
  v_diff integer;
  v_after jsonb;
begin
  if (select count(*) from public.case_documents) <> 0 or (select count(*) from public.case_document_storage_cleanup) <> 0 then
    raise exception 'a migration não pode criar, migrar nem associar documentos de caso';
  end if;
  if (select enabled from public.case_document_upload_gate) then
    raise exception 'o portão de recebimento deveria nascer FECHADO';
  end if;
  if not exists (select 1 from storage.buckets where id = 'case-documents' and not public and file_size_limit = 10485760) then
    raise exception 'o bucket case-documents deveria existir privado, com 10 MiB';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'case-documents') then
    raise exception 'nenhum objeto pode ir para o bucket novo na atualização';
  end if;

  -- Exportação: seções antigas byte a byte; a nova existe e está vazia.
  v_after := private.privacy_export_payload('$WS_UM', '$CONTATO');
  if (v_after - 'case_documents') is distinct from (select body from public.doc_upgrade_before where k = 'export') then
    raise exception 'a exportação mudou nas seções antigas';
  end if;
  if v_after -> 'case_documents' is distinct from '[]'::jsonb then
    raise exception 'a seção case_documents deveria existir vazia para o titular antigo';
  end if;
  if jsonb_array_length(v_after -> 'proposal_documents') <> 1 then
    raise exception 'o PDF da proposta deveria seguir na seção dele, como antes';
  end if;

  -- Avaliação de anonimização: igual para quem não tem documento de caso.
  if private.privacy_retention_assess('$WS_UM', '$CONTATO_P') is distinct from (select body from public.doc_upgrade_before where k = 'assess_p') then
    raise exception 'a avaliação de anonimização mudou para um contato sem documento de caso';
  end if;

  -- Nenhuma linha antiga alterada.
  select count(*) into v_diff from (
    select 'contacts' as t, md5(string_agg(x::text, '|' order by x.id)) as h from public.contacts x
    union all select 'leads', md5(string_agg(x::text, '|' order by x.id)) from public.leads x
    union all select 'opportunities', md5(string_agg(x::text, '|' order by x.id)) from public.opportunities x
    union all select 'case_notes', md5(string_agg(x::text, '|' order by x.id)) from public.case_notes x
    union all select 'proposals', md5(string_agg(x::text, '|' order by x.id)) from public.proposals x
    union all select 'proposal_documents', md5(string_agg(x::text, '|' order by x.id)) from public.proposal_documents x
    union all select 'storage_objects', md5(string_agg(x.bucket_id || x.name || coalesce(x.metadata::text, ''), '|' order by x.bucket_id, x.name)) from storage.objects x
    union all select 'status_tracks', md5(string_agg(x::text, '|' order by x.id)) from public.status_tracks x
    union all select 'audit_logs', md5(string_agg(x::text, '|' order by x.id)) from public.audit_logs x
  ) d join public.doc_upgrade_rows r using (t)
  where d.h is distinct from r.h;
  if v_diff <> 0 then
    raise exception 'a atualização alterou % tabela(s) de negócio', v_diff;
  end if;
end
\$check\$;

-- Depois da atualização: um documento no caso perdido do contato P bloqueia a anonimização dele.
do \$after\$
declare
  v_doc uuid := gen_random_uuid();
begin
  insert into public.case_documents (id, workspace_id, opportunity_id, status, original_name, declared_type, declared_size,
    content_type, byte_size, checksum_sha256, storage_path, uploaded_by, finalized_at, idempotency_key, request_fingerprint)
  values (v_doc, '$WS_UM', '$OPP_P', 'ready', 'depois.pdf', 'application/pdf', 10, 'application/pdf', 10, repeat('e', 64),
    '$WS_UM' || '/' || '$OPP_P' || '/' || v_doc, '$ANA', now(), gen_random_uuid(), 'x');
  if not (private.privacy_retention_assess('$WS_UM', '$CONTATO_P') -> 'reasons') ? 'case_document_present' then
    raise exception 'com documento de caso, a avaliação deveria bloquear com case_document_present';
  end if;
end
\$after\$;

drop table public.doc_upgrade_before;
drop table public.doc_upgrade_rows;
SQL

echo "OK: nenhum documento criado nem migrado; portão fechado; bucket privado; exportação e avaliação iguais nas partes antigas; nada alterado; documento novo bloqueia a anonimização"
