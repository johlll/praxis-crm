-- B3.3 — saída humana pelo CRM (docs/decisoes/b3-whatsapp-real.md §28.18).
--
-- Esta migration NÃO fala com a YCloud nem com a Meta e não envia nada para
-- fora. Ela prepara o envio de texto e de template por usuário autorizado,
-- em duas fases (reserva e outbox), inicialmente só com o provedor simulado:
--
--   1. `whatsapp_templates`: espelho dos templates por canal (categoria final
--      e estado). Só o servidor escreve (`whatsapp_upsert_template`).
--   2. `whatsapp_outbox`: uma linha por INTENÇÃO de envio, presa à mensagem do
--      CRM. No máximo UMA tentativa (`attempts <= 1`): o resultado incerto
--      nunca é reenviado sozinho.
--   3. `whatsapp_send_context`: o que a tela precisa saber (rota, janela,
--      bloqueio, templates utility aprovados).
--   4. `whatsapp_reserve_send`: fase 1. Papel, acesso à conversa, vínculo,
--      consentimento de atendimento, canal ativo com envio habilitado,
--      janela de 24 h (texto livre) ou template aprovado e utility (fora
--      dela), idempotência por `client_dedupe_key`. Grava a mensagem do CRM
--      (`origin = crm`, `sender_classification = internal`, `queued`) e a
--      outbox na mesma transação.
--   5. `whatsapp_outbox_begin` / `whatsapp_outbox_finish`: fase 2, chamadas
--      pelo servidor em volta da chamada ao provedor.
--   6. `whatsapp_enable_channel_send`: liga o envio de um canal ATIVO e
--      SIMULADO. YCloud e Meta são recusados nesta etapa.
--   7. A restrição "canal simulado nunca envia" passa a valer só fora do
--      Preview: o adaptador simulado não sai do processo.
--   8. `send_message` da A7 passa a recusar conversa de canal da B3, que só
--      envia pela outbox: antes, ela gravaria uma saída "enviada" falsa.
--
-- A janela de 24 h conta a partir da última mensagem recebida do contato
-- (`messages.created_at`, instante em que o CRM a gravou), menos 5 minutos de
-- margem. O instante exato do evento não fica na mensagem; a autoridade final
-- é o provedor, que recusa texto livre fora da janela real.
--
-- Todas as funções novas: SECURITY DEFINER, search_path travado, EXECUTE só
-- para service_role, ambiente autenticado do WhatsApp obrigatório. Nenhuma
-- delas devolve credencial, texto cifrado ou telefone.

-- ---------------------------------------------------------------------
-- 1) Canal simulado pode enviar no Preview (nunca em Production)
-- ---------------------------------------------------------------------

alter table public.whatsapp_channels drop constraint whatsapp_channels_simulator_never_sends;
alter table public.whatsapp_channels
  add constraint whatsapp_channels_simulator_send_preview_only
    check (not (is_simulator and send_enabled) or environment = 'preview');

-- ---------------------------------------------------------------------
-- 2) Templates (espelho por canal)
-- ---------------------------------------------------------------------

create table public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  channel_id uuid not null,
  environment public.whatsapp_environment not null,
  provider public.whatsapp_provider not null,
  name text not null check (name ~ '^[a-z0-9_]+$' and char_length(name) <= 512),
  language text not null check (language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  -- Categoria FINAL (a que o provedor aprovou), nunca a pretendida.
  category text not null check (category in ('utility', 'marketing', 'authentication')),
  status text not null check (status in ('approved', 'pending', 'rejected', 'paused', 'disabled')),
  body_text text not null check (char_length(btrim(body_text)) between 1 and 1024),
  param_count integer not null check (param_count between 0 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_templates_channel_name_language_key unique (channel_id, name, language),
  constraint whatsapp_templates_channel_identity_fkey
    foreign key (workspace_id, channel_id, environment, provider)
    references public.whatsapp_channels (workspace_id, id, environment, provider) on delete cascade
);

create trigger whatsapp_templates_set_updated_at
  before update on public.whatsapp_templates
  for each row execute function private.set_updated_at();

alter table public.whatsapp_templates enable row level security;
alter table public.whatsapp_templates force row level security;
revoke all on table public.whatsapp_templates from public, anon, authenticated;
create policy whatsapp_templates_select_deny on public.whatsapp_templates for select to authenticated using (false);
create policy whatsapp_templates_insert_deny on public.whatsapp_templates for insert to authenticated with check (false);
create policy whatsapp_templates_update_deny on public.whatsapp_templates for update to authenticated using (false);
create policy whatsapp_templates_delete_deny on public.whatsapp_templates for delete to authenticated using (false);

comment on table public.whatsapp_templates is
  'Espelho dos templates por canal (B3.3): categoria final e estado. Sem GRANT para anon/authenticated; escrito e lido só por funções de service_role com ambiente autenticado.';

-- ---------------------------------------------------------------------
-- 3) Outbox: uma linha por intenção de envio
-- ---------------------------------------------------------------------

create table public.whatsapp_outbox (
  id uuid primary key default gen_random_uuid(),
  environment public.whatsapp_environment not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  channel_id uuid not null,
  provider public.whatsapp_provider not null,
  conversation_id uuid not null,
  message_id uuid not null,
  client_dedupe_key uuid not null,
  kind text not null check (kind in ('text', 'template')),
  template_id uuid references public.whatsapp_templates (id),
  template_params text[],
  state text not null default 'reserved' check (state in ('reserved', 'sending', 'accepted', 'rejected', 'uncertain')),
  -- No máximo UMA chamada ao provedor por intenção: nenhum reenvio automático.
  attempts integer not null default 0 check (attempts between 0 and 1),
  sending_started_at timestamptz,
  lease_until timestamptz,
  provider_message_id text check (provider_message_id ~ '^[A-Za-z0-9][A-Za-z0-9._:=+/-]{0,254}$'),
  error_code text check (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_outbox_message_key unique (message_id),
  constraint whatsapp_outbox_conversation_dedupe_key unique (conversation_id, client_dedupe_key),
  constraint whatsapp_outbox_kind_template check ((kind = 'template') = (template_id is not null)),
  -- Reservada: nenhuma tentativa. Em envio, aceita ou incerta: exatamente uma.
  -- Rejeitada: zero (recusada antes da chamada) ou uma (recusada pelo provedor).
  constraint whatsapp_outbox_state_attempts check (
    (state = 'reserved' and attempts = 0)
    or (state in ('sending', 'accepted', 'uncertain') and attempts = 1)
    or state = 'rejected'
  ),
  constraint whatsapp_outbox_accepted_has_provider_id check ((state = 'accepted') = (provider_message_id is not null)),
  constraint whatsapp_outbox_error_only_rejected check (error_code is null or state = 'rejected'),
  constraint whatsapp_outbox_channel_identity_fkey
    foreign key (workspace_id, channel_id, environment, provider)
    references public.whatsapp_channels (workspace_id, id, environment, provider) on delete restrict,
  constraint whatsapp_outbox_conversation_fkey
    foreign key (workspace_id, conversation_id)
    references public.conversations (workspace_id, id) on delete cascade,
  constraint whatsapp_outbox_message_fkey
    foreign key (message_id, workspace_id, channel_id)
    references public.messages (id, workspace_id, channel_id) on delete cascade
);

create index whatsapp_outbox_workspace_idx on public.whatsapp_outbox (workspace_id);
create index whatsapp_outbox_open_idx on public.whatsapp_outbox (state) where state in ('reserved', 'sending');

create trigger whatsapp_outbox_set_updated_at
  before update on public.whatsapp_outbox
  for each row execute function private.set_updated_at();

alter table public.whatsapp_outbox enable row level security;
alter table public.whatsapp_outbox force row level security;
revoke all on table public.whatsapp_outbox from public, anon, authenticated;
create policy whatsapp_outbox_select_deny on public.whatsapp_outbox for select to authenticated using (false);
create policy whatsapp_outbox_insert_deny on public.whatsapp_outbox for insert to authenticated with check (false);
create policy whatsapp_outbox_update_deny on public.whatsapp_outbox for update to authenticated using (false);
create policy whatsapp_outbox_delete_deny on public.whatsapp_outbox for delete to authenticated using (false);

comment on table public.whatsapp_outbox is
  'Intenção de envio do CRM (B3.3): reserved, sending, accepted, rejected ou uncertain. No máximo uma tentativa; incerto nunca é reenviado sozinho. Sem GRANT para anon/authenticated.';

-- ---------------------------------------------------------------------
-- 4) Auxiliares privados
-- ---------------------------------------------------------------------

-- Conversa que o ator pode usar para enviar: papel de envio ativo no
-- workspace informado pelo servidor e alcance da conversa (mesma regra da A7).
create function private.whatsapp_sendable_conversation(
  p_conversation_id uuid,
  p_workspace_id uuid,
  p_actor_user_id uuid
)
returns public.conversations
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_role public.membership_role;
  v_conversation public.conversations;
  v_assigned uuid;
begin
  if p_actor_user_id is null or p_workspace_id is null then
    raise exception 'actor_required';
  end if;

  select m.role into v_role from public.memberships m
  where m.workspace_id = p_workspace_id and m.user_id = p_actor_user_id and m.status = 'active';
  if v_role is null or v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales') then
    raise exception 'insufficient_permission';
  end if;

  select * into v_conversation from public.conversations c
  where c.id = p_conversation_id and c.workspace_id = p_workspace_id;
  if v_conversation.id is null then
    raise exception 'conversation_not_found';
  end if;

  select l.assigned_to into v_assigned from public.leads l where l.id = v_conversation.lead_id;
  if not private.conversation_accessible_to_role(v_role, v_conversation.lead_id, v_assigned, p_actor_user_id) then
    raise exception 'conversation_not_found';
  end if;
  return v_conversation;
end;
$body$;

-- Fim da janela de atendimento: 24 h depois da última mensagem recebida do
-- contato, menos 5 minutos de margem. Nulo = nunca recebeu.
create function private.whatsapp_conversation_window_end(p_conversation_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $body$
  select max(m.created_at) + interval '24 hours' - interval '5 minutes'
  from public.messages m
  where m.conversation_id = p_conversation_id
    and m.direction = 'inbound'
    and m.origin = 'inbound'
    and m.sender_classification <> 'internal';
$body$;

-- Resultado de uma operação da outbox, com o registro REALMENTE persistido
-- da mensagem (nunca o que o chamador digitou).
create function private.whatsapp_outbox_snapshot(p_outbox public.whatsapp_outbox, p_duplicate boolean, p_conflict boolean)
returns jsonb
language sql
security definer
set search_path = ''
as $body$
  select jsonb_build_object(
    'outbox_id', p_outbox.id,
    'state', p_outbox.state,
    'error_code', p_outbox.error_code,
    'duplicate_submit', p_duplicate,
    'content_conflict', p_conflict,
    'message_id', m.id,
    'direction', m.direction,
    'body_text', m.body_text,
    'status', m.status,
    'status_updated_at', m.status_updated_at,
    'error_reason', m.error_reason,
    'sent_by', m.sent_by,
    'created_at', m.created_at,
    'wa_message_id', coalesce(m.wa_message_id, m.provider_message_id)
  )
  from public.messages m
  where m.id = p_outbox.message_id;
$body$;

revoke all on function private.whatsapp_sendable_conversation(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.whatsapp_conversation_window_end(uuid) from public, anon, authenticated;
revoke all on function private.whatsapp_outbox_snapshot(public.whatsapp_outbox, boolean, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5) Liga o envio de um canal ativo e simulado
-- ---------------------------------------------------------------------

create function public.whatsapp_enable_channel_send(p_channel_id uuid, p_workspace_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels := private.whatsapp_lock_managed_channel(p_channel_id, p_workspace_id, p_actor_user_id, v_env);
begin
  -- Esta etapa só envia pelo adaptador simulado. YCloud e Meta ficam
  -- recusados até existir o envio real (e, no número da Vitória, o contrato
  -- autenticado de passagem).
  if v_channel.provider <> 'simulated' then
    raise exception 'provider_send_not_available';
  end if;
  if v_channel.status <> 'active' then
    raise exception 'invalid_channel_state';
  end if;

  begin
    update public.whatsapp_channels set send_enabled = true where id = v_channel.id
    returning * into v_channel;
  exception when check_violation then
    raise exception 'invalid_channel_state';
  end;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, p_actor_user_id, 'whatsapp.channel.send_enabled', 'whatsapp_channel', v_channel.id,
    jsonb_build_object('environment', v_env, 'provider', v_channel.provider)
  );

  return private.whatsapp_channel_safe_row(v_channel);
end;
$body$;

-- ---------------------------------------------------------------------
-- 6) Templates: cadastro/atualização pelo servidor (owner/admin)
-- ---------------------------------------------------------------------

create function public.whatsapp_upsert_template(
  p_channel_id uuid,
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_name text,
  p_language text,
  p_category text,
  p_status text,
  p_body_text text,
  p_param_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels := private.whatsapp_lock_managed_channel(p_channel_id, p_workspace_id, p_actor_user_id, v_env);
  v_template public.whatsapp_templates;
  v_distinct integer;
  v_max integer;
begin
  if p_body_text is null or char_length(btrim(p_body_text)) not between 1 and 1024 or p_param_count is null or p_param_count not between 0 and 10 then
    raise exception 'invalid_template';
  end if;

  -- Os marcadores são exatamente {{1}}..{{param_count}}.
  select count(distinct mt[1]::integer), coalesce(max(mt[1]::integer), 0)
  into v_distinct, v_max
  from regexp_matches(p_body_text, '\{\{([0-9]{1,2})\}\}', 'g') as mt;
  if v_distinct <> p_param_count or v_max <> p_param_count then
    raise exception 'invalid_template';
  end if;

  begin
    insert into public.whatsapp_templates (
      workspace_id, channel_id, environment, provider, name, language, category, status, body_text, param_count
    )
    values (
      v_channel.workspace_id, v_channel.id, v_env, v_channel.provider, p_name, p_language, p_category, p_status,
      btrim(p_body_text), p_param_count
    )
    on conflict (channel_id, name, language) do update
      set category = excluded.category, status = excluded.status,
          body_text = excluded.body_text, param_count = excluded.param_count
    returning * into v_template;
  exception when check_violation then
    raise exception 'invalid_template';
  end;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, p_actor_user_id, 'whatsapp.template.upserted', 'whatsapp_template', v_template.id,
    jsonb_build_object('environment', v_env, 'provider', v_channel.provider, 'category', v_template.category, 'status', v_template.status)
  );

  return jsonb_build_object(
    'id', v_template.id, 'channel_id', v_template.channel_id, 'name', v_template.name, 'language', v_template.language,
    'category', v_template.category, 'status', v_template.status, 'param_count', v_template.param_count
  );
end;
$body$;

-- ---------------------------------------------------------------------
-- 7) Contexto de envio da conversa (o que a tela mostra)
-- ---------------------------------------------------------------------

create function public.whatsapp_send_context(p_conversation_id uuid, p_workspace_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_conversation public.conversations := private.whatsapp_sendable_conversation(p_conversation_id, p_workspace_id, p_actor_user_id);
  v_channel public.whatsapp_channels;
  v_window_end timestamptz;
  v_reason text;
begin
  select * into v_channel from public.whatsapp_channels c where c.id = v_conversation.channel_id;
  -- Canal legado da A7 (sem ambiente): continua no caminho da A7.
  if v_channel.environment is null then
    return jsonb_build_object('route', 'legacy');
  end if;
  if v_channel.environment <> v_env then
    raise exception 'conversation_not_found';
  end if;

  v_window_end := private.whatsapp_conversation_window_end(v_conversation.id);
  v_reason := case
    when v_conversation.contact_id is null then 'conversation_not_linked'
    when not private.contact_has_active_consent(v_conversation.contact_id, 'whatsapp', 'whatsapp_atendimento') then 'consent_required'
    when v_channel.status <> 'active' then 'channel_not_active'
    when not v_channel.send_enabled then 'send_disabled'
    when v_conversation.wa_id is null then 'recipient_unavailable'
    else null
  end;

  return jsonb_build_object(
    'route', 'b3',
    'provider', v_channel.provider,
    'blocked_reason', v_reason,
    'window_open', coalesce(v_window_end > now(), false),
    'window_expires_at', v_window_end,
    'case_linked', v_conversation.lead_id is not null,
    'templates', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', t.id, 'name', t.name, 'language', t.language, 'body_text', t.body_text, 'param_count', t.param_count)
        order by t.name, t.language
      )
      from public.whatsapp_templates t
      where t.channel_id = v_channel.id and t.status = 'approved' and t.category = 'utility'
    ), '[]'::jsonb)
  );
end;
$body$;

-- ---------------------------------------------------------------------
-- 8) Fase 1: reserva
-- ---------------------------------------------------------------------

create function public.whatsapp_reserve_send(
  p_conversation_id uuid,
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_client_dedupe_key uuid,
  p_kind text,
  p_body_text text default null,
  p_template_id uuid default null,
  p_template_params text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_conversation public.conversations := private.whatsapp_sendable_conversation(p_conversation_id, p_workspace_id, p_actor_user_id);
  v_channel public.whatsapp_channels;
  v_existing public.whatsapp_outbox;
  v_existing_body text;
  v_template public.whatsapp_templates;
  v_params text[] := coalesce(p_template_params, '{}'::text[]);
  v_body text;
  v_outbox_id uuid := gen_random_uuid();
  v_message_id uuid;
  v_outbox public.whatsapp_outbox;
  v_idx integer;
begin
  if p_client_dedupe_key is null then
    raise exception 'invalid_message_body';
  end if;
  if p_kind is null or p_kind not in ('text', 'template') then
    raise exception 'invalid_message_kind';
  end if;

  select * into v_channel from public.whatsapp_channels c where c.id = v_conversation.channel_id;
  if v_channel.environment is distinct from v_env then
    raise exception 'conversation_not_found';
  end if;

  -- Idempotência por intenção: a mesma chave devolve o que já existe e nunca
  -- cria outra mensagem. Conteúdo diferente = content_conflict.
  select * into v_existing from public.whatsapp_outbox o
  where o.conversation_id = p_conversation_id and o.client_dedupe_key = p_client_dedupe_key;
  if v_existing.id is not null then
    select m.body_text into v_existing_body from public.messages m where m.id = v_existing.message_id;
    return private.whatsapp_outbox_snapshot(
      v_existing, true,
      case when p_kind = 'text'
        then v_existing.kind <> 'text' or v_existing_body is distinct from btrim(p_body_text)
        else v_existing.kind <> 'template'
          or v_existing.template_id is distinct from p_template_id
          or v_existing.template_params is distinct from v_params
      end
    );
  end if;

  if v_conversation.contact_id is null then
    raise exception 'conversation_not_linked';
  end if;
  if not private.contact_has_active_consent(v_conversation.contact_id, 'whatsapp', 'whatsapp_atendimento') then
    raise exception 'consent_required';
  end if;
  if v_channel.status <> 'active' then
    raise exception 'channel_not_active';
  end if;
  if not v_channel.send_enabled then
    raise exception 'send_disabled';
  end if;
  if v_conversation.wa_id is null then
    raise exception 'recipient_unavailable';
  end if;

  if p_kind = 'text' then
    if p_body_text is null or char_length(btrim(p_body_text)) not between 1 and 4096 then
      raise exception 'invalid_message_body';
    end if;
    -- Texto livre só dentro da janela de atendimento.
    if not coalesce(private.whatsapp_conversation_window_end(v_conversation.id) > now(), false) then
      raise exception 'window_closed';
    end if;
    v_body := btrim(p_body_text);
    v_params := null;
  else
    select * into v_template from public.whatsapp_templates t
    where t.id = p_template_id and t.channel_id = v_channel.id and t.workspace_id = v_conversation.workspace_id;
    if v_template.id is null then
      raise exception 'template_not_found';
    end if;
    -- Estado e categoria FINAL conferidos agora, na reserva.
    if v_template.status <> 'approved' then
      raise exception 'template_not_approved';
    end if;
    if v_template.category <> 'utility' then
      raise exception 'template_category_not_allowed';
    end if;
    -- Utility exige a conversa vinculada a um caso.
    if v_conversation.lead_id is null then
      raise exception 'template_requires_case';
    end if;
    if coalesce(cardinality(v_params), 0) <> v_template.param_count then
      raise exception 'invalid_template_params';
    end if;
    v_body := v_template.body_text;
    for v_idx in 1 .. v_template.param_count loop
      if v_params[v_idx] is null
         or char_length(btrim(v_params[v_idx])) not between 1 and 128
         or v_params[v_idx] ~ '[[:cntrl:]]'
         or position('{{' in v_params[v_idx]) > 0
         or position('}}' in v_params[v_idx]) > 0 then
        raise exception 'invalid_template_params';
      end if;
      v_params[v_idx] := btrim(v_params[v_idx]);
    end loop;
    -- Do maior índice para o menor: um valor nunca cria um marcador novo
    -- (valores com chaves já foram recusados acima).
    for v_idx in reverse v_template.param_count .. 1 loop
      v_body := replace(v_body, '{{' || v_idx || '}}', v_params[v_idx]);
    end loop;
    if char_length(v_body) > 4096 then
      raise exception 'invalid_template_params';
    end if;
  end if;

  begin
    insert into public.messages (
      workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind,
      body_text, status, provider, wa_message_id, client_dedupe_key, sent_by,
      origin_correlation_kind, origin_correlation_ref
    )
    values (
      v_conversation.workspace_id, v_conversation.id, v_channel.id, 'outbound', 'crm', 'internal',
      case p_kind when 'template' then 'template' else 'text' end,
      v_body, 'queued', v_channel.provider, 'praxis.out.' || replace(v_outbox_id::text, '-', ''), p_client_dedupe_key,
      p_actor_user_id, 'crm_outbox', v_outbox_id::text
    )
    returning id into v_message_id;

    insert into public.whatsapp_outbox (
      id, environment, workspace_id, channel_id, provider, conversation_id, message_id, client_dedupe_key,
      kind, template_id, template_params, created_by
    )
    values (
      v_outbox_id, v_env, v_conversation.workspace_id, v_channel.id, v_channel.provider, v_conversation.id, v_message_id,
      p_client_dedupe_key, p_kind, v_template.id, v_params, p_actor_user_id
    )
    returning * into v_outbox;
  exception when unique_violation then
    -- Corrida: outra chamada com a MESMA intenção comitou primeiro.
    select * into v_existing from public.whatsapp_outbox o
    where o.conversation_id = p_conversation_id and o.client_dedupe_key = p_client_dedupe_key;
    if v_existing.id is null then
      raise exception 'invalid_message_body';
    end if;
    return private.whatsapp_outbox_snapshot(v_existing, true, false);
  end;

  update public.conversations set last_message_at = greatest(coalesce(last_message_at, now()), now())
  where id = v_conversation.id;

  -- Auditoria sem conteúdo, telefone ou parâmetros.
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_conversation.workspace_id, p_actor_user_id, 'whatsapp.message.queued', 'message', v_message_id,
    jsonb_build_object('conversation_id', v_conversation.id, 'environment', v_env, 'provider', v_channel.provider, 'kind', p_kind)
  );

  return private.whatsapp_outbox_snapshot(v_outbox, false, false);
end;
$body$;

-- ---------------------------------------------------------------------
-- 9) Fase 2: begin e finish (chamadas pelo servidor em volta do provedor)
-- ---------------------------------------------------------------------

create function public.whatsapp_outbox_begin(p_outbox_id uuid, p_lease_seconds integer default 60)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_outbox public.whatsapp_outbox;
  v_channel public.whatsapp_channels;
  v_conversation public.conversations;
  v_message public.messages;
  v_template public.whatsapp_templates;
begin
  if p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception 'invalid_lease';
  end if;

  select * into v_outbox from public.whatsapp_outbox o where o.id = p_outbox_id and o.environment = v_env for update;
  if v_outbox.id is null then
    raise exception 'outbox_not_found';
  end if;

  if v_outbox.state = 'sending' then
    if v_outbox.lease_until >= now() then
      return private.whatsapp_outbox_snapshot(v_outbox, true, false) || jsonb_build_object('outcome', 'in_progress');
    end if;
    -- A tentativa começou e o processo sumiu: pode ter chegado ao provedor.
    -- Nunca reenvia; fica incerta.
    update public.whatsapp_outbox set state = 'uncertain' where id = v_outbox.id returning * into v_outbox;
    update public.messages set error_reason = 'send_uncertain', status_updated_at = now() where id = v_outbox.message_id;
    return private.whatsapp_outbox_snapshot(v_outbox, true, false) || jsonb_build_object('outcome', 'done');
  end if;

  if v_outbox.state <> 'reserved' then
    return private.whatsapp_outbox_snapshot(v_outbox, true, false) || jsonb_build_object('outcome', 'done');
  end if;

  select * into v_channel from public.whatsapp_channels c where c.id = v_outbox.channel_id for share;
  select * into v_conversation from public.conversations c where c.id = v_outbox.conversation_id;
  select * into v_message from public.messages m where m.id = v_outbox.message_id;

  -- O envio pode ter sido desligado entre a reserva e a chamada.
  if v_channel.status <> 'active' or not v_channel.send_enabled or v_conversation.wa_id is null then
    update public.whatsapp_outbox set state = 'rejected', error_code = 'send_disabled' where id = v_outbox.id returning * into v_outbox;
    update public.messages set status = 'failed', error_reason = 'send_disabled', status_updated_at = now() where id = v_outbox.message_id;
    return private.whatsapp_outbox_snapshot(v_outbox, false, false) || jsonb_build_object('outcome', 'done');
  end if;

  if v_outbox.kind = 'template' then
    select * into v_template from public.whatsapp_templates t where t.id = v_outbox.template_id;
  end if;

  update public.whatsapp_outbox
  set state = 'sending', attempts = 1, sending_started_at = now(),
      lease_until = now() + make_interval(secs => p_lease_seconds)
  where id = v_outbox.id
  returning * into v_outbox;

  return private.whatsapp_outbox_snapshot(v_outbox, false, false) || jsonb_build_object(
    'outcome', 'begin',
    'kind', v_outbox.kind,
    'provider', v_channel.provider,
    'routing_key', v_channel.routing_key,
    'recipient_phone', v_conversation.wa_id,
    'text', case when v_outbox.kind = 'text' then v_message.body_text end,
    'template_name', v_template.name,
    'template_language', v_template.language,
    'template_params', case when v_outbox.kind = 'template' then to_jsonb(v_outbox.template_params) end
  );
end;
$body$;

create function public.whatsapp_outbox_finish(
  p_outbox_id uuid,
  p_outcome text,
  p_provider_message_id text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_outbox public.whatsapp_outbox;
  v_code text;
begin
  if p_outcome is null or p_outcome not in ('accepted', 'rejected', 'uncertain') then
    raise exception 'invalid_outcome';
  end if;

  select * into v_outbox from public.whatsapp_outbox o where o.id = p_outbox_id and o.environment = v_env for update;
  if v_outbox.id is null then
    raise exception 'outbox_not_found';
  end if;

  -- Repetir o mesmo desfecho é idempotente; outro desfecho depois de terminal, não.
  if v_outbox.state in ('accepted', 'rejected', 'uncertain') then
    if v_outbox.state = p_outcome then
      return private.whatsapp_outbox_snapshot(v_outbox, true, false);
    end if;
    raise exception 'invalid_outbox_state';
  end if;
  if v_outbox.state <> 'sending' then
    raise exception 'invalid_outbox_state';
  end if;

  if p_outcome = 'accepted' then
    if p_provider_message_id is null then
      raise exception 'invalid_provider_message_id';
    end if;
    begin
      update public.whatsapp_outbox set state = 'accepted', provider_message_id = p_provider_message_id
      where id = v_outbox.id returning * into v_outbox;
      update public.messages
      set status = 'accepted', provider_message_id = p_provider_message_id, error_reason = null, status_updated_at = now()
      where id = v_outbox.message_id;
    exception
      when check_violation or unique_violation then
        raise exception 'invalid_provider_message_id';
    end;
  elsif p_outcome = 'rejected' then
    v_code := case when p_error_code ~ '^[a-z][a-z0-9_]{0,63}$' then p_error_code else 'send_rejected' end;
    update public.whatsapp_outbox set state = 'rejected', error_code = v_code
    where id = v_outbox.id returning * into v_outbox;
    update public.messages set status = 'failed', error_reason = v_code, status_updated_at = now()
    where id = v_outbox.message_id;
  else
    update public.whatsapp_outbox set state = 'uncertain'
    where id = v_outbox.id returning * into v_outbox;
    update public.messages set error_reason = 'send_uncertain', status_updated_at = now()
    where id = v_outbox.message_id;
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_outbox.workspace_id, null, 'whatsapp.message.send_' || p_outcome, 'message', v_outbox.message_id,
    jsonb_build_object('environment', v_env, 'provider', v_outbox.provider)
  );

  return private.whatsapp_outbox_snapshot(v_outbox, false, false);
end;
$body$;

-- EXECUTE só para service_role, em todas.
revoke all on function public.whatsapp_enable_channel_send(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.whatsapp_upsert_template(uuid, uuid, uuid, text, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.whatsapp_send_context(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.whatsapp_reserve_send(uuid, uuid, uuid, uuid, text, text, uuid, text[]) from public, anon, authenticated;
revoke all on function public.whatsapp_outbox_begin(uuid, integer) from public, anon, authenticated;
revoke all on function public.whatsapp_outbox_finish(uuid, text, text, text) from public, anon, authenticated;

grant execute on function public.whatsapp_enable_channel_send(uuid, uuid, uuid) to service_role;
grant execute on function public.whatsapp_upsert_template(uuid, uuid, uuid, text, text, text, text, text, integer) to service_role;
grant execute on function public.whatsapp_send_context(uuid, uuid, uuid) to service_role;
grant execute on function public.whatsapp_reserve_send(uuid, uuid, uuid, uuid, text, text, uuid, text[]) to service_role;
grant execute on function public.whatsapp_outbox_begin(uuid, integer) to service_role;
grant execute on function public.whatsapp_outbox_finish(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------
-- 10) send_message da A7: canal da B3 só envia pela outbox
-- ---------------------------------------------------------------------

create or replace function public.send_message(
  p_conversation_id uuid,
  p_body_text text,
  p_client_dedupe_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_conversation public.conversations;
  v_lead_assigned_to uuid;
  v_channel_id uuid;
  v_existing public.messages;
  v_message public.messages;
  v_wa_message_id text;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_conversation from public.conversations where id = p_conversation_id;
  if v_conversation.id is null then
    raise exception 'conversation_not_found';
  end if;

  if not private.has_workspace_role(
    v_conversation.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_conversation.workspace_id and user_id = v_actor and status = 'active';

  select assigned_to into v_lead_assigned_to from public.leads where id = v_conversation.lead_id;

  if not private.conversation_accessible_to_role(v_role, v_conversation.lead_id, v_lead_assigned_to, v_actor) then
    raise exception 'conversation_not_found';
  end if;

  -- B3.3: conversa de canal da B3 (com ambiente) envia só pela outbox. Este
  -- caminho simulado gravaria uma saída "enviada" que nunca saiu.
  if exists (
    select 1 from public.whatsapp_channels ch
    where ch.id = v_conversation.channel_id and ch.environment is not null
  ) then
    raise exception 'channel_uses_whatsapp_outbox';
  end if;

  select * into v_existing from public.messages
  where conversation_id = p_conversation_id and client_dedupe_key = p_client_dedupe_key;

  if v_existing.id is not null then
    return jsonb_build_object(
      'message_id', v_existing.id,
      'duplicate_submit', true,
      'content_conflict', v_existing.body_text is distinct from p_body_text,
      'direction', v_existing.direction,
      'body_text', v_existing.body_text,
      'status', v_existing.status,
      'status_updated_at', v_existing.status_updated_at,
      'error_reason', v_existing.error_reason,
      'sent_by', v_existing.sent_by,
      'created_at', v_existing.created_at,
      'wa_message_id', v_existing.wa_message_id
    );
  end if;

  if v_conversation.contact_id is null then
    raise exception 'conversation_not_linked';
  end if;

  if not private.contact_has_active_consent(v_conversation.contact_id, 'whatsapp', 'whatsapp_atendimento') then
    raise exception 'consent_required';
  end if;

  v_channel_id := v_conversation.channel_id;
  v_wa_message_id := 'wamid.sim.' || replace(gen_random_uuid()::text, '-', '');

  insert into public.messages (
    workspace_id, conversation_id, channel_id, direction, wa_message_id,
    client_dedupe_key, body_text, status, sent_by
  )
  values (
    v_conversation.workspace_id, p_conversation_id, v_channel_id, 'outbound', v_wa_message_id,
    p_client_dedupe_key, p_body_text, 'sent', v_actor
  )
  on conflict (conversation_id, client_dedupe_key) where client_dedupe_key is not null do nothing
  returning * into v_message;

  if v_message.id is null then
    -- Corrida perdida: outra chamada com a MESMA client_dedupe_key já
    -- comitou entre a checagem acima e este INSERT. Mesma reconciliação
    -- de conteúdo do caminho normal acima.
    select * into v_message from public.messages
    where conversation_id = p_conversation_id and client_dedupe_key = p_client_dedupe_key;
    return jsonb_build_object(
      'message_id', v_message.id,
      'duplicate_submit', true,
      'content_conflict', v_message.body_text is distinct from p_body_text,
      'direction', v_message.direction,
      'body_text', v_message.body_text,
      'status', v_message.status,
      'status_updated_at', v_message.status_updated_at,
      'error_reason', v_message.error_reason,
      'sent_by', v_message.sent_by,
      'created_at', v_message.created_at,
      'wa_message_id', v_message.wa_message_id
    );
  end if;

  update public.conversations set last_message_at = now() where id = p_conversation_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_conversation.workspace_id, v_actor, 'message.sent', 'message', v_message.id,
    jsonb_build_object('conversation_id', p_conversation_id, 'simulated', true)
  );

  return jsonb_build_object(
    'message_id', v_message.id,
    'duplicate_submit', false,
    'content_conflict', false,
    'direction', v_message.direction,
    'body_text', v_message.body_text,
    'status', v_message.status,
    'status_updated_at', v_message.status_updated_at,
    'error_reason', v_message.error_reason,
    'sent_by', v_message.sent_by,
    'created_at', v_message.created_at,
    'wa_message_id', v_message.wa_message_id
  );
end;
$body$;
