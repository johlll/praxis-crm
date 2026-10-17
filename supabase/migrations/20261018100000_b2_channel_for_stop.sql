-- B2 — encerramento controlado de UM canal pelo operador (Preview de
-- validação). A rota recebe só o id do canal; tudo o mais — conexão, dono,
-- workspace, agenda, recurso — vem do registro gravado, por esta função.
--
-- Só leitura. Confere o ambiente ASSINADO do chamador e a consistência
-- entre canal e conexão (mesmo ambiente, mesmo workspace). Não devolve
-- nenhum segredo: nem hash do segredo do canal, nem tokens. Só service_role.

create function public.get_calendar_channel_for_stop(p_channel_id text)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_channel public.calendar_watch_channels;
  v_conn public.calendar_connections;
begin
  select * into v_channel from public.calendar_watch_channels w where w.channel_id = p_channel_id;
  if v_channel.id is null then
    raise exception 'channel_not_found';
  end if;
  if v_channel.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;
  select * into v_conn from public.calendar_connections c where c.id = v_channel.connection_id;
  if v_conn.id is null
     or v_conn.environment <> v_channel.environment
     or v_conn.workspace_id is distinct from v_channel.workspace_id then
    raise exception 'channel_inconsistent';
  end if;
  return jsonb_build_object(
    'channelId', v_channel.channel_id,
    'status', v_channel.status,
    'resourceId', v_channel.resource_id,
    'calendarId', v_channel.calendar_id,
    'connectionId', v_conn.id,
    'connectionStatus', v_conn.status,
    'userId', v_conn.user_id,
    'workspaceId', v_conn.workspace_id
  );
end;
$body$;

revoke all on function public.get_calendar_channel_for_stop(text) from public;
grant execute on function public.get_calendar_channel_for_stop(text) to service_role;
revoke execute on function public.get_calendar_channel_for_stop(text) from anon, authenticated;
