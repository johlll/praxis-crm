-- pgTAP — C3b (correção da revisão): o limite do lote vale para os candidatos AVALIADOS
-- (processados + bloqueados + falhos), e os que sobram ficam para a rodada seguinte.
--
-- Cenário: 55 contatos vencidos, mas bloqueados (cada um tem um cliente), e 3 contatos
-- vencidos e elegíveis. Nenhum outro candidato existe antes — o seed não tem lead vencido.

begin;
select plan(13);

\set ana    '20000000-0000-0000-0000-000000000001'
\set ws_um   '10000000-0000-0000-0000-000000000001'

create function pg_temp.n(p_sql text) returns bigint language plpgsql security definer as $f$
declare v bigint;
begin
  execute p_sql into v;
  return v;
end;
$f$;

-- Soma do que a rodada avaliou.
create function pg_temp.avaliados(p_r jsonb) returns integer language sql as $f$
  select (p_r ->> 'processed')::int + (p_r ->> 'blocked')::int + (p_r ->> 'failed')::int
$f$;

select pg_temp.n($q$select count(*) from public.contacts where anonymized_at is null$q$) as contatos_antes \gset

-- 55 bloqueados (cliente) e 3 elegíveis, todos com lead arquivado há 13 meses.
alter table public.leads disable trigger leads_retention_mark;
-- Ids escolhidos para a ordem: os 55 bloqueados vêm primeiro, os 3 elegíveis por último. Sem rotação,
-- uma rodada de 50 nunca chegaria aos elegíveis.
with novos as (
  insert into public.contacts (id, workspace_id, type, name, created_by)
  select case when g <= 55 then ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid
              else ('ffffffff-ffff-4fff-8fff-' || lpad(g::text, 12, '0'))::uuid end,
         :'ws_um'::uuid, 'pf', 'Lote ' || g, :'ana'::uuid from generate_series(1, 58) g
  returning id, name
), lds as (
  insert into public.leads (workspace_id, contact_id, legal_area, status, archived_at, created_by)
  select :'ws_um'::uuid, id, 'Área', 'arquivado', now() - interval '13 months', :'ana'::uuid from novos
  returning contact_id
)
insert into public.clients (workspace_id, contact_id, owner_user_id)
select :'ws_um'::uuid, n.id, :'ana'::uuid from novos n
where split_part(n.name, ' ', 2)::int <= 55;
alter table public.leads enable trigger leads_retention_mark;

select is(
  pg_temp.n($q$select count(*) from public.contacts where name like 'Lote %' and anonymized_at is null$q$),
  58::bigint,
  'preparo: 58 candidatos (55 bloqueados e 3 elegíveis)'
);

-- 12) Limite 50 com mais de 50 candidatos: avalia EXATAMENTE 50.
set local role service_role;
select run_privacy_retention_batch(50) as r1 \gset
reset role;
select is(pg_temp.avaliados(:'r1'::jsonb), 50, '12) lote 50 com 58 candidatos avalia exatamente 50');
select is((:'r1'::jsonb ->> 'blocked')::int, 50, '12) os bloqueados entram na conta: os 50 avaliados foram todos bloqueados');
select is(
  pg_temp.n($q$select count(*) from public.contacts where id::text like 'ffffffff%' and anonymized_at is not null$q$),
  0::bigint,
  '14) os 3 elegíveis ficaram para depois: a rodada 1 não chegou até eles'
);

-- 14) Os que sobraram entram na rodada seguinte (nenhum se perde).
set local role service_role;
select run_privacy_retention_batch(50) as r2 \gset
reset role;
select is(pg_temp.avaliados(:'r2'::jsonb), 50, '14) a rodada seguinte avalia 50 de novo: primeiro os 8 que sobraram, depois os avaliados há mais tempo');
select is((:'r2'::jsonb ->> 'processed')::int, 3, '14) e os 3 elegíveis que ficaram de fora na rodada 1 foram processados na 2');
select is(
  pg_temp.n($q$select count(*) from public.contacts where id::text like 'ffffffff%' and anonymized_at is not null$q$),
  3::bigint,
  '14) depois de duas rodadas, os 3 elegíveis foram anonimizados'
);
select is(
  pg_temp.n($q$select count(*) from public.contacts c where id::text like '00000000%' and name like 'Lote %' and anonymized_at is null$q$),
  55::bigint,
  '14) e os 55 bloqueados continuam intactos'
);

-- 13) A soma nunca excede o limite, seja qual for.
set local role service_role;
select run_privacy_retention_batch(10) as r3 \gset
select run_privacy_retention_batch(1) as r4 \gset
select run_privacy_retention_batch(500) as r5 \gset
reset role;
select is(pg_temp.avaliados(:'r3'::jsonb), 10, '13) lote 10 avalia exatamente 10 (a rotação recomeça sobre os bloqueados)');
select is(pg_temp.avaliados(:'r4'::jsonb), 1, '13) lote 1 avalia exatamente 1');
select ok(pg_temp.avaliados(:'r5'::jsonb) <= 200, '13) o teto de 200 vale mesmo pedindo 500');
select is(pg_temp.avaliados(:'r5'::jsonb), 55, '13) e, com folga, avalia todos os que existem (55 bloqueados)');

select is(
  pg_temp.n($q$select count(*) from public.audit_logs where action = 'privacy.retention_processed' and metadata::text ~* 'Lote'$q$),
  0::bigint,
  'o resumo do lote guarda só contagens'
);

select * from finish();
rollback;
