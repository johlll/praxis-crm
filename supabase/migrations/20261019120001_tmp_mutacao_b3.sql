-- MUTAÇÃO TEMPORÁRIA (B3.1) — NUNCA MESCLAR. Branch descartável só para
-- provar que os testes de banco pegam cada regressão.

-- M1: conferência de ambiente removida no carregamento e na listagem.
create or replace function private.whatsapp_lock_managed_channel(
  p_channel_id uuid,
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_env public.whatsapp_environment
)
returns public.whatsapp_channels
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_channel public.whatsapp_channels;
begin
  if p_actor_user_id is null or p_workspace_id is null then
    raise exception 'actor_required';
  end if;
  if not private.whatsapp_actor_can_manage(p_workspace_id, p_actor_user_id) then
    raise exception 'insufficient_permission';
  end if;

  select * into v_channel from public.whatsapp_channels c
  where c.id = p_channel_id
    and c.workspace_id = p_workspace_id
  for update;

  if v_channel.id is null then
    raise exception 'channel_not_found';
  end if;
  return v_channel;
end;
$body$;

create or replace function public.whatsapp_list_channels(p_workspace_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
begin
  if p_actor_user_id is null or p_workspace_id is null then
    raise exception 'actor_required';
  end if;
  if not private.whatsapp_actor_can_manage(p_workspace_id, p_actor_user_id) then
    raise exception 'insufficient_permission';
  end if;

  return coalesce((
    select jsonb_agg(private.whatsapp_channel_safe_row(c) order by c.created_at, c.id)
    from public.whatsapp_channels c
    where c.workspace_id = p_workspace_id
  ), '[]'::jsonb);
end;
$body$;

-- M2: permissão aceita manager.
create or replace function private.whatsapp_actor_can_manage(p_workspace_id uuid, p_actor_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $body$
  select exists (
    select 1 from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_actor_user_id
      and m.status = 'active'
      and m.role in ('owner', 'admin', 'manager')
  );
$body$;

-- M4: leitura de credencial liberada para authenticated.
grant select on public.whatsapp_channel_credentials to authenticated;
drop policy whatsapp_channel_credentials_select_deny on public.whatsapp_channel_credentials;
create policy whatsapp_channel_credentials_select_open on public.whatsapp_channel_credentials for select to authenticated using (true);
