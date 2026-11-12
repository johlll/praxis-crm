-- B6c — chaves estrangeiras sem órfãos (somente leitura; só diz SE há órfãos, nunca quais linhas).
-- chaves estrangeiras sem órfãos: as linhas foram carregadas com os gatilhos (e as FKs) desligados,
-- então cada FK é conferida de verdade, por anti-junção (MATCH SIMPLE: só linhas com todas as colunas
-- preenchidas). Mostra só QUANTAS FKs têm órfãos, nunca quais linhas.
do $$
declare
  r record;
  n bigint;
  ruins integer := 0;
  total integer := 0;
begin
  for r in
    select c.conrelid::regclass as filho, c.confrelid::regclass as pai,
           (select string_agg(format('f.%I = p.%I', fa.attname, pa.attname), ' and ' order by k.ord)
              from unnest(c.conkey, c.confkey) with ordinality as k(ck, pk, ord)
              join pg_attribute fa on fa.attrelid = c.conrelid and fa.attnum = k.ck
              join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = k.pk) as junta,
           (select string_agg(format('f.%I is not null', fa.attname), ' and ')
              from unnest(c.conkey) as k(ck)
              join pg_attribute fa on fa.attrelid = c.conrelid and fa.attnum = k.ck) as preenchidas
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    where c.contype = 'f'
      and (n.nspname in ('public', 'private', 'supabase_migrations')
           or (n.nspname = 'auth' and cl.relname in ('users', 'identities')))
  loop
    total := total + 1;
    execute format('select count(*) from %s f where %s and not exists (select 1 from %s p where %s)',
                   r.filho, r.preenchidas, r.pai, r.junta) into n;
    if n > 0 then ruins := ruins + 1; end if;
  end loop;
  if ruins > 0 then
    raise exception 'fk_com_orfaos';
  end if;
end
$$;
