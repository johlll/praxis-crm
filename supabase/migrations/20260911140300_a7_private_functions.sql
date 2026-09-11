-- A7 — funções privadas de apoio.

-- ---------------------------------------------------------------------
-- private.contact_has_active_consent — consentimento vigente = registro
-- com o canal certo, concedido, não revogado. Ausência de registro nunca
-- é tratada como consentimento (ver a7-conversas.md §10).
-- ---------------------------------------------------------------------

create function private.contact_has_active_consent(p_contact_id uuid, p_channel public.contact_channel)
returns boolean
language sql
stable
set search_path = ''
as $body$
  select exists (
    select 1 from public.contact_consents
    where contact_id = p_contact_id
      and channel = p_channel
      and granted_at is not null
      and revoked_at is null
  );
$body$;

comment on function private.contact_has_active_consent(uuid, public.contact_channel) is
  'Consentimento vigente para o canal — gate técnico verifica canal+vigência, não um texto específico de finalidade (purpose é livre, sem vocabulário fechado ainda; ver a7-conversas.md §10).';

revoke all on function private.contact_has_active_consent(uuid, public.contact_channel) from public;
grant execute on function private.contact_has_active_consent(uuid, public.contact_channel) to authenticated;

-- ---------------------------------------------------------------------
-- private.message_status_rank — ordem de progresso para nunca regredir.
-- ---------------------------------------------------------------------

create function private.message_status_rank(p_status public.message_status)
returns smallint
language sql
immutable
set search_path = ''
as $body$
  select case p_status
    when 'queued' then 0
    when 'sent' then 1
    when 'failed' then 1
    when 'delivered' then 2
    when 'read' then 3
  end;
$body$;

comment on function private.message_status_rank(public.message_status) is
  'queued(0) < sent(1) < delivered(2) < read(3); failed empata com sent (só alcançável a partir de queued/sent, nunca depois de delivered/read).';

revoke all on function private.message_status_rank(public.message_status) from public;
grant execute on function private.message_status_rank(public.message_status) to authenticated;

-- ---------------------------------------------------------------------
-- private.conversation_accessible_to_role — owner/admin/manager sempre;
-- conversa sem lead vinculado (needs_link_review) só para essas três;
-- conversa com lead usa o MESMO alcance já usado por atividades/
-- oportunidades (private.lead_accessible_to_role, A4).
-- ---------------------------------------------------------------------

create function private.conversation_accessible_to_role(
  p_role public.membership_role,
  p_lead_id uuid,
  p_lead_assigned_to uuid,
  p_actor uuid
)
returns boolean
language sql
immutable
set search_path = ''
as $body$
  select case
    when p_role in ('owner', 'admin', 'manager') then true
    when p_lead_id is null then false
    else private.lead_accessible_to_role(p_role, p_lead_assigned_to, p_actor)
  end;
$body$;

comment on function private.conversation_accessible_to_role(public.membership_role, uuid, uuid, uuid) is
  'Alcance de uma conversa: administração vê tudo; conversa ainda sem lead vinculado só é visível a owner/admin/manager; com lead, mesmo alcance "seus + sem responsável" do advogado já usado em atividades/oportunidades.';

revoke all on function private.conversation_accessible_to_role(public.membership_role, uuid, uuid, uuid) from public;
grant execute on function private.conversation_accessible_to_role(public.membership_role, uuid, uuid, uuid) to authenticated;
