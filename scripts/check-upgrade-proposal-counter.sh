#!/usr/bin/env bash
# Estabilização pós-A9 (docs/decisoes/estabilizacao-pos-a9.md §4) — valida a
# ATUALIZAÇÃO a partir da versão anterior, não só a criação do banco do zero:
#
#   1. recria o banco local só até a migration anterior à do contador;
#   2. emite propostas com a numeração antiga (count(*)+1) e grava um número
#      legado fora de sequência (PROP-<ano>-0120), como dados reais de antes;
#   3. aplica as migrations pendentes (o contador + backfill);
#   4. confere que nenhum número mudou, que o contador começou do maior
#      número existente e que a próxima proposta não reaproveita nenhum.
#
# Roda por último no CI: termina com o banco local na versão atual.
set -euo pipefail

PREVIOUS_VERSION="20260915100000"
DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
WS_UM="10000000-0000-0000-0000-000000000001"

psql_db() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

echo "== 1. banco na versão anterior ($PREVIOUS_VERSION)"
supabase db reset --local --version "$PREVIOUS_VERSION"

echo "== 2. propostas emitidas com a numeração antiga"
psql_db <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select (create_contact('$WS_UM'::uuid, 'pf', 'Contato upgrade numeração', null, null, null)).id as contact_id \gset
select create_lead('$WS_UM'::uuid, :'contact_id'::uuid, 'Upgrade numeração', null, '{}'::text[], 'media', null) as lead_id \gset
select create_opportunity(:'lead_id'::uuid) as opp_id \gset
select create_proposal(:'opp_id'::uuid, 100000, 'fixed');
select create_proposal(:'opp_id'::uuid, 200000, 'fixed');
reset role;
-- Número legado fora de sequência, gravado como se viesse de antes.
insert into public.proposals (workspace_id, lead_id, opportunity_id, number, value_cents, fee_model, created_by)
select workspace_id, lead_id, opportunity_id, 'PROP-' || extract(year from now())::int || '-0120', 300000, fee_model, created_by
from public.proposals where opportunity_id = :'opp_id'::uuid limit 1;
commit;

create table public.upgrade_check_snapshot as
select id, number from public.proposals;
SQL

echo "== 3. migrations pendentes"
supabase migration up --local

echo "== 4. conferências"
psql_db <<SQL
do \$check\$
declare
  v_year integer := extract(year from now())::integer;
  v_counter integer;
  v_changed integer;
begin
  select last_value into v_counter
  from private.proposal_number_counters
  where workspace_id = '$WS_UM'::uuid and year = v_year;
  if v_counter is distinct from 120 then
    raise exception 'contador deveria começar em 120 (maior número existente), veio %', v_counter;
  end if;

  select count(*) into v_changed
  from public.upgrade_check_snapshot s
  left join public.proposals p on p.id = s.id and p.number = s.number
  where p.id is null;
  if v_changed <> 0 then
    raise exception '% número(s) já emitido(s) mudaram ou sumiram na atualização', v_changed;
  end if;
end;
\$check\$;

-- Lido como postgres: authenticated não tem acesso a estas tabelas (RLS).
select p.opportunity_id as opp_id
from public.upgrade_check_snapshot s join public.proposals p using (id)
limit 1 \gset

begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
select create_proposal(:'opp_id'::uuid, 400000, 'fixed') as new_id \gset
reset role;
commit;

-- Variáveis do psql não são expandidas dentro de blocos DO: passa por GUC.
select set_config('upgrade_check.new_id', :'new_id', false);

do \$check\$
declare
  v_number text;
begin
  select number into v_number from public.proposals
  where id = current_setting('upgrade_check.new_id')::uuid;
  if v_number is distinct from 'PROP-' || extract(year from now())::int || '-0121' then
    raise exception 'próxima proposta deveria ser -0121, veio %', v_number;
  end if;
end;
\$check\$;

drop table public.upgrade_check_snapshot;
SQL

echo "OK: atualização preservou os números emitidos e continuou a série sem reaproveitar números."
