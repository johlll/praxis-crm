-- Agenda mensal — leitura das atividades de um intervalo de datas.
--
-- A Agenda deixa de ser só "a semana atual" e passa a ser um calendário
-- mensal com o painel do dia selecionado. list_activities() só conhece os
-- filtros fixos (hoje/amanhã/semana/atrasadas/sem responsável), e carregar
-- todo o histórico para filtrar no navegador está fora de questão. Esta
-- migration é ADITIVA: cria uma função nova, sem tocar em list_activities()
-- nem em nenhum consumidor existente.
--
-- Contrato:
--   - p_from/p_to são DATAS (sem hora) no fuso America/Sao_Paulo, ambas
--     inclusivas: [p_from 00:00, p_to + 1 dia 00:00) no fuso do escritório,
--     convertido aqui em instantes reais (timestamptz). Nunca no fuso da
--     máquina que roda o Node nem no do navegador. Atividade "só de data"
--     já é gravada às 23:59:59 do dia (create_activity/reschedule_activity),
--     então cai no dia certo.
--   - Intervalo obrigatório, p_to >= p_from e no máximo 42 dias (seis
--     semanas): um mês cabe com folga; um pedido maior é recusado
--     (invalid_date_range) em vez de virar uma leitura do histórico inteiro.
--   - Mesmo alcance de list_activities(): membro ativo de qualquer papel, e
--     só as atividades de leads acessíveis ao papel
--     (private.lead_accessible_to_role — "seus + sem responsável" para
--     advogado/atendimento). Pendentes E concluídas.
--   - items: uma página (até 100, o mesmo teto de list_activities), em
--     ordem de due_at e id, com o MESMO formato de item de list_activities()
--     — o mapeamento do front é o mesmo.
--   - total_count: total do intervalo inteiro (não da página).
--   - day_counts: {"YYYY-MM-DD": n} do intervalo inteiro, calculado sobre o
--     mesmo conjunto acessível — a contagem de cada dia nunca é a da página.

create function public.list_activities_in_range(
  p_workspace_id uuid,
  p_from date,
  p_to date,
  p_page integer default 1,
  p_page_size integer default 100
)
returns table (items jsonb, total_count bigint, day_counts jsonb)
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
  v_start timestamptz;
  v_end timestamptz;
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

  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 41 then
    raise exception 'invalid_date_range';
  end if;

  select role into v_role from public.memberships
  where workspace_id = p_workspace_id and user_id = v_actor and status = 'active';

  v_start := p_from::timestamp at time zone 'America/Sao_Paulo';
  v_end := (p_to + 1)::timestamp at time zone 'America/Sao_Paulo';

  v_page_size := greatest(1, least(coalesce(p_page_size, 100), 100));
  v_offset := (greatest(1, coalesce(p_page, 1)) - 1) * v_page_size;

  return query
  with accessible as (
    select
      a.id, a.lead_id, a.opportunity_id, a.type, a.title, a.notes,
      a.assigned_to, a.priority, a.due_at, a.has_time, a.status, a.completed_at,
      a.source, a.lock_version, a.created_at, a.updated_at,
      c.name as contact_name, l.legal_area, u.full_name as assigned_to_name
    from public.activities a
    join public.leads l on l.id = a.lead_id
    join public.contacts c on c.id = l.contact_id
    left join public.users u on u.id = a.assigned_to
    where a.workspace_id = p_workspace_id
      and private.lead_accessible_to_role(v_role, l.assigned_to, v_actor)
      and a.due_at >= v_start
      and a.due_at < v_end
  ),
  numbered as (
    select accessible.*, row_number() over (order by due_at asc, id asc) as rn
    from accessible
  ),
  page as (
    select * from numbered where rn > v_offset and rn <= v_offset + v_page_size
  ),
  per_day as (
    select to_char((due_at at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD') as day, count(*) as n
    from accessible
    group by 1
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id, 'lead_id', p.lead_id, 'opportunity_id', p.opportunity_id,
            'contact_name', p.contact_name, 'legal_area', p.legal_area,
            'type', p.type, 'title', p.title, 'notes', p.notes,
            'assigned_to', p.assigned_to, 'assigned_to_name', p.assigned_to_name,
            'priority', p.priority, 'due_at', p.due_at, 'has_time', p.has_time,
            'status', p.status, 'completed_at', p.completed_at,
            'source', p.source, 'lock_version', p.lock_version,
            'created_at', p.created_at, 'updated_at', p.updated_at
          )
          order by p.rn
        )
        from page p
      ),
      '[]'::jsonb
    ),
    (select count(*) from accessible),
    coalesce((select jsonb_object_agg(d.day, d.n) from per_day d), '{}'::jsonb);
end;
$body$;

comment on function public.list_activities_in_range(uuid, date, date, integer, integer) is
  'Agenda mensal: atividades (pendentes e concluídas) com prazo entre p_from e p_to (datas inclusivas, America/Sao_Paulo; no máximo 42 dias), no alcance do papel. Página de até 100 itens, total do intervalo e contagem por dia do intervalo inteiro.';

revoke all on function public.list_activities_in_range(uuid, date, date, integer, integer) from public, anon;
grant execute on function public.list_activities_in_range(uuid, date, date, integer, integer) to authenticated;
