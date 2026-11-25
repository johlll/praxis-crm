#!/usr/bin/env bash
# Observações por caso — valida a ATUALIZAÇÃO a partir da versão publicada (etapa B do painel, #360), com casos,
# notas gerais do lead, conversa e exportação gravados ANTES da migration:
#
#   1. recria o banco local só até a migration da etapa B (20261121120000);
#   2. grava um contato com dois casos (um ganho, um perdido), notas gerais do lead e uma conversa vinculada, e
#      guarda a exportação do titular, as notas do lead e o que o painel lê do caso;
#   3. aplica a migration pendente;
#   4. confere:
#      - nenhuma observação foi criada, migrada nem associada por inferência (as notas do lead continuam notas
#        do lead, intactas);
#      - a exportação devolve EXATAMENTE o mesmo em todas as seções antigas; a seção nova existe e está vazia;
#      - nenhuma linha de negócio foi alterada (contatos, leads, notas, oportunidades, conversas, trilhas,
#        roteiros, auditoria);
#      - a anonimização de um contato gravado ANTES continua funcionando como antes (notas do lead apagadas,
#        contato anonimizado) e agora também apaga observações acrescentadas depois da atualização.
#
# Recria o banco local, por isso roda no fim do CI e termina na versão atual. Tudo fictício.
set -euo pipefail

PREVIOUS_VERSION="20261121120000"
DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
WS_UM="10000000-0000-0000-0000-000000000001"
CONTATO="7a000000-0000-0000-0000-000000000001"
LEAD="7a000000-0000-0000-0000-0000000000a1"
OPP_GANHA="7a000000-0000-0000-0000-0000000000b1"
OPP_PERDIDA="7a000000-0000-0000-0000-0000000000b2"
CANAL="7a000000-0000-0000-0000-0000000000c1"
CONTATO_P="7a000000-0000-0000-0000-000000000002"
LEAD_P="7a000000-0000-0000-0000-0000000000a2"
OPP_P="7a000000-0000-0000-0000-0000000000b3"

psql_db() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

echo "== 1. banco na versão anterior ($PREVIOUS_VERSION)"
supabase db reset --local --version "$PREVIOUS_VERSION"

echo "== 2. casos, notas do lead e conversa gravados pela versão anterior"
psql_db <<SQL
insert into public.contacts (id, workspace_id, type, name, created_by) values
  ('$CONTATO', '$WS_UM', 'pf', 'Contato (upgrade observações)', '$ANA'),
  ('$CONTATO_P', '$WS_UM', 'pf', 'Contato a anonimizar (upgrade observações)', '$ANA');
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

insert into public.whatsapp_channels (id, workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key)
values ('$CANAL', '$WS_UM', 'Canal (upgrade observações)', '+5541900008000', '$ANA', 'ycloud', false, 'preview', 'rota-upgrade-observacoes');

do \$seed\$
declare v_ident uuid;
begin
  insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164)
  values ('$WS_UM', '$CANAL', 'ycloud', 'preview', '+5541999998001') returning id into v_ident;
  insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id, opportunity_id)
  values ('$WS_UM', '$CANAL', v_ident, '$CONTATO', '$LEAD', '$OPP_GANHA');

  perform set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
  perform public.win_opportunity('$OPP_GANHA', 0, 150000, 'fixed');
  perform public.create_lead_note('$LEAD', 'Nota geral do lead gravada ANTES (não é observação de caso)');
  perform public.create_lead_note('$LEAD_P', 'Nota do lead a anonimizar');
end
\$seed\$;
update public.opportunities set status = 'lost', lost_reason_id = (select id from public.lost_reasons where workspace_id = '$WS_UM' order by position limit 1)
where id in ('$OPP_PERDIDA', '$OPP_P');

create table public.obs_upgrade_before as
  select 'export' as k, private.privacy_export_payload('$WS_UM', '$CONTATO') as body
  union all select 'export_p', private.privacy_export_payload('$WS_UM', '$CONTATO_P');
create table public.obs_upgrade_rows as
  select 'contacts' as t, md5(string_agg(x::text, '|' order by x.id)) as h from public.contacts x
  union all select 'leads', md5(string_agg(x::text, '|' order by x.id)) from public.leads x
  union all select 'lead_notes', md5(string_agg(x::text, '|' order by x.id)) from public.lead_notes x
  union all select 'opportunities', md5(string_agg(x::text, '|' order by x.id)) from public.opportunities x
  union all select 'conversations', md5(string_agg(x::text, '|' order by x.id)) from public.conversations x
  union all select 'status_tracks', md5(string_agg(x::text, '|' order by x.id)) from public.status_tracks x
  union all select 'case_service_plans', md5(string_agg(x::text, '|' order by x.id)) from public.case_service_plans x
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
  if (select count(*) from public.case_notes) <> 0 then
    raise exception 'a migration não pode criar, migrar nem associar observações';
  end if;

  -- Exportação: seções antigas byte a byte; a nova existe e está vazia.
  v_after := private.privacy_export_payload('$WS_UM', '$CONTATO');
  -- `case_documents` vem de uma migration POSTERIOR (aplicada junto no migration up): fora da comparação.
  if (v_after - 'case_notes' - 'case_documents') is distinct from (select body from public.obs_upgrade_before where k = 'export') then
    raise exception 'a exportação mudou nas seções antigas';
  end if;
  if v_after -> 'case_notes' is distinct from '[]'::jsonb then
    raise exception 'a seção case_notes deveria existir vazia para o titular antigo';
  end if;
  if jsonb_array_length(v_after -> 'lead_notes') <> 1 or (v_after #> '{lead_notes,0}') ? 'body' then
    raise exception 'as notas do lead deveriam seguir na exportação como antes (existência, sem texto)';
  end if;

  -- Nenhuma linha antiga alterada.
  select count(*) into v_diff from (
    select 'contacts' as t, md5(string_agg(x::text, '|' order by x.id)) as h from public.contacts x
    union all select 'leads', md5(string_agg(x::text, '|' order by x.id)) from public.leads x
    union all select 'lead_notes', md5(string_agg(x::text, '|' order by x.id)) from public.lead_notes x
    union all select 'opportunities', md5(string_agg(x::text, '|' order by x.id)) from public.opportunities x
    union all select 'conversations', md5(string_agg(x::text, '|' order by x.id)) from public.conversations x
    union all select 'status_tracks', md5(string_agg(x::text, '|' order by x.id)) from public.status_tracks x
    union all select 'case_service_plans', md5(string_agg(x::text, '|' order by x.id)) from public.case_service_plans x
    union all select 'audit_logs', md5(string_agg(x::text, '|' order by x.id)) from public.audit_logs x
  ) d join public.obs_upgrade_rows r using (t)
  where d.h is distinct from r.h;
  if v_diff <> 0 then
    raise exception 'a atualização alterou % tabela(s) de negócio', v_diff;
  end if;
end
\$check\$;

-- Depois da atualização: observações no caso perdido do contato P; a anonimização dele apaga notas e observações.
do \$anon\$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
  perform public.add_case_note('$OPP_P', 'Observação com dado pessoal, depois da atualização', gen_random_uuid());
  perform public.add_case_note('$OPP_GANHA', 'Observação do caso ganho do contato que NÃO é anonimizado', gen_random_uuid());
  perform private.privacy_anonymize_contact('$WS_UM', '$CONTATO_P');
  if exists (select 1 from public.lead_notes where lead_id = '$LEAD_P')
     or exists (select 1 from public.case_notes where opportunity_id = '$OPP_P')
     or not exists (select 1 from public.contacts where id = '$CONTATO_P' and anonymized_at is not null) then
    raise exception 'a anonimização deveria apagar notas do lead e observações do caso e anonimizar o contato';
  end if;
  if (select count(*) from public.case_notes where opportunity_id = '$OPP_GANHA') <> 1 then
    raise exception 'a observação de outro contato não podia ser tocada';
  end if;
end
\$anon\$;

drop table public.obs_upgrade_before;
drop table public.obs_upgrade_rows;
SQL

echo "OK: nenhuma observação criada nem migrada; notas do lead intactas; exportação igual nas seções antigas; nada alterado; anonimização apaga também as observações"
