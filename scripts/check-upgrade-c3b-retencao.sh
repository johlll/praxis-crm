#!/usr/bin/env bash
# C3b — valida a ATUALIZAÇÃO para a retenção de 12 meses a partir da versão
# anterior, com leads gravados ANTES da migration:
#
#   1. recria o banco local só até a migration da C3a;
#   2. cria um contato cujo único lead foi arquivado há muito tempo (updated_at
#      antigo), um contato com lead arquivado e outro ativo, e guarda o
#      updated_at de cada lead;
#   3. aplica a migration pendente;
#   4. confere:
#      - o lead que já estava arquivado passa a ter marco = o momento da
#        migration (a contagem dos 12 meses COMEÇA ali), e o ativo fica sem marco;
#      - nenhum updated_at mudou;
#      - o contato arquivado antigo NÃO ficou vencido por inferência: a prévia
#        devolve retention_period_open e o lote não anonimiza ninguém;
#      - arquivar e reativar um lead depois da migration grava e limpa o marco.
#
# Roda por último no CI: termina com o banco local na versão atual. Tudo
# fictício.
set -euo pipefail

PREVIOUS_VERSION="20261112120000"
DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
WS_UM="10000000-0000-0000-0000-000000000001"
CONTATO_ANTIGO="77000000-0000-0000-0000-000000000001"
CONTATO_MISTO="77000000-0000-0000-0000-000000000002"
LEAD_ANTIGO="77000000-0000-0000-0000-0000000000a1"
LEAD_MISTO_ARQ="77000000-0000-0000-0000-0000000000a2"
LEAD_MISTO_ATIVO="77000000-0000-0000-0000-0000000000a3"

psql_db() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

echo "== 1. banco na versão anterior ($PREVIOUS_VERSION)"
supabase db reset --local --version "$PREVIOUS_VERSION"

echo "== 2. leads arquivados pela versão anterior"
psql_db <<SQL
insert into public.contacts (id, workspace_id, type, name, created_by) values
  ('$CONTATO_ANTIGO', '$WS_UM', 'pf', 'Antigo arquivado (upgrade C3b)', '$ANA'),
  ('$CONTATO_MISTO', '$WS_UM', 'pf', 'Misto (upgrade C3b)', '$ANA');
insert into public.leads (id, workspace_id, contact_id, legal_area, status, created_by, created_at, updated_at) values
  ('$LEAD_ANTIGO', '$WS_UM', '$CONTATO_ANTIGO', 'Área', 'arquivado', '$ANA', now() - interval '3 years', now() - interval '2 years'),
  ('$LEAD_MISTO_ARQ', '$WS_UM', '$CONTATO_MISTO', 'Área', 'arquivado', '$ANA', now() - interval '3 years', now() - interval '2 years');
insert into public.leads (id, workspace_id, contact_id, legal_area, status, created_by) values
  ('$LEAD_MISTO_ATIVO', '$WS_UM', '$CONTATO_MISTO', 'Área', 'ativo', '$ANA');

create table public.upgrade_check_snapshot as
select id, updated_at from public.leads where id in ('$LEAD_ANTIGO', '$LEAD_MISTO_ARQ', '$LEAD_MISTO_ATIVO');
SQL

echo "== 3. migration pendente"
supabase migration up --local

echo "== 4. conferências"
psql_db <<SQL
do \$check\$
declare
  v_marco timestamptz;
  v_changed integer;
  v_reasons jsonb;
  v_lote jsonb;
begin
  select archived_at into v_marco from public.leads where id = '$LEAD_ANTIGO';
  if v_marco is null or v_marco < now() - interval '30 minutes' or v_marco > now() then
    raise exception 'o lead já arquivado deveria receber marco = momento da migration, veio %', v_marco;
  end if;
  if exists (select 1 from public.leads where id = '$LEAD_MISTO_ATIVO' and archived_at is not null) then
    raise exception 'lead ativo não pode ter marco';
  end if;

  select count(*) into v_changed
  from public.upgrade_check_snapshot s
  join public.leads l on l.id = s.id
  where l.updated_at is distinct from s.updated_at;
  if v_changed <> 0 then
    raise exception '% lead(s) tiveram updated_at alterado pela atualização', v_changed;
  end if;

  -- Não vencido por inferência retroativa: prévia (como service_role) e lote.
  select public.get_privacy_retention_status('$ANA'::uuid, '$WS_UM'::uuid, '$CONTATO_ANTIGO'::uuid) -> 'reasons' into v_reasons;
  if v_reasons is distinct from '["retention_period_open"]'::jsonb then
    raise exception 'o contato arquivado antes da migration deveria estar em retention_period_open, veio %', v_reasons;
  end if;
  select public.get_privacy_retention_status('$ANA'::uuid, '$WS_UM'::uuid, '$CONTATO_MISTO'::uuid) -> 'reasons' into v_reasons;
  if v_reasons is distinct from '["active_lead"]'::jsonb then
    raise exception 'o contato com lead ativo deveria estar em active_lead, veio %', v_reasons;
  end if;
  select public.run_privacy_retention_batch(50) into v_lote;
  if (v_lote ->> 'processed')::int <> 0 or (v_lote ->> 'failed')::int <> 0 then
    raise exception 'o lote não deveria anonimizar nem falhar logo após a migration: %', v_lote;
  end if;
  if exists (select 1 from public.contacts where id in ('$CONTATO_ANTIGO', '$CONTATO_MISTO') and anonymized_at is not null) then
    raise exception 'nenhum contato antigo pode ter sido anonimizado';
  end if;

  -- O gatilho segue valendo depois da migration: reativar limpa e arquivar grava.
  update public.leads set status = 'ativo' where id = '$LEAD_ANTIGO';
  if (select archived_at from public.leads where id = '$LEAD_ANTIGO') is not null then
    raise exception 'reativar deveria limpar o marco';
  end if;
  update public.leads set status = 'arquivado' where id = '$LEAD_ANTIGO';
  if (select archived_at from public.leads where id = '$LEAD_ANTIGO') is null then
    raise exception 'arquivar deveria gravar o marco';
  end if;
end;
\$check\$;

drop table public.upgrade_check_snapshot;
SQL

echo "OK: a atualização iniciou a contagem dos 12 meses na migration, sem vencer ninguém por inferência."
