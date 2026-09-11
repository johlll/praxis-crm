-- A7 — RLS.
--
-- Mesmas duas categorias de sempre (ver comentário equivalente na A6,
-- 20260911120100_a6_rls.sql):
--
-- 1) whatsapp_channels — configuração não sensível (nenhum token real
--    nesta fase, é simulador), SELECT direto por workspace. Mutação só por
--    RPC administrativa (owner/admin — mais restrito que pipeline.configure
--    de propósito, ver a7-conversas.md §3).
--
-- 2) conversations/messages/message_status_events — escopo por registro
--    (herdado do lead vinculado, quando existe; conversa não vinculada só
--    é visível a owner/admin/manager — private.conversation_accessible_to_
--    role() na próxima migration). DENY-ALL, toda leitura E escrita passa
--    por função SECURITY DEFINER.

alter table public.whatsapp_channels enable row level security;
alter table public.whatsapp_channels force row level security;

create policy whatsapp_channels_select on public.whatsapp_channels
  for select
  to authenticated
  using (workspace_id in (select private.auth_workspace_ids()));

create policy whatsapp_channels_insert_deny on public.whatsapp_channels for insert to authenticated with check (false);
create policy whatsapp_channels_update_deny on public.whatsapp_channels for update to authenticated using (false);
create policy whatsapp_channels_delete_deny on public.whatsapp_channels for delete to authenticated using (false);

alter table public.conversations enable row level security;
alter table public.conversations force row level security;

create policy conversations_select_deny on public.conversations for select to authenticated using (false);
create policy conversations_insert_deny on public.conversations for insert to authenticated with check (false);
create policy conversations_update_deny on public.conversations for update to authenticated using (false);
create policy conversations_delete_deny on public.conversations for delete to authenticated using (false);

alter table public.messages enable row level security;
alter table public.messages force row level security;

create policy messages_select_deny on public.messages for select to authenticated using (false);
create policy messages_insert_deny on public.messages for insert to authenticated with check (false);
create policy messages_update_deny on public.messages for update to authenticated using (false);
create policy messages_delete_deny on public.messages for delete to authenticated using (false);

alter table public.message_status_events enable row level security;
alter table public.message_status_events force row level security;

create policy message_status_events_select_deny on public.message_status_events for select to authenticated using (false);
create policy message_status_events_insert_deny on public.message_status_events for insert to authenticated with check (false);
create policy message_status_events_update_deny on public.message_status_events for update to authenticated using (false);
create policy message_status_events_delete_deny on public.message_status_events for delete to authenticated using (false);
