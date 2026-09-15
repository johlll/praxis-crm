-- Estabilização pós-A9 — numeração de propostas segura para concorrência
-- (docs/decisoes/estabilizacao-pos-a9.md §4).
--
-- Antes: create_proposal() calculava o número com count(*) + 1. Duas
-- criações simultâneas liam a mesma contagem, montavam o mesmo número e a
-- segunda falhava na unique (workspace_id, number) — reproduzido no CI com
-- criações simultâneas em clientes independentes. Além disso,
-- lpad(seq, 4, '0') TRUNCA sequências acima de 9999 ('10000' vira '1000'),
-- colidindo com um número já emitido.
--
-- Agora: um contador por (workspace, ano) em public.proposal_number_counters,
-- alocado com INSERT ... ON CONFLICT DO UPDATE ... RETURNING. A linha do
-- contador fica bloqueada até o fim da transação; a segunda chamada espera
-- e recebe o valor seguinte. Lacunas são aceitas (uma criação que falha
-- depois de alocar não devolve o número) — o pedido não exige sequência
-- sem buracos.
--
-- Números já emitidos ficam intactos: o contador é inicializado a partir do
-- maior sequencial existente (backfill abaixo) e, por segurança, cada
-- alocação nunca fica abaixo do maior número existente no banco. A unique
-- (workspace_id, number) continua valendo.

create table public.proposal_number_counters (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  year integer not null check (year between 2000 and 9999),
  last_value integer not null check (last_value >= 0),
  primary key (workspace_id, year)
);

comment on table public.proposal_number_counters is
  'Último sequencial de proposta emitido por workspace e ano. Só acessado por private.next_proposal_sequence().';

-- Mesmo padrão das tabelas de negócio (o schema private só guarda funções,
-- por desenho — 04_security_hardening.test.sql): RLS habilitada e forçada,
-- negação total para authenticated, acesso só pela função SECURITY DEFINER.
alter table public.proposal_number_counters enable row level security;
alter table public.proposal_number_counters force row level security;

create policy proposal_number_counters_select_deny on public.proposal_number_counters for select to authenticated using (false);
create policy proposal_number_counters_insert_deny on public.proposal_number_counters for insert to authenticated with check (false);
create policy proposal_number_counters_update_deny on public.proposal_number_counters for update to authenticated using (false);
create policy proposal_number_counters_delete_deny on public.proposal_number_counters for delete to authenticated using (false);

revoke all on table public.proposal_number_counters from public, anon, authenticated;

-- Maior sequencial já emitido no formato PROP-<ano>-<seq> (qualquer largura
-- de sequencial — inclusive números acima de 9999, se existirem).
create function private.max_emitted_proposal_sequence(p_workspace_id uuid, p_year integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $body$
  select coalesce(max(substring(p.number from '^PROP-[0-9]{4}-([0-9]+)$')::integer), 0)
  from public.proposals p
  where p.workspace_id = p_workspace_id
    and p.number like 'PROP-' || p_year::text || '-%';
$body$;

revoke all on function private.max_emitted_proposal_sequence(uuid, integer) from public;

create function private.next_proposal_sequence(p_workspace_id uuid, p_year integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_next integer;
begin
  insert into public.proposal_number_counters as c (workspace_id, year, last_value)
  values (
    p_workspace_id,
    p_year,
    private.max_emitted_proposal_sequence(p_workspace_id, p_year) + 1
  )
  on conflict (workspace_id, year) do update
    set last_value = greatest(c.last_value, private.max_emitted_proposal_sequence(p_workspace_id, p_year)) + 1
  returning last_value into v_next;

  return v_next;
end;
$body$;

revoke all on function private.next_proposal_sequence(uuid, integer) from public;

-- Backfill: workspaces que já emitiram propostas começam do maior número
-- existente de cada ano. Idempotente.
insert into public.proposal_number_counters (workspace_id, year, last_value)
select
  p.workspace_id,
  substring(p.number from '^PROP-([0-9]{4})-[0-9]+$')::integer as year,
  max(substring(p.number from '^PROP-[0-9]{4}-([0-9]+)$')::integer) as last_value
from public.proposals p
where p.number ~ '^PROP-[0-9]{4}-[0-9]+$'
group by p.workspace_id, 2
on conflict (workspace_id, year) do update
  set last_value = greatest(public.proposal_number_counters.last_value, excluded.last_value);

-- create_proposal: mesma assinatura e mesmas regras de acesso; só a
-- numeração muda.
create or replace function public.create_proposal(
  p_opportunity_id uuid,
  p_value_cents bigint,
  p_fee_model public.fee_model
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_opportunity public.opportunities;
  v_lead public.leads;
  v_year integer;
  v_seq integer;
  v_number text;
  v_proposal_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_value_cents is null or p_value_cents < 0 then
    raise exception 'invalid_value_cents';
  end if;

  select * into v_opportunity from public.opportunities where id = p_opportunity_id;
  if v_opportunity.id is null then
    raise exception 'opportunity_not_found';
  end if;

  select * into v_lead from public.leads where id = v_opportunity.lead_id;

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

  v_year := extract(year from now())::integer;
  v_seq := private.next_proposal_sequence(v_lead.workspace_id, v_year);
  -- Pelo menos 4 dígitos, sem truncar sequenciais maiores.
  v_number := 'PROP-' || v_year::text || '-' || lpad(v_seq::text, greatest(4, length(v_seq::text)), '0');

  insert into public.proposals (
    workspace_id, lead_id, opportunity_id, number, value_cents, fee_model, created_by
  )
  values (
    v_lead.workspace_id, v_lead.id, p_opportunity_id, v_number, p_value_cents, p_fee_model, v_actor
  )
  returning id into v_proposal_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_lead.workspace_id, v_actor, 'proposal.created', 'proposal', v_proposal_id,
    jsonb_build_object('lead_id', v_lead.id, 'opportunity_id', p_opportunity_id, 'number', v_number)
  );

  return v_proposal_id;
end;
$body$;

revoke all on function public.create_proposal(uuid, bigint, public.fee_model) from public;
grant execute on function public.create_proposal(uuid, bigint, public.fee_model) to authenticated;
