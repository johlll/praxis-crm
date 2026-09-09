-- A4 — correções da revisão do commit 1c6e753, antes do merge do PR #4.
--
-- Três problemas reais, todos dentro das funções de negócio da A4
-- (20260909100200_a4_business_functions.sql) — nenhuma tabela nem policy
-- muda aqui, só o comportamento das funções, via CREATE OR REPLACE (e um
-- DROP+CREATE pontual em create_lead, que perde um parâmetro — não dá
-- para isso ser CREATE OR REPLACE).
--
-- 1) ALCANCE POR REGISTRO NA ESCRITA — get_lead()/list_leads() já
--    restringiam o que o advogado consegue LER ("seus + sem responsável"
--    — confirmado como a definição correta de "seus + equipe" do plano,
--    já que não existe tabela de equipe/hierarquia). update_lead_basic_
--    fields()/assign_lead()/set_lead_status()/set_lead_value() só
--    checavam papel/membership, sem checar se o REGISTRO estava no
--    alcance do advogado — um advogado podia editar, arquivar ou
--    atribuir a si mesmo um lead de outro colega chamando a RPC direto,
--    mesmo nunca vendo esse lead pela tela. A regra agora vive num único
--    lugar (private.lead_accessible_to_role), usada pelas quatro funções
--    de escrita E pelas duas de leitura. Negação usa 'lead_not_found' —
--    igual à leitura — para não revelar que o registro existe.
--
-- 2) CONCORRÊNCIA DE VERDADE — a versão anterior fazia SELECT, comparava
--    updated_at em PL/pgSQL, e só DEPOIS rodava um UPDATE sem nenhuma
--    condição de versão no WHERE — a checagem e a escrita eram dois
--    passos separados, com uma janela real entre eles onde outra
--    transação podia gravar no meio. Agora a condição de versão entra no
--    WHERE do próprio UPDATE (ou no WHERE do DO UPDATE de um upsert): a
--    checagem e a escrita são a MESMA operação atômica, e o Postgres
--    resolve a corrida via lock de linha (a segunda transação espera a
--    primeira commitar e só então reavalia o WHERE contra o valor JÁ
--    ATUALIZADO — se não bater, zero linhas afetadas, conflito). O
--    parâmetro de versão esperada deixa de ter default nulo nas três
--    funções que editam um lead já existente (sempre há uma versão atual
--    para comparar); em set_lead_value() nulo continua válido, mas só
--    significa "eu não esperava nenhum valor anterior" — se já existir
--    linha, o upsert com WHERE rejeita do mesmo jeito.
--
-- 3) RETRAÇÃO DO FLUXO FINANCEIRO ANTECIPADO — o plano original (seção
--    6.3) só coloca valor monetário em `opportunities` (A5); `leads` não
--    tem esse campo. `lead_values`/`estimated_value_cents` foram
--    introduzidos durante a A4 para existir algo sensível a proteger nos
--    testes de projeção por papel — justificativa não aceita. Esta
--    migration retira o fluxo do contrato ATIVO (create_lead não aceita
--    mais o parâmetro; get_lead()/list_leads() não projetam mais nenhuma
--    chave de valor, para nenhum papel; set_lead_value() tem o EXECUTE
--    revogado de authenticated — ninguém, por nenhuma via, consegue mais
--    chamá-la) SEM apagar dado nem reescrever migration já aplicada:
--    `lead_values`, `private.lead_value_projection` e
--    `private.money_band_label` continuam existindo, intactas, como
--    estrutura residual (inclusive a única linha real gravada no
--    ambiente hospedado durante o teste manual da A4 — ver
--    A4-HANDOFF.md) — para a A5 decidir o destino quando
--    `opportunities.value_cents` existir. Nenhuma fonte financeira nova
--    foi criada para compensar.

-- ---------------------------------------------------------------------
-- private.lead_accessible_to_role — única fonte de verdade do alcance
-- "seus + sem responsável" do advogado. Qualquer outro papel (dentre os
-- que já passaram por has_workspace_role) sempre tem acesso; a regra só
-- restringe 'lawyer'.
-- ---------------------------------------------------------------------

create function private.lead_accessible_to_role(
  p_role public.membership_role,
  p_assigned_to uuid,
  p_actor uuid
)
returns boolean
language sql
immutable
set search_path = ''
as $body$
  select p_role <> 'lawyer' or p_assigned_to is null or p_assigned_to = p_actor;
$body$;

comment on function private.lead_accessible_to_role(public.membership_role, uuid, uuid) is
  'Alcance "seus + sem responsável" do advogado — única implementação, usada por leitura E escrita de leads.';

revoke all on function private.lead_accessible_to_role(public.membership_role, uuid, uuid) from public;
grant execute on function private.lead_accessible_to_role(public.membership_role, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- create_lead — perde p_estimated_value_cents (achado 3). Parâmetro
-- removido, não deprecado: DROP+CREATE porque CREATE OR REPLACE não
-- permite tirar um parâmetro do meio/fim da assinatura.
-- ---------------------------------------------------------------------

drop function public.create_lead(
  uuid, uuid, text, text, text[], public.lead_priority, uuid, bigint
);

create function public.create_lead(
  p_workspace_id uuid,
  p_contact_id uuid,
  p_legal_area text,
  p_summary text default null,
  p_tags text[] default '{}'::text[],
  p_priority public.lead_priority default 'media',
  p_assigned_to uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_lead_id uuid;
  v_contact record;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select id, merged_into_contact_id into v_contact
  from public.contacts
  where id = p_contact_id and workspace_id = p_workspace_id;

  if v_contact.id is null then
    raise exception 'contact_not_found';
  end if;
  if v_contact.merged_into_contact_id is not null then
    raise exception 'contact_already_merged';
  end if;

  if p_assigned_to is not null and not exists (
    select 1 from public.memberships
    where workspace_id = p_workspace_id and user_id = p_assigned_to and status = 'active'
  ) then
    raise exception 'assignee_not_a_member';
  end if;

  insert into public.leads (workspace_id, contact_id, legal_area, summary, tags, priority, assigned_to)
  values (
    p_workspace_id, p_contact_id, btrim(p_legal_area),
    nullif(btrim(coalesce(p_summary, '')), ''), coalesce(p_tags, '{}'::text[]),
    p_priority, p_assigned_to
  )
  returning id into v_lead_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, v_actor, 'lead.created', 'lead', v_lead_id,
    jsonb_build_object('contact_id', p_contact_id)
  );

  return v_lead_id;
end;
$body$;

revoke all on function public.create_lead(
  uuid, uuid, text, text, text[], public.lead_priority, uuid
) from public;
grant execute on function public.create_lead(
  uuid, uuid, text, text, text[], public.lead_priority, uuid
) to authenticated;

-- ---------------------------------------------------------------------
-- update_lead_basic_fields — achados 1 e 2: alcance do advogado +
-- versão esperada obrigatória, checada atomicamente no WHERE do UPDATE.
-- ---------------------------------------------------------------------

create or replace function public.update_lead_basic_fields(
  p_lead_id uuid,
  p_legal_area text,
  p_summary text default null,
  p_tags text[] default '{}'::text[],
  p_priority public.lead_priority default 'media',
  p_expected_updated_at timestamptz default null
)
returns public.leads
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
  v_updated public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_expected_updated_at is null then
    raise exception 'expected_version_required';
  end if;

  select * into v_lead from public.leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'lead_not_found';
  end if;

  if not private.has_workspace_role(
    v_lead.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'lead_not_found';
  end if;

  -- Checagem e escrita são a MESMA operação: se updated_at não bater
  -- neste exato instante (não no instante do SELECT lá em cima), zero
  -- linhas voltam e FOUND é falso — sem janela entre checar e gravar.
  update public.leads
  set legal_area = btrim(p_legal_area),
      summary = nullif(btrim(coalesce(p_summary, '')), ''),
      tags = coalesce(p_tags, '{}'::text[]),
      priority = p_priority
  where id = p_lead_id and updated_at = p_expected_updated_at
  returning * into v_updated;

  if not found then
    raise exception 'lead_conflict';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_lead.workspace_id, v_actor, 'lead.updated', 'lead', v_lead.id, '{}'::jsonb);

  return v_updated;
end;
$body$;

-- ---------------------------------------------------------------------
-- assign_lead — mesmos dois achados.
-- ---------------------------------------------------------------------

create or replace function public.assign_lead(
  p_lead_id uuid,
  p_assigned_to uuid default null,
  p_expected_updated_at timestamptz default null
)
returns public.leads
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
  v_updated public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_expected_updated_at is null then
    raise exception 'expected_version_required';
  end if;

  select * into v_lead from public.leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'lead_not_found';
  end if;

  if not private.has_workspace_role(
    v_lead.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'lead_not_found';
  end if;

  if p_assigned_to is not null and not exists (
    select 1 from public.memberships
    where workspace_id = v_lead.workspace_id and user_id = p_assigned_to and status = 'active'
  ) then
    raise exception 'assignee_not_a_member';
  end if;

  update public.leads
  set assigned_to = p_assigned_to
  where id = p_lead_id and updated_at = p_expected_updated_at
  returning * into v_updated;

  if not found then
    raise exception 'lead_conflict';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_lead.workspace_id, v_actor, 'lead.assigned', 'lead', v_lead.id,
    jsonb_build_object('assigned_to', p_assigned_to)
  );

  return v_updated;
end;
$body$;

-- ---------------------------------------------------------------------
-- set_lead_status — mesmos dois achados.
-- ---------------------------------------------------------------------

create or replace function public.set_lead_status(
  p_lead_id uuid,
  p_status public.lead_status,
  p_expected_updated_at timestamptz default null
)
returns public.leads
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
  v_updated public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_expected_updated_at is null then
    raise exception 'expected_version_required';
  end if;

  select * into v_lead from public.leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'lead_not_found';
  end if;

  if not private.has_workspace_role(
    v_lead.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'lead_not_found';
  end if;

  update public.leads
  set status = p_status
  where id = p_lead_id and updated_at = p_expected_updated_at
  returning * into v_updated;

  if not found then
    raise exception 'lead_conflict';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_lead.workspace_id, v_actor, 'lead.status_changed', 'lead', v_lead.id,
    jsonb_build_object('status', p_status)
  );

  return v_updated;
end;
$body$;

-- ---------------------------------------------------------------------
-- set_lead_value — corrigida por consistência (mesmos achados 1 e 2),
-- mas revogada de `authenticated` logo abaixo (achado 3): estrutura
-- residual correta, não parte do contrato ativo da A4.
-- ---------------------------------------------------------------------

create or replace function public.set_lead_value(
  p_lead_id uuid,
  p_estimated_value_cents bigint default null,
  p_expected_updated_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
  v_result_lead_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_lead from public.leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'lead_not_found';
  end if;

  if not private.has_workspace_role(
    v_lead.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'lead_not_found';
  end if;

  if p_estimated_value_cents is not null and p_estimated_value_cents < 0 then
    raise exception 'invalid_value';
  end if;

  -- Upsert atômico: se já existir linha, o UPDATE do conflito só se
  -- aplica quando updated_at bate — mesma garantia das outras três
  -- funções, sem o passo separado de SELECT+comparar que a versão
  -- anterior fazia.
  insert into public.lead_values (lead_id, workspace_id, estimated_value_cents)
  values (p_lead_id, v_lead.workspace_id, p_estimated_value_cents)
  on conflict (lead_id) do update
    set estimated_value_cents = excluded.estimated_value_cents
    where public.lead_values.updated_at = p_expected_updated_at
  returning lead_id into v_result_lead_id;

  if not found then
    raise exception 'lead_conflict';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_lead.workspace_id, v_actor, 'lead.value_set', 'lead', v_lead.id, '{}'::jsonb);
end;
$body$;

-- Achado 3: ninguém, por nenhum papel, consegue mais chamar esta função
-- — o fluxo de valor não faz parte do contrato ativo da A4.
revoke execute on function public.set_lead_value(uuid, bigint, timestamptz) from authenticated;

-- ---------------------------------------------------------------------
-- get_lead — achado 1 (centraliza a checagem de alcance já existente,
-- sem mudar o comportamento) + achado 3 (nunca mais projeta valor —
-- nenhuma chave de honorário, para nenhum papel).
-- ---------------------------------------------------------------------

create or replace function public.get_lead(p_lead_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
  v_contact_name text;
  v_assigned_to_name text;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_lead from public.leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'lead_not_found';
  end if;

  if not private.has_workspace_role(
    v_lead.workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'lead_not_found';
  end if;

  select c.name into v_contact_name from public.contacts c where c.id = v_lead.contact_id;
  select u.full_name into v_assigned_to_name from public.users u where u.id = v_lead.assigned_to;

  return jsonb_build_object(
    'id', v_lead.id,
    'workspace_id', v_lead.workspace_id,
    'contact_id', v_lead.contact_id,
    'contact_name', v_contact_name,
    'legal_area', v_lead.legal_area,
    'summary', v_lead.summary,
    'tags', to_jsonb(v_lead.tags),
    'priority', v_lead.priority,
    'status', v_lead.status,
    'assigned_to', v_lead.assigned_to,
    'assigned_to_name', v_assigned_to_name,
    'created_at', v_lead.created_at,
    'updated_at', v_lead.updated_at
  );
end;
$body$;

-- ---------------------------------------------------------------------
-- list_leads — mesmos dois ajustes: alcance via a função central, sem
-- join em lead_values nem projeção de valor.
-- ---------------------------------------------------------------------

create or replace function public.list_leads(
  p_workspace_id uuid,
  p_search text default null,
  p_status public.lead_status default null,
  p_priority public.lead_priority default null,
  p_assigned_to uuid default null,
  p_legal_area text default null,
  p_sort text default 'created_at_desc',
  p_page integer default 1,
  p_page_size integer default 20
)
returns table (items jsonb, total_count bigint)
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_page_size integer;
  v_offset integer;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(
    p_workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = p_workspace_id and user_id = v_actor and status = 'active';

  v_page_size := greatest(1, least(coalesce(p_page_size, 20), 100));
  v_offset := (greatest(1, coalesce(p_page, 1)) - 1) * v_page_size;

  return query
  with ranked as (
    select
      l.id, l.contact_id, l.legal_area, l.summary, l.tags, l.priority, l.status,
      l.assigned_to, l.created_at, l.updated_at,
      c.name as contact_name,
      u.full_name as assigned_to_name,
      count(*) over () as full_count,
      row_number() over (
        order by
          case when p_sort = 'created_at_asc' then l.created_at end asc,
          case when p_sort is null or p_sort = 'created_at_desc' then l.created_at end desc,
          l.id asc
      ) as rn
    from public.leads l
    join public.contacts c on c.id = l.contact_id
    left join public.users u on u.id = l.assigned_to
    where l.workspace_id = p_workspace_id
      and private.lead_accessible_to_role(v_role, l.assigned_to, v_actor)
      and (p_status is null or l.status = p_status)
      and (p_priority is null or l.priority = p_priority)
      and (p_assigned_to is null or l.assigned_to = p_assigned_to)
      and (p_legal_area is null or l.legal_area = p_legal_area)
      and (
        p_search is null or btrim(p_search) = ''
        or c.name ilike '%' || btrim(p_search) || '%'
        or l.summary ilike '%' || btrim(p_search) || '%'
      )
  ),
  page as (
    select * from ranked where rn > v_offset and rn <= v_offset + v_page_size
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id, 'contact_id', p.contact_id, 'contact_name', p.contact_name,
            'legal_area', p.legal_area, 'summary', p.summary, 'tags', to_jsonb(p.tags),
            'priority', p.priority, 'status', p.status,
            'assigned_to', p.assigned_to, 'assigned_to_name', p.assigned_to_name,
            'created_at', p.created_at, 'updated_at', p.updated_at
          )
          order by p.rn
        )
        from page p
      ),
      '[]'::jsonb
    ),
    coalesce((select r.full_count from ranked r limit 1), 0);
end;
$body$;
