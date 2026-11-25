#!/usr/bin/env bash
# Conversas + IA, painel do caso — valida a ATUALIZAÇÃO a partir da versão anterior, com conversas e
# oportunidades gravadas ANTES da migration:
#
#   1. recria o banco local só até a migration da interface de Conversas (#357);
#   2. cria um contato com dois leads e três oportunidades, conversas com e sem vínculo, e guarda o que a
#      lista (list_conversation_inbox) e o painel (list_conversation_case_options) devolvem para a dona do
#      escritório e para a advogada;
#   3. aplica a migration pendente;
#   4. confere:
#      - a lista devolve as MESMAS conversas, na mesma ordem, com o mesmo total e as mesmas contagens, e cada
#        item tem exatamente os mesmos valores de antes nas chaves antigas;
#      - o painel devolve as mesmas opções, na mesma ordem e com os mesmos valores;
#      - as chaves novas existem e lista e painel concordam no caso padrão;
#      - nenhuma conversa mudou (o vínculo persistido segue igual).
#
# Recria o banco local, por isso roda no fim do CI e termina na versão atual. Tudo fictício.
set -euo pipefail

PREVIOUS_VERSION="20261118120000"
DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
CARLA="20000000-0000-0000-0000-000000000003"
WS_UM="10000000-0000-0000-0000-000000000001"
CONTATO="78000000-0000-0000-0000-000000000001"
LEAD_A="78000000-0000-0000-0000-0000000000a1"
LEAD_B="78000000-0000-0000-0000-0000000000a2"
OPP_A1="78000000-0000-0000-0000-0000000000b1"
OPP_A2="78000000-0000-0000-0000-0000000000b2"
OPP_B1="78000000-0000-0000-0000-0000000000b3"
CANAL="78000000-0000-0000-0000-0000000000c1"

psql_db() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

snapshot() {
  # $1 = tabela de destino. Lê como cada papel (auth.uid() + role authenticated), como a tela.
  psql_db <<SQL
create table public.$1 (who text, kind text, conv uuid, body jsonb, total bigint, counts jsonb);
grant all on public.$1 to authenticated;
\o /dev/null
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);
insert into public.$1 (who, kind, body, total, counts)
  select 'ana', 'inbox', r.items, r.total_count, r.status_counts from public.list_conversation_inbox('$WS_UM', 1, 100) r;
insert into public.$1 (who, kind, conv, body)
  select 'ana', 'case', (e ->> 'id')::uuid, public.list_conversation_case_options((e ->> 'id')::uuid)
  from public.list_conversation_inbox('$WS_UM', 1, 100) r, jsonb_array_elements(r.items) e;
select set_config('request.jwt.claims', json_build_object('sub', '$CARLA', 'role', 'authenticated')::text, true);
insert into public.$1 (who, kind, body, total, counts)
  select 'carla', 'inbox', r.items, r.total_count, r.status_counts from public.list_conversation_inbox('$WS_UM', 1, 100) r;
insert into public.$1 (who, kind, conv, body)
  select 'carla', 'case', (e ->> 'id')::uuid, public.list_conversation_case_options((e ->> 'id')::uuid)
  from public.list_conversation_inbox('$WS_UM', 1, 100) r, jsonb_array_elements(r.items) e;
commit;
\o
SQL
}

echo "== 1. banco na versão anterior ($PREVIOUS_VERSION)"
supabase db reset --local --version "$PREVIOUS_VERSION"

echo "== 2. conversas e oportunidades gravadas pela versão anterior"
psql_db <<SQL
insert into public.contacts (id, workspace_id, type, name, created_by) values
  ('$CONTATO', '$WS_UM', 'pf', 'Contato (upgrade painel do caso)', '$ANA');
insert into public.leads (id, workspace_id, contact_id, legal_area, status, created_by, assigned_to) values
  ('$LEAD_A', '$WS_UM', '$CONTATO', 'Usucapião', 'ativo', '$ANA', '$ANA'),
  ('$LEAD_B', '$WS_UM', '$CONTATO', 'Inventário', 'ativo', '$ANA', null);
insert into public.opportunities (id, workspace_id, lead_id, pipeline_id, stage_id, created_by)
select v.id, '$WS_UM', v.lead, p.id,
  (select s.id from public.pipeline_stages s where s.pipeline_id = p.id and not s.is_won and not s.is_lost order by s.position limit 1),
  '$ANA'
from public.pipelines p
cross join (values ('$OPP_A1'::uuid, '$LEAD_A'::uuid), ('$OPP_A2'::uuid, '$LEAD_A'::uuid), ('$OPP_B1'::uuid, '$LEAD_B'::uuid)) v(id, lead)
where p.workspace_id = '$WS_UM' and p.is_default;

insert into public.whatsapp_channels (id, workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key)
values ('$CANAL', '$WS_UM', 'Canal (upgrade painel)', '+5541900007800', '$ANA', 'ycloud', false, 'preview', 'rota-upgrade-painel');

do \$seed\$
declare v_ident uuid; v_conv uuid; r record;
begin
  for r in select * from (values
    ('+5541999997801', '$LEAD_A'::uuid, '$OPP_A2'::uuid),  -- vínculo persistido
    ('+5541999997802', '$LEAD_B'::uuid, null::uuid),       -- único caso do lead
    ('+5541999997803', '$LEAD_A'::uuid, null::uuid),       -- lead com dois casos: nenhum por palpite
    ('+5541999997804', null::uuid, null::uuid)             -- sem lead: três casos
  ) t(phone, lead, opp) loop
    insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164)
    values ('$WS_UM', '$CANAL', 'ycloud', 'preview', r.phone) returning id into v_ident;
    insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id, opportunity_id)
    values ('$WS_UM', '$CANAL', v_ident, '$CONTATO', r.lead, r.opp) returning id into v_conv;
    insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id)
    values ('$WS_UM', v_conv, '$CANAL', 'inbound', 'delivered', 'inbound', 'external', 'text', 'Mensagem sintética', 'ycloud', 'WAMID-UPG-PAINEL-' || r.phone);
  end loop;
end
\$seed\$;

create table public.upgrade_check_conversations as select * from public.conversations;
SQL
snapshot upgrade_check_before

echo "== 3. migration pendente"
supabase migration up --local

snapshot upgrade_check_after

echo "== 4. conferências"
psql_db <<SQL
do \$check\$
declare
  v_new text[] := array['case', 'case_count', 'case_source'];
  v_case_new text[] := array['case_count', 'default_opportunity_id', 'default_source'];
  v_item_later text[] := array['case_number', 'service_type_name', 'service_step_name', 'service_step_position',
                               'service_steps_total', 'service_steps_completed'];
  v_n integer;
  v_diff integer;
begin
  -- Lista: mesma página, mesma ordem, mesmo total, mesmas contagens, mesmas chaves antigas.
  select count(*) into v_diff
  from public.upgrade_check_before b
  join public.upgrade_check_after a on a.who = b.who and a.kind = 'inbox'
  where b.kind = 'inbox'
    and (a.total is distinct from b.total
      or a.counts is distinct from b.counts
      or (select coalesce(jsonb_agg(e - v_new order by o), '[]'::jsonb) from jsonb_array_elements(a.body) with ordinality x(e, o))
         is distinct from b.body);
  if v_diff <> 0 then
    raise exception 'a lista mudou para % papel(is) nas chaves antigas, no total ou nas contagens', v_diff;
  end if;

  select count(*) into v_n from public.upgrade_check_before where kind = 'inbox' and jsonb_array_length(body) >= 4;
  if v_n < 1 then
    raise exception 'conferência vazia: a dona deveria ver as 4 conversas de teste';
  end if;

  -- Painel: mesmas opções, mesma ordem, mesmos valores.
  select count(*) into v_diff
  from public.upgrade_check_before b
  join public.upgrade_check_after a on a.who = b.who and a.kind = 'case' and a.conv = b.conv
  -- Cada item ignora SÓ as chaves acrescentadas depois (etapa B do painel: número interno e roteiro);
  -- todo campo que já existia continua comparado.
  where b.kind = 'case'
    and jsonb_set(a.body - v_case_new, '{items}', (
          select coalesce(jsonb_agg(i - v_item_later order by o), '[]'::jsonb)
          from jsonb_array_elements(a.body -> 'items') with ordinality x(i, o)))
        is distinct from b.body;
  if v_diff <> 0 then
    raise exception 'as opções de caso mudaram em % conversa(s)', v_diff;
  end if;
  select count(*) into v_diff from public.upgrade_check_before b
  where b.kind = 'case' and not exists (
    select 1 from public.upgrade_check_after a where a.kind = 'case' and a.who = b.who and a.conv = b.conv);
  if v_diff <> 0 then
    raise exception '% conversa(s) sumiram do painel depois da atualização', v_diff;
  end if;

  -- Chaves novas: lista e painel concordam no caso padrão e na contagem.
  select count(*) into v_diff
  from public.upgrade_check_after l, jsonb_array_elements(l.body) e
  join public.upgrade_check_after p on p.kind = 'case' and p.conv = (e ->> 'id')::uuid
  where l.kind = 'inbox' and p.who = l.who
    and ((e -> 'case' ->> 'opportunity_id') is distinct from (p.body ->> 'default_opportunity_id')
      or (e ->> 'case_count')::int is distinct from (p.body ->> 'case_count')::int);
  if v_diff <> 0 then
    raise exception 'lista e painel divergem no caso padrão em % item(ns)', v_diff;
  end if;

  if (select body ->> 'default_opportunity_id' from public.upgrade_check_after
      where who = 'ana' and kind = 'case'
        and conv = (select id from public.conversations where opportunity_id = '$OPP_A2')) is distinct from '$OPP_A2' then
    raise exception 'a conversa vinculada deveria ter o vínculo como caso padrão';
  end if;

  -- Nada escrito.
  select count(*) into v_diff from (
    (select * from public.upgrade_check_conversations except select * from public.conversations)
    union all
    (select * from public.conversations except select * from public.upgrade_check_conversations)
  ) d;
  if v_diff <> 0 then
    raise exception 'a atualização alterou % conversa(s)', v_diff;
  end if;
end
\$check\$;

drop table public.upgrade_check_before;
drop table public.upgrade_check_after;
drop table public.upgrade_check_conversations;
SQL

echo "OK: lista e painel iguais aos de antes nas chaves antigas, regra única nas chaves novas, nada escrito"
