-- pgTAP — estabilização pós-A9: numeração de propostas por contador
-- (docs/decisoes/estabilizacao-pos-a9.md §4).
--
-- Concorrência real (duas transações disputando o contador) não cabe numa
-- única conexão pgTAP: está em scripts/a9-proposal-number-concurrency-check.mjs.
-- A atualização a partir da versão anterior, com dados reais, está em
-- scripts/check-upgrade-proposal-counter.sh. Aqui ficam as regras que uma
-- conexão só consegue provar.

begin;
select plan(7);

\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ana     '20000000-0000-0000-0000-000000000001'
\set bruno   '20000000-0000-0000-0000-000000000002'

select extract(year from now())::int as ano \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato contador', null, null, null)).id as contact_um \gset
select create_lead(:'ws_um'::uuid, (:'contact_um')::uuid, 'Contador', 'Lead contador', '{}'::text[], 'media', null) as lead_um \gset
select create_opportunity(:'lead_um'::uuid) as opp_um \gset
select create_proposal(:'opp_um'::uuid, 1000, 'fixed') as p1 \gset
reset role;

select is(
  (select number from public.proposals where id = :'p1'::uuid),
  'PROP-' || :'ano' || '-0001',
  'Primeira proposta do workspace no ano recebe 0001'
);

-- Contador atrasado em relação a um número já existente (ex.: linha gravada
-- por fora): a próxima alocação nunca reaproveita um número emitido.
insert into public.proposals (workspace_id, lead_id, opportunity_id, number, value_cents, fee_model, created_by)
select workspace_id, lead_id, opportunity_id, 'PROP-' || :'ano' || '-0050', 1000, fee_model, created_by
from public.proposals where id = :'p1'::uuid;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_proposal(:'opp_um'::uuid, 1000, 'fixed') as p2 \gset
reset role;

select is(
  (select number from public.proposals where id = :'p2'::uuid),
  'PROP-' || :'ano' || '-0051',
  'Contador atrasado não reaproveita número: continua depois do maior emitido (0050)'
);
select is(
  (select last_value from private.proposal_number_counters where workspace_id = :'ws_um'::uuid and year = :'ano'::int),
  51,
  'Contador fica registrado no último valor alocado'
);

-- Acima de 9999 o número cresce em dígitos, sem truncar (lpad antigo cortava).
update private.proposal_number_counters set last_value = 9999
where workspace_id = :'ws_um'::uuid and year = :'ano'::int;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_proposal(:'opp_um'::uuid, 1000, 'fixed') as p3 \gset
select create_proposal(:'opp_um'::uuid, 1000, 'fixed') as p4 \gset
reset role;

select is(
  (select number from public.proposals where id = :'p3'::uuid),
  'PROP-' || :'ano' || '-10000',
  'Sequencial 10000 não é truncado para 1000'
);
select is(
  (select number from public.proposals where id = :'p4'::uuid),
  'PROP-' || :'ano' || '-10001',
  'Sequencial seguinte continua em 10001'
);

-- Série própria por workspace.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato contador dois', null, null, null)).id as contact_dois \gset
select create_lead(:'ws_dois'::uuid, (:'contact_dois')::uuid, 'Contador', 'Lead contador dois', '{}'::text[], 'media', null) as lead_dois \gset
select create_opportunity(:'lead_dois'::uuid) as opp_dois \gset
select create_proposal(:'opp_dois'::uuid, 1000, 'fixed') as p_dois \gset
reset role;

select is(
  (select number from public.proposals where id = :'p_dois'::uuid),
  'PROP-' || :'ano' || '-0001',
  'Outro workspace começa a própria série em 0001, sem ser afetado pelo primeiro'
);

select is(
  (
    select count(*)::int from information_schema.role_table_grants
    where table_schema = 'private' and table_name = 'proposal_number_counters'
      and grantee in ('anon', 'authenticated')
  ),
  0,
  'Contador não tem nenhum privilégio para anon/authenticated'
);

select * from finish();
rollback;
