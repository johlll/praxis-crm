-- B1 — Propostas: get_lead_timeline ganha reenvios de e-mail como fato
-- próprio, sem duplicar o primeiro envio.
--
-- O braço 'proposta' já existente (A9) reage a coalesce(decided_at,
-- sent_at, created_at) — quando o PRIMEIRO envio bem-sucedido (manual,
-- A9, ou por e-mail real, B1) grava sent_at, essa MESMA linha já reflete
-- o fato "foi enviada". Duplicar isso com uma segunda linha seria
-- exatamente o que a correção 7 pede para evitar.
--
-- O que esse braço NUNCA representou: um reenvio de versão corrigida
-- depois que a proposta já saiu de 'rascunho' — sent_at não muda de novo
-- (mark_proposal_email_sent só toca proposals na primeira vez), então
-- esse fato ficaria invisível sem uma linha própria. O novo braço abaixo
-- cobre só isso: proposal_email_sends com status='accepted' e
-- caused_status_transition=false — por definição, tudo que NÃO é o
-- primeiro envio já contado pelo braço 'proposta'.
--
-- create or replace com a MESMA assinatura da A9
-- (uuid, text[], timestamptz, uuid, integer) — corpo idêntico ao de
-- 20260913100200_a9_read_functions.sql, só com o braço novo inserido no
-- UNION ALL.

create or replace function public.get_lead_timeline(
  p_lead_id uuid,
  p_types text[] default null,
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 30
)
returns table (items jsonb, has_more boolean)
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
  v_limit integer;
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

  if p_before is not null and p_before_id is null then
    raise exception 'invalid_cursor';
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 30), 100));

  return query
  with source as (
    select 'nota'::text as event_type, n.created_at as occurred_at, n.id as row_id,
      jsonb_build_object('body', n.body, 'created_by', n.created_by) as payload
    from public.lead_notes n
    where n.lead_id = p_lead_id

    union all

    select 'atividade', coalesce(a.completed_at, a.created_at), a.id,
      jsonb_build_object(
        'type', a.type, 'title', a.title, 'status', a.status, 'opportunity_id', a.opportunity_id,
        'assigned_to', a.assigned_to, 'due_at', a.due_at, 'completed_at', a.completed_at
      )
    from public.activities a
    where a.lead_id = p_lead_id

    union all

    select 'mensagem', m.created_at, m.id,
      jsonb_build_object(
        'direction', m.direction, 'body_text', m.body_text, 'status', m.status,
        'conversation_id', m.conversation_id
      )
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    where c.lead_id = p_lead_id
      and private.conversation_accessible_to_role(v_role, c.lead_id, v_lead.assigned_to, v_actor)

    union all

    select 'etapa', st.occurred_at, st.id,
      jsonb_build_object(
        'opportunity_id', st.opportunity_id, 'from_stage_id', st.from_stage_id, 'to_stage_id', st.to_stage_id,
        'from_stage_name', fs.name, 'to_stage_name', ts.name
      )
    from public.stage_transitions st
    join public.opportunities o on o.id = st.opportunity_id
    left join public.pipeline_stages fs on fs.id = st.from_stage_id
    join public.pipeline_stages ts on ts.id = st.to_stage_id
    where o.lead_id = p_lead_id

    union all

    select 'proposta', coalesce(p.decided_at, p.sent_at, p.created_at), p.id,
      jsonb_build_object('number', p.number, 'status', p.status, 'opportunity_id', p.opportunity_id)
        || private.proposal_financial_projection(v_role, p.value_cents, p.fee_model)
    from public.proposals p
    where p.lead_id = p_lead_id

    union all

    -- B1: reenvio de e-mail que NÃO foi o primeiro (caused_status_transition
    -- = false) — o primeiro já está representado pelo braço 'proposta'
    -- acima, através de sent_at. Isso evita duplicar o mesmo fato na
    -- timeline (correção 7).
    select 'proposta', pes.resolved_at, pes.id,
      jsonb_build_object(
        'kind', 'email_resent',
        'opportunity_id', p.opportunity_id,
        'document_version', pd.version,
        'to_email', pes.to_email
      )
    from public.proposal_email_sends pes
    join public.proposals p on p.id = pes.proposal_id
    join public.proposal_documents pd on pd.id = pes.document_id
    where p.lead_id = p_lead_id
      and pes.status = 'accepted'
      and not pes.caused_status_transition

    union all

    select 'conflito', cc.checked_at, cc.id,
      jsonb_build_object('status', cc.status)
    from public.conflict_checks cc
    where cc.lead_id = p_lead_id and cc.checked_at is not null
  ),
  filtered as (
    select * from source where p_types is null or event_type = any(p_types)
  ),
  page as (
    select *
    from filtered
    where p_before is null or (occurred_at, row_id) < (p_before, p_before_id)
    order by occurred_at desc, row_id desc
    limit v_limit
  ),
  cursor_point as (
    select occurred_at, row_id from page order by occurred_at asc, row_id asc limit 1
  ),
  older_count as (
    select count(*) as n
    from filtered f, cursor_point cp
    where (f.occurred_at, f.row_id) < (cp.occurred_at, cp.row_id)
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'event_type', p.event_type, 'occurred_at', p.occurred_at, 'id', p.row_id, 'payload', p.payload
          )
          order by p.occurred_at desc, p.row_id desc
        )
        from page p
      ),
      '[]'::jsonb
    ),
    coalesce((select n from older_count), 0) > 0;
end;
$body$;

revoke all on function public.get_lead_timeline(uuid, text[], timestamptz, uuid, integer) from public;
grant execute on function public.get_lead_timeline(uuid, text[], timestamptz, uuid, integer) to authenticated;
