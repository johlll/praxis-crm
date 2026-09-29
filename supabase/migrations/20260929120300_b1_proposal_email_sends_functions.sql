-- B1 — Propostas: funções de envio real por e-mail.
--
-- queue_proposal_email decide SE um envio pode acontecer e reserva a
-- intenção; mark_proposal_email_sent/mark_proposal_email_failed só
-- REGISTRAM o resultado que o servidor já obteve do provedor — as três
-- têm GRANT só para service_role, pela mesma razão de
-- begin_proposal_document e cetera: nenhum usuário autenticado tem
-- EXECUTE nelas (B1, correção 3). Em especial mark_sent/mark_failed: se
-- qualquer papel autenticado pudesse chamá-las direto, bastaria um
-- `supabase.rpc('mark_proposal_email_sent', {...})` do navegador para
-- fabricar a prova de que um e-mail saiu sem o provedor ter feito nada —
-- exatamente o que a correção pede para impedir.

create function public.queue_proposal_email(
  p_proposal_id uuid,
  p_document_id uuid,
  p_to_email text,
  p_idempotency_key uuid,
  p_actor_user_id uuid
)
returns table (send_id uuid, status public.proposal_email_send_status, is_new boolean)
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_role public.membership_role;
  v_proposal public.proposals;
  v_lead public.leads;
  v_document public.proposal_documents;
  v_workspace public.workspaces;
  v_to_email text := lower(btrim(p_to_email));
  v_existing public.proposal_email_sends;
  v_new_id uuid;
begin
  if p_actor_user_id is null then
    raise exception 'actor_required';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency_key_required';
  end if;

  select * into v_proposal from public.proposals where id = p_proposal_id;
  if v_proposal.id is null then
    raise exception 'proposal_not_found';
  end if;

  select * into v_lead from public.leads where id = v_proposal.lead_id;

  -- `status` bare seria ambíguo com o parâmetro de saída desta função
  -- (returns table (..., status ..., ...)) — mesmo motivo de
  -- begin_proposal_document/version, daí a qualificação explícita aqui e
  -- na consulta de proposal_documents logo abaixo.
  select role into v_role from public.memberships m
  where m.workspace_id = v_lead.workspace_id and m.user_id = p_actor_user_id and m.status = 'active';

  -- Mesmo nível de begin_proposal_document: quem despacha precisa
  -- enxergar o valor exato que está no PDF anexado.
  if v_role is null or v_role not in ('owner', 'admin', 'manager', 'lawyer') then
    raise exception 'insufficient_permission';
  end if;

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, p_actor_user_id) then
    raise exception 'lead_not_found';
  end if;

  select * into v_document from public.proposal_documents pd
  where pd.id = p_document_id and pd.proposal_id = p_proposal_id and pd.status = 'ready';
  if v_document.id is null then
    raise exception 'document_not_ready';
  end if;

  -- Identificação mínima do escritório (B1, correção 6) — sem razão
  -- social, o e-mail sai sem dizer quem o escritório é. OAB/CNPJ/endereço
  -- continuam opcionais, checados só na renderização do PDF, não aqui.
  select * into v_workspace from public.workspaces where id = v_lead.workspace_id;
  if v_workspace.legal_name is null then
    raise exception 'workspace_profile_incomplete';
  end if;

  -- Destinatário precisa ser um e-mail JÁ conhecido do contato — nunca um
  -- endereço digitado na hora, que ninguém verificou pertencer a quem
  -- deveria (B1, correção 6).
  if not exists (
    select 1 from public.contact_emails ce
    where ce.contact_id = v_lead.contact_id and ce.value_normalized = v_to_email
  ) then
    raise exception 'recipient_email_not_found';
  end if;

  -- Reuso de intenção: a MESMA chave (mesmo clique, ou uma repetição dele)
  -- nunca cria uma segunda linha nem chega a chamar o Resend duas vezes —
  -- só quem CRIA a linha (is_new=true) segue adiante (B1, correção 1).
  select * into v_existing from public.proposal_email_sends where idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.document_id <> p_document_id or v_existing.proposal_id <> p_proposal_id then
      raise exception 'idempotency_key_reused';
    end if;
    return query select v_existing.id, v_existing.status, false;
    return;
  end if;

  insert into public.proposal_email_sends (
    workspace_id, proposal_id, document_id, to_email, requested_by, idempotency_key
  )
  values (v_lead.workspace_id, p_proposal_id, p_document_id, v_to_email, p_actor_user_id, p_idempotency_key)
  returning id into v_new_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_lead.workspace_id, p_actor_user_id, 'proposal.email.queued', 'proposal_email_send', v_new_id,
    jsonb_build_object('proposal_id', p_proposal_id, 'document_id', p_document_id, 'document_version', v_document.version)
  );

  return query select v_new_id, 'queued'::public.proposal_email_send_status, true;
end;
$body$;

revoke all on function public.queue_proposal_email(uuid, uuid, text, uuid, uuid) from public;
grant execute on function public.queue_proposal_email(uuid, uuid, text, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- mark_proposal_email_sent — "accepted", nunca "sent"/"delivered": só
-- prova que o Resend aceitou a mensagem, não que a caixa do cliente
-- recebeu (B1, correção 2). Idempotente (status<>'queued' é no-op).
--
-- Dispara rascunho→enviada em proposals SÓ na primeira vez — a mesma
-- transição que send_proposal (registro manual, A9) já fazia. Reenvios
-- subsequentes (proposta já 'enviada'/'aceita'/'recusada') marcam
-- caused_status_transition=false e não tocam proposals: é isso que
-- impede duplicar o mesmo fato na timeline (B1, correção 7) — o primeiro
-- envio aparece através da linha que já existia; só reenvios GANHAM linha
-- própria (ver get_lead_timeline nesta mesma leva de migrations).
-- ---------------------------------------------------------------------

create function public.mark_proposal_email_sent(
  p_send_id uuid,
  p_provider_message_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_send public.proposal_email_sends;
  v_proposal public.proposals;
  v_updated integer;
  v_was_draft boolean;
begin
  if p_provider_message_id is null or btrim(p_provider_message_id) = '' then
    raise exception 'provider_message_id_required';
  end if;

  select * into v_send from public.proposal_email_sends where id = p_send_id for update;
  if v_send.id is null then
    raise exception 'send_not_found';
  end if;
  if v_send.status <> 'queued' then
    return;
  end if;

  select * into v_proposal from public.proposals where id = v_send.proposal_id for update;
  v_was_draft := v_proposal.status = 'rascunho';

  update public.proposal_email_sends
  set status = 'accepted', provider_message_id = p_provider_message_id, resolved_at = now(),
      caused_status_transition = v_was_draft
  where id = p_send_id and status = 'queued';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return;
  end if;

  if v_was_draft then
    update public.proposals
    set status = 'enviada',
        sent_at = now(),
        sent_channels = case
          when 'email' = any(sent_channels) then sent_channels
          else sent_channels || 'email'::public.proposal_channel
        end,
        lock_version = lock_version + 1
    where id = v_send.proposal_id and status = 'rascunho';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_send.workspace_id, v_send.requested_by, 'proposal.email.accepted_by_provider', 'proposal_email_send', p_send_id,
    jsonb_build_object(
      'proposal_id', v_send.proposal_id, 'document_id', v_send.document_id,
      'provider_message_id', p_provider_message_id, 'caused_status_transition', v_was_draft
    )
  );
end;
$body$;

revoke all on function public.mark_proposal_email_sent(uuid, text) from public;
grant execute on function public.mark_proposal_email_sent(uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- mark_proposal_email_failed — idempotente, nunca reescreve um resultado
-- já resolvido (accepted ou failed).
-- ---------------------------------------------------------------------

create function public.mark_proposal_email_failed(
  p_send_id uuid,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_send public.proposal_email_sends;
  v_updated integer;
begin
  select * into v_send from public.proposal_email_sends where id = p_send_id for update;
  if v_send.id is null then
    raise exception 'send_not_found';
  end if;
  if v_send.status <> 'queued' then
    return;
  end if;

  update public.proposal_email_sends
  set status = 'failed', error_code = coalesce(nullif(btrim(p_error_code), ''), 'unknown'), resolved_at = now()
  where id = p_send_id and status = 'queued';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return;
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_send.workspace_id, v_send.requested_by, 'proposal.email.failed', 'proposal_email_send', p_send_id,
    jsonb_build_object('proposal_id', v_send.proposal_id, 'document_id', v_send.document_id, 'error_code', p_error_code)
  );
end;
$body$;

revoke all on function public.mark_proposal_email_failed(uuid, text) from public;
grant execute on function public.mark_proposal_email_failed(uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- list_proposal_email_sends — leitura, mesma faixa de list_proposal_documents.
-- ---------------------------------------------------------------------

create function public.list_proposal_email_sends(p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_proposal public.proposals;
  v_lead public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_proposal from public.proposals where id = p_proposal_id;
  if v_proposal.id is null then
    raise exception 'proposal_not_found';
  end if;

  select * into v_lead from public.leads where id = v_proposal.lead_id;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if v_role is null or v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer') then
    raise exception 'proposal_not_found';
  end if;

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'proposal_not_found';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'documentId', s.document_id,
          'toEmail', s.to_email,
          'status', s.status,
          'errorCode', s.error_code,
          'requestedAt', s.requested_at,
          'resolvedAt', s.resolved_at
        )
        order by s.requested_at desc
      )
      from public.proposal_email_sends s
      where s.proposal_id = p_proposal_id
    ),
    '[]'::jsonb
  );
end;
$body$;

revoke all on function public.list_proposal_email_sends(uuid) from public;
grant execute on function public.list_proposal_email_sends(uuid) to authenticated;
