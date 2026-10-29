-- B3.2d-2b1 — modelo do domínio do WhatsApp sobre a A7
-- (docs/decisoes/b3-whatsapp-real.md §21).
--
-- Só schema, restrições, backfill, RLS, permissões e funções internas de
-- apoio. NADA aqui aplica mensagem real ao domínio, cria contato ou lead,
-- processa status da inbox ou liga o consumidor da B3.2d-2a: isso é da
-- B3.2d-2b2 (RPCs atômicas dos efeitos) e da B3.2d-2b3 (ligação).
--
-- A B3 EVOLUI a A7, sem tabela paralela de conversas ou mensagens:
--
-- IDENTIDADE. `whatsapp_identities` — uma por (canal, telefone) e/ou
-- (canal, BSUID): telefone sem BSUID, BSUID sem telefone ou os dois, nunca
-- nenhum. O telefone fica em texto, como já está em conversations.wa_id e
-- contact_phones (A3/A7: é por ele que o contato é casado). O BSUID é PII
-- nova: só índice cego (HMAC-SHA256, 32 bytes) e texto cifrado
-- (AES-256-GCM), calculados no Node com chaves PRÓPRIAS
-- (WHATSAPP_IDENTITY_*), nunca as da inbox, das credenciais ou dos
-- contatos. O escopo (ambiente, workspace e canal) entra no índice: o mesmo
-- BSUID em outro canal é outra identidade. Nenhum telefone é fabricado a
-- partir do BSUID. Telefone, BSUID e canal não mudam depois de gravados; um
-- identificador que faltava pode ser acrescentado.
--
-- CONVERSA. Ganha `identity_id` (obrigatório) e `wa_id` passa a ser
-- opcional (conversa só com BSUID). Compatibilidade: as funções da A7 não
-- mudam — um gatilho dá a identidade do telefone à conversa que nasce só
-- com `wa_id`, e confere que telefone e identidade nunca divergem.
--
-- MENSAGEM. Texto opcional, tipo de conteúdo, origem técnica
-- (`origin`) e classificação do remetente (`sender_classification`)
-- SEPARADAS, correlação positiva (chatbot só com ela), ids do provedor e
-- custo informado pelo provedor (estimado × final; só o final entra no
-- total cobrado; o final não muda; failed nunca tem custo final). As
-- funções da A7 não mudam: um gatilho classifica pelo CAMINHO de inserção
-- (recebida → inbound/unresolved; enviada por usuário do CRM →
-- crm/internal), nunca pelo texto.
--
-- STATUS. `accepted` (migration anterior). A regra da A7 continua a mesma;
-- a regra da B3 (delivered/read corrigem failed) fica numa função própria,
-- para a B3.2d-2b2 usar.
--
-- IDENTIDADES INTERNAS e LEDGER DE EFEITOS: tabelas próprias, sem acesso
-- direto; ver as seções abaixo.
--
-- BACKFILL determinístico e idempotente (private.whatsapp_domain_backfill):
-- uma identidade por (canal, telefone) das conversas existentes; mensagens
-- recebidas → inbound/unresolved, enviadas → crm/internal, todas texto.
-- Nenhuma vira chatbot, nenhuma é classificada pelo texto, nenhum contato ou
-- lead é criado. Reversão (documentada no §21): apagar as colunas novas e
-- as três tabelas e voltar `wa_id`/`body_text`/`wa_message_id` a NOT NULL —
-- toda linha antiga ainda tem os três.

-- ---------------------------------------------------------------------
-- Vocabulário
-- ---------------------------------------------------------------------

-- `internal` nunca é origem: é classificação do remetente.
create type public.whatsapp_message_origin as enum ('inbound', 'crm', 'business_app', 'chatbot', 'external_api', 'history');

create type public.whatsapp_sender_classification as enum ('external', 'internal', 'automation', 'unresolved');

-- ---------------------------------------------------------------------
-- Identidades do WhatsApp (uma por canal)
-- ---------------------------------------------------------------------

create table public.whatsapp_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  channel_id uuid not null,
  -- NULL só para o canal legado da A7 (simulador sem ambiente).
  environment public.whatsapp_environment,
  provider public.whatsapp_provider not null,
  phone_e164 text,
  bsuid_blind_index bytea,
  bsuid_ciphertext bytea,
  bsuid_key_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_identities_workspace_id_id_key unique (workspace_id, id),
  constraint whatsapp_identities_channel_fkey
    foreign key (workspace_id, channel_id) references public.whatsapp_channels (workspace_id, id) on delete restrict,
  -- Para canal com ambiente, o ambiente e o provedor da identidade são os
  -- do canal (o canal legado, sem ambiente, é conferido pelo gatilho).
  constraint whatsapp_identities_channel_identity_fkey
    foreign key (workspace_id, channel_id, environment, provider)
    references public.whatsapp_channels (workspace_id, id, environment, provider) on delete restrict,
  constraint whatsapp_identities_phone_check check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint whatsapp_identities_bsuid_complete check (
    (bsuid_blind_index is null) = (bsuid_ciphertext is null) and (bsuid_blind_index is null) = (bsuid_key_version is null)
  ),
  constraint whatsapp_identities_bsuid_format check (
    bsuid_blind_index is null
    or (octet_length(bsuid_blind_index) = 32 and octet_length(bsuid_ciphertext) between 29 and 512
        and bsuid_key_version ~ '^[A-Za-z0-9_-]{1,32}$')
  ),
  constraint whatsapp_identities_not_empty check (phone_e164 is not null or bsuid_blind_index is not null)
);

comment on table public.whatsapp_identities is
  'Identidade do contato no WhatsApp, por canal: telefone (E.164, como na A7), BSUID (só índice cego e texto cifrado) ou os dois; nunca nenhum. Sem acesso direto; usada pelas funções do domínio.';

create unique index whatsapp_identities_channel_phone_key
  on public.whatsapp_identities (channel_id, phone_e164) where phone_e164 is not null;
create unique index whatsapp_identities_channel_bsuid_key
  on public.whatsapp_identities (channel_id, bsuid_blind_index) where bsuid_blind_index is not null;
create index whatsapp_identities_workspace_idx on public.whatsapp_identities (workspace_id);

create trigger whatsapp_identities_set_updated_at
  before update on public.whatsapp_identities
  for each row execute function private.set_updated_at();

-- Ambiente e provedor sempre os do canal; canal, telefone e BSUID nunca
-- mudam depois de gravados (um que faltava pode ser acrescentado).
create function private.whatsapp_identities_guard()
returns trigger
language plpgsql
set search_path = ''
as $body$
declare
  v_channel public.whatsapp_channels;
begin
  if tg_op = 'INSERT' then
    select * into v_channel from public.whatsapp_channels c
    where c.id = new.channel_id and c.workspace_id = new.workspace_id;
    if v_channel.id is null
       or v_channel.environment is distinct from new.environment
       or v_channel.provider is distinct from new.provider then
      raise exception using errcode = '23503', message = 'identity_channel_mismatch';
    end if;
    return new;
  end if;

  if new.workspace_id is distinct from old.workspace_id
     or new.channel_id is distinct from old.channel_id
     or new.environment is distinct from old.environment
     or new.provider is distinct from old.provider
     or (old.phone_e164 is not null and new.phone_e164 is distinct from old.phone_e164)
     or (old.bsuid_blind_index is not null and (
          new.bsuid_blind_index is distinct from old.bsuid_blind_index
          or new.bsuid_ciphertext is distinct from old.bsuid_ciphertext
          or new.bsuid_key_version is distinct from old.bsuid_key_version)) then
    raise exception 'identity_immutable';
  end if;
  return new;
end;
$body$;

revoke all on function private.whatsapp_identities_guard() from public, anon, authenticated, service_role;

create trigger whatsapp_identities_guard
  before insert or update on public.whatsapp_identities
  for each row execute function private.whatsapp_identities_guard();

-- ---------------------------------------------------------------------
-- Conversas: identidade obrigatória, telefone opcional
-- ---------------------------------------------------------------------

alter table public.conversations
  add column identity_id uuid;

alter table public.conversations
  add constraint conversations_identity_same_workspace_fkey
    foreign key (workspace_id, identity_id) references public.whatsapp_identities (workspace_id, id) on delete restrict;

alter table public.conversations alter column wa_id drop not null;

-- ---------------------------------------------------------------------
-- Mensagens: texto opcional, conteúdo, origem, classificação, provedor,
-- custo
-- ---------------------------------------------------------------------

alter table public.messages alter column body_text drop not null;
alter table public.messages alter column wa_message_id drop not null;

alter table public.messages
  add column content_kind text not null default 'text',
  add column origin public.whatsapp_message_origin,
  add column sender_classification public.whatsapp_sender_classification,
  -- Prova POSITIVA e confiável da origem (correlação com a própria outbox
  -- do CRM ou com um pedido registrado do chatbot) — nunca o formato de um
  -- identificador do provedor.
  add column origin_correlation_kind text,
  add column origin_correlation_ref text,
  add column provider public.whatsapp_provider,
  add column provider_message_id text,
  -- Valor OPACO de correlação devolvido pelo provedor; não prova autoria.
  add column provider_external_id text,
  add column provider_cost_amount numeric(18, 6),
  add column provider_cost_currency text,
  -- Categoria do provedor como valor aberto e bem formado (nenhuma tarifa
  -- fica no código ou no banco).
  add column provider_cost_category text,
  add column provider_cost_finality text,
  add column provider_cost_billable_amount numeric(18, 6)
    generated always as (case when provider_cost_finality = 'final' then provider_cost_amount end) stored;

-- ---------------------------------------------------------------------
-- Backfill — determinístico e idempotente
-- ---------------------------------------------------------------------

create function private.whatsapp_domain_backfill()
returns jsonb
language plpgsql
set search_path = ''
as $body$
declare
  v_identities integer;
  v_conversations integer;
  v_inbound integer;
  v_outbound integer;
begin
  -- Uma identidade por (canal, telefone) já usado numa conversa.
  insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, phone_e164)
  select distinct c.workspace_id, c.channel_id, ch.environment, ch.provider, c.wa_id
  from public.conversations c
  join public.whatsapp_channels ch on ch.id = c.channel_id and ch.workspace_id = c.workspace_id
  where c.identity_id is null and c.wa_id is not null
  on conflict (channel_id, phone_e164) where phone_e164 is not null do nothing;
  get diagnostics v_identities = row_count;

  update public.conversations c
  set identity_id = i.id
  from public.whatsapp_identities i
  where c.identity_id is null and i.channel_id = c.channel_id and i.phone_e164 = c.wa_id;
  get diagnostics v_conversations = row_count;

  -- Pelo caminho de inserção, nunca pelo texto: a A7 só gravava mensagem
  -- recebida do simulador (remetente não resolvido) e enviada por usuário
  -- do CRM (sent_by sempre preenchido).
  update public.messages
  set origin = 'inbound', sender_classification = 'unresolved'
  where origin is null and direction = 'inbound';
  get diagnostics v_inbound = row_count;

  update public.messages
  set origin = 'crm', sender_classification = 'internal'
  where origin is null and direction = 'outbound' and sent_by is not null;
  get diagnostics v_outbound = row_count;

  return jsonb_build_object(
    'identities_created', v_identities,
    'conversations_linked', v_conversations,
    'messages_classified', v_inbound + v_outbound
  );
end;
$body$;

revoke all on function private.whatsapp_domain_backfill() from public, anon, authenticated, service_role;

-- O backfill não muda updated_at das linhas antigas.
alter table public.conversations disable trigger conversations_set_updated_at;
alter table public.messages disable trigger messages_set_updated_at;
select private.whatsapp_domain_backfill();
alter table public.conversations enable trigger conversations_set_updated_at;
alter table public.messages enable trigger messages_set_updated_at;

alter table public.conversations alter column identity_id set not null;
alter table public.messages alter column origin set not null;
alter table public.messages alter column sender_classification set not null;

create unique index conversations_identity_id_key on public.conversations (identity_id);
create unique index messages_channel_provider_message_id_key
  on public.messages (channel_id, provider_message_id) where provider_message_id is not null;

-- ---------------------------------------------------------------------
-- Restrições das mensagens
-- ---------------------------------------------------------------------

-- As duas regras da A7 que presumiam "toda saída é do CRM" viram regras
-- da ORIGEM crm (eco do aplicativo, chatbot e API não têm autor do CRM).
alter table public.messages drop constraint messages_direction_dedupe_key_consistency;
alter table public.messages drop constraint messages_direction_sent_by_consistency;

alter table public.messages
  add constraint messages_content_kind_check check (content_kind in (
    'text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts',
    'interactive', 'button', 'reaction', 'order', 'request_welcome', 'template', 'unsupported', 'other'
  )),
  add constraint messages_text_requires_body check (content_kind <> 'text' or body_text is not null),
  add constraint messages_provider_id_present check (wa_message_id is not null or provider_message_id is not null),
  add constraint messages_provider_ids_format check (
    (provider_message_id is null or provider_message_id ~ '^\S{1,255}$')
    and (provider_external_id is null or provider_external_id ~ '^\S{1,255}$')
    and (provider_message_id is null or provider is not null)
  ),
  add constraint messages_origin_direction check (
    (origin = 'inbound' and direction = 'inbound')
    or (origin in ('crm', 'business_app', 'chatbot', 'external_api') and direction = 'outbound')
    or origin = 'history'
  ),
  add constraint messages_origin_classification check (
    (origin = 'inbound' and sender_classification in ('external', 'internal', 'unresolved'))
    or (origin = 'crm' and sender_classification in ('internal', 'automation'))
    or (origin = 'business_app' and sender_classification = 'internal')
    or (origin = 'chatbot' and sender_classification = 'automation')
    or (origin = 'external_api' and sender_classification in ('unresolved', 'automation'))
    or origin = 'history'
  ),
  add constraint messages_origin_correlation check (
    (origin_correlation_kind is null) = (origin_correlation_ref is null)
    and (origin_correlation_kind is null or origin_correlation_kind in ('crm_outbox', 'chatbot_request'))
    and (origin_correlation_ref is null or origin_correlation_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    -- chatbot SÓ com correlação positiva com um pedido do chatbot, e essa
    -- correlação só com a origem chatbot.
    and (origin = 'chatbot') = (coalesce(origin_correlation_kind, '') = 'chatbot_request')
    and (origin_correlation_kind is distinct from 'crm_outbox' or origin = 'crm')
  ),
  add constraint messages_sent_by_only_crm check (sent_by is null or (origin = 'crm' and direction = 'outbound')),
  add constraint messages_dedupe_key_only_crm check (client_dedupe_key is null or (origin = 'crm' and direction = 'outbound')),
  add constraint messages_crm_internal_has_author check (
    not (origin = 'crm' and sender_classification = 'internal') or (sent_by is not null and client_dedupe_key is not null)
  ),
  add constraint messages_provider_cost_complete check (
    (provider_cost_amount is null) = (provider_cost_currency is null)
    and (provider_cost_amount is null) = (provider_cost_finality is null)
    and (provider_cost_category is null or provider_cost_amount is not null)
  ),
  add constraint messages_provider_cost_format check (
    (provider_cost_amount is null or provider_cost_amount >= 0)
    and (provider_cost_currency is null or provider_cost_currency ~ '^[A-Z]{3}$')
    and (provider_cost_category is null or provider_cost_category ~ '^[a-z][a-z0-9_]{0,63}$')
    and (provider_cost_finality is null or provider_cost_finality in ('estimated', 'final'))
  ),
  -- Mensagem que falhou não é cobrada: o custo que vier fica estimativa.
  add constraint messages_failed_cost_not_final check (status <> 'failed' or provider_cost_finality is distinct from 'final');

-- ---------------------------------------------------------------------
-- Gatilhos de compatibilidade com a A7
-- ---------------------------------------------------------------------

-- A conversa que nasce pela A7 (só com wa_id) recebe a identidade do
-- telefone no canal dela. Telefone e identidade nunca divergem.
create function private.conversations_identity_guard()
returns trigger
language plpgsql
set search_path = ''
as $body$
declare
  v_channel public.whatsapp_channels;
  v_identity public.whatsapp_identities;
begin
  if tg_op = 'UPDATE'
     and new.identity_id is not distinct from old.identity_id
     and new.wa_id is not distinct from old.wa_id
     and new.channel_id is not distinct from old.channel_id
     and new.workspace_id is not distinct from old.workspace_id then
    return new;
  end if;

  if new.identity_id is null then
    if new.wa_id is null then
      raise exception 'conversation_identity_required';
    end if;
    select * into v_channel from public.whatsapp_channels c
    where c.id = new.channel_id and c.workspace_id = new.workspace_id;
    if v_channel.id is null then
      raise exception 'conversation_identity_mismatch';
    end if;
    insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, phone_e164)
    values (new.workspace_id, new.channel_id, v_channel.environment, v_channel.provider, new.wa_id)
    on conflict (channel_id, phone_e164) where phone_e164 is not null do nothing;
    select i.id into new.identity_id from public.whatsapp_identities i
    where i.channel_id = new.channel_id and i.phone_e164 = new.wa_id;
  end if;

  select * into v_identity from public.whatsapp_identities i where i.id = new.identity_id;
  if v_identity.id is null
     or v_identity.channel_id is distinct from new.channel_id
     or v_identity.workspace_id is distinct from new.workspace_id
     or (new.wa_id is not null and v_identity.phone_e164 is distinct from new.wa_id) then
    raise exception 'conversation_identity_mismatch';
  end if;
  return new;
end;
$body$;

revoke all on function private.conversations_identity_guard() from public, anon, authenticated, service_role;

create trigger conversations_identity_guard
  before insert or update on public.conversations
  for each row execute function private.conversations_identity_guard();

-- Mensagem inserida pela A7 (sem origem nem classificação): classificada
-- pelo CAMINHO de inserção, nunca pelo texto. Qualquer outro caminho tem de
-- informar as duas — sem isso, a inserção falha (NOT NULL).
create function private.messages_default_classification()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if new.origin is null and new.sender_classification is null then
    if new.direction = 'inbound' then
      new.origin := 'inbound';
      new.sender_classification := 'unresolved';
    elsif new.direction = 'outbound' and new.sent_by is not null then
      new.origin := 'crm';
      new.sender_classification := 'internal';
    end if;
  end if;
  return new;
end;
$body$;

revoke all on function private.messages_default_classification() from public, anon, authenticated, service_role;

create trigger messages_default_classification
  before insert on public.messages
  for each row execute function private.messages_default_classification();

-- Custo final informado pelo provedor nunca é substituído.
create function private.messages_provider_cost_guard()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if old.provider_cost_finality = 'final'
     and (new.provider_cost_amount, new.provider_cost_currency, new.provider_cost_category, new.provider_cost_finality)
         is distinct from (old.provider_cost_amount, old.provider_cost_currency, old.provider_cost_category, old.provider_cost_finality) then
    raise exception 'provider_cost_final_immutable';
  end if;
  return new;
end;
$body$;

revoke all on function private.messages_provider_cost_guard() from public, anon, authenticated, service_role;

create trigger messages_provider_cost_guard
  before update on public.messages
  for each row execute function private.messages_provider_cost_guard();

-- ---------------------------------------------------------------------
-- Status
-- ---------------------------------------------------------------------

-- Rank da A7: `accepted` no nível de `queued`. Para os status antigos nada
-- muda, e apply_message_status_event (A7) continua igual.
create or replace function private.message_status_rank(p_status public.message_status)
returns smallint
language sql
immutable
set search_path = ''
as $body$
  select case p_status
    when 'queued' then 0
    when 'accepted' then 0
    when 'sent' then 1
    when 'failed' then 1
    when 'delivered' then 2
    when 'read' then 3
  end;
$body$;

comment on function private.message_status_rank(public.message_status) is
  'Rank da A7: queued/accepted(0) < sent(1) < delivered(2) < read(3); failed empata com sent. A regra da B3 está em private.whatsapp_message_status_should_apply.';

-- Regra da B3 (§1.3, src/server/whatsapp/status-projection.ts): avança em
-- accepted → sent → delivered → read; failed a partir de qualquer status
-- antes da entrega; delivered/read corrigem failed; nada regride; accepted
-- e sent depois de failed não apagam o failed.
create function private.whatsapp_message_status_should_apply(
  p_current public.message_status,
  p_incoming public.message_status
)
returns boolean
language sql
immutable
set search_path = ''
as $body$
  select case
    when p_incoming is null then false
    when p_current is null then true
    when p_current = p_incoming then false
    when p_incoming = 'failed' then p_current not in ('delivered', 'read')
    when p_current = 'failed' then p_incoming in ('delivered', 'read')
    else (case p_incoming when 'queued' then 0 when 'accepted' then 1 when 'sent' then 2 when 'delivered' then 3 when 'read' then 4 end)
       > (case p_current when 'queued' then 0 when 'accepted' then 1 when 'sent' then 2 when 'delivered' then 3 when 'read' then 4 end)
  end;
$body$;

revoke all on function private.whatsapp_message_status_should_apply(public.message_status, public.message_status) from public, anon, authenticated, service_role;

-- Lead só para inbound + external: identidade interna, automação, eco,
-- histórico, API sem prova ou status nunca criam lead.
create function private.whatsapp_may_create_lead(
  p_origin public.whatsapp_message_origin,
  p_classification public.whatsapp_sender_classification
)
returns boolean
language sql
immutable
set search_path = ''
as $body$
  select coalesce(p_origin = 'inbound' and p_classification = 'external', false);
$body$;

revoke all on function private.whatsapp_may_create_lead(public.whatsapp_message_origin, public.whatsapp_sender_classification) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Identidades internas (números e BSUIDs do próprio escritório)
-- ---------------------------------------------------------------------

create table public.whatsapp_internal_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  channel_id uuid not null,
  environment public.whatsapp_environment not null,
  provider public.whatsapp_provider not null,
  label text not null check (char_length(btrim(label)) between 1 and 120),
  phone_e164 text,
  bsuid_blind_index bytea,
  bsuid_ciphertext bytea,
  bsuid_key_version text,
  is_active boolean not null default true,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_internal_identities_channel_identity_fkey
    foreign key (workspace_id, channel_id, environment, provider)
    references public.whatsapp_channels (workspace_id, id, environment, provider) on delete cascade,
  constraint whatsapp_internal_identities_phone_check check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint whatsapp_internal_identities_bsuid_complete check (
    (bsuid_blind_index is null) = (bsuid_ciphertext is null) and (bsuid_blind_index is null) = (bsuid_key_version is null)
  ),
  constraint whatsapp_internal_identities_bsuid_format check (
    bsuid_blind_index is null
    or (octet_length(bsuid_blind_index) = 32 and octet_length(bsuid_ciphertext) between 29 and 512
        and bsuid_key_version ~ '^[A-Za-z0-9_-]{1,32}$')
  ),
  constraint whatsapp_internal_identities_not_empty check (phone_e164 is not null or bsuid_blind_index is not null)
);

comment on table public.whatsapp_internal_identities is
  'Números e BSUIDs do próprio escritório, por workspace, ambiente e canal. Remetente que casa com uma identidade interna ativa é `internal` e nunca cria lead. Administrada só por owner/admin, por funções de service_role com ambiente autenticado.';

create unique index whatsapp_internal_identities_channel_phone_key
  on public.whatsapp_internal_identities (channel_id, phone_e164) where phone_e164 is not null;
create unique index whatsapp_internal_identities_channel_bsuid_key
  on public.whatsapp_internal_identities (channel_id, bsuid_blind_index) where bsuid_blind_index is not null;
create index whatsapp_internal_identities_workspace_idx on public.whatsapp_internal_identities (workspace_id, environment);

create trigger whatsapp_internal_identities_set_updated_at
  before update on public.whatsapp_internal_identities
  for each row execute function private.set_updated_at();

-- Só o rótulo e o estado ativo mudam.
create function private.whatsapp_internal_identities_guard()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.channel_id is distinct from old.channel_id
     or new.environment is distinct from old.environment
     or new.provider is distinct from old.provider
     or new.phone_e164 is distinct from old.phone_e164
     or new.bsuid_blind_index is distinct from old.bsuid_blind_index
     or new.bsuid_ciphertext is distinct from old.bsuid_ciphertext
     or new.bsuid_key_version is distinct from old.bsuid_key_version
     or new.created_by is distinct from old.created_by then
    raise exception 'internal_identity_immutable';
  end if;
  return new;
end;
$body$;

revoke all on function private.whatsapp_internal_identities_guard() from public, anon, authenticated, service_role;

create trigger whatsapp_internal_identities_guard
  before update on public.whatsapp_internal_identities
  for each row execute function private.whatsapp_internal_identities_guard();

-- Projeção segura: nunca índice cego, cifra ou versão de chave.
create function private.whatsapp_internal_identity_safe_row(p_row public.whatsapp_internal_identities)
returns jsonb
language sql
stable
set search_path = ''
as $body$
  select jsonb_build_object(
    'id', p_row.id,
    'channel_id', p_row.channel_id,
    'label', p_row.label,
    'phone_e164', p_row.phone_e164,
    'has_bsuid', p_row.bsuid_blind_index is not null,
    'is_active', p_row.is_active,
    'created_at', p_row.created_at,
    'updated_at', p_row.updated_at
  );
$body$;

revoke all on function private.whatsapp_internal_identity_safe_row(public.whatsapp_internal_identities) from public, anon, authenticated, service_role;

create function public.whatsapp_list_internal_identities(p_workspace_id uuid, p_actor_user_id uuid, p_channel_id uuid)
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
  if not exists (
    select 1 from public.whatsapp_channels c
    where c.id = p_channel_id and c.workspace_id = p_workspace_id and c.environment = v_env
  ) then
    raise exception 'channel_not_found';
  end if;

  return coalesce((
    select jsonb_agg(private.whatsapp_internal_identity_safe_row(i) order by i.created_at, i.id)
    from public.whatsapp_internal_identities i
    where i.channel_id = p_channel_id and i.workspace_id = p_workspace_id and i.environment = v_env
  ), '[]'::jsonb);
end;
$body$;

-- O BSUID chega como índice cego e texto cifrado (base64), calculados no
-- servidor com as chaves próprias; nunca em claro.
create function public.whatsapp_create_internal_identity(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_channel_id uuid,
  p_label text,
  p_phone_e164 text,
  p_bsuid_blind_index text,
  p_bsuid_ciphertext text,
  p_bsuid_key_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels := private.whatsapp_lock_managed_channel(p_channel_id, p_workspace_id, p_actor_user_id, v_env);
  v_blind bytea;
  v_cipher bytea;
  v_row public.whatsapp_internal_identities;
begin
  if p_label is null or char_length(btrim(p_label)) not between 1 and 120
     or (p_phone_e164 is not null and p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$')
     or (p_bsuid_blind_index is null) <> (p_bsuid_ciphertext is null)
     or (p_bsuid_blind_index is null) <> (p_bsuid_key_version is null)
     or (p_phone_e164 is null and p_bsuid_blind_index is null) then
    raise exception 'invalid_internal_identity';
  end if;

  if p_bsuid_blind_index is not null then
    begin
      v_blind := decode(p_bsuid_blind_index, 'base64');
      v_cipher := decode(p_bsuid_ciphertext, 'base64');
    exception when others then
      raise exception 'invalid_internal_identity';
    end;
  end if;

  begin
    insert into public.whatsapp_internal_identities (
      workspace_id, channel_id, environment, provider, label, phone_e164,
      bsuid_blind_index, bsuid_ciphertext, bsuid_key_version, created_by
    ) values (
      v_channel.workspace_id, v_channel.id, v_env, v_channel.provider, btrim(p_label), p_phone_e164,
      v_blind, v_cipher, p_bsuid_key_version, p_actor_user_id
    )
    returning * into v_row;
  exception
    when unique_violation then
      raise exception 'internal_identity_taken';
    when check_violation then
      raise exception 'invalid_internal_identity';
  end;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_channel.workspace_id, p_actor_user_id, 'whatsapp.internal_identity.created', 'whatsapp_internal_identity', v_row.id,
    jsonb_build_object('environment', v_env, 'provider', v_channel.provider, 'channel_id', v_channel.id,
                       'has_phone', v_row.phone_e164 is not null, 'has_bsuid', v_row.bsuid_blind_index is not null)
  );

  return private.whatsapp_internal_identity_safe_row(v_row);
end;
$body$;

create function public.whatsapp_set_internal_identity_active(
  p_identity_id uuid,
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_row public.whatsapp_internal_identities;
begin
  if p_actor_user_id is null or p_workspace_id is null then
    raise exception 'actor_required';
  end if;
  if not private.whatsapp_actor_can_manage(p_workspace_id, p_actor_user_id) then
    raise exception 'insufficient_permission';
  end if;
  if p_active is null then
    raise exception 'invalid_internal_identity';
  end if;

  select * into v_row from public.whatsapp_internal_identities i
  where i.id = p_identity_id and i.workspace_id = p_workspace_id and i.environment = v_env
  for update;
  if v_row.id is null then
    raise exception 'internal_identity_not_found';
  end if;

  if v_row.is_active is distinct from p_active then
    update public.whatsapp_internal_identities set is_active = p_active where id = v_row.id
    returning * into v_row;

    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (
      v_row.workspace_id, p_actor_user_id,
      case when p_active then 'whatsapp.internal_identity.activated' else 'whatsapp.internal_identity.deactivated' end,
      'whatsapp_internal_identity', v_row.id,
      jsonb_build_object('environment', v_env, 'provider', v_row.provider, 'channel_id', v_row.channel_id)
    );
  end if;

  return private.whatsapp_internal_identity_safe_row(v_row);
end;
$body$;

-- Casamento interno, para a B3.2d-2b2: identidade interna ATIVA do mesmo
-- canal, pelo telefone ou pelo índice cego do BSUID.
create function private.whatsapp_is_internal_identity(p_channel_id uuid, p_phone_e164 text, p_bsuid_blind_index bytea)
returns boolean
language sql
stable
set search_path = ''
as $body$
  select exists (
    select 1 from public.whatsapp_internal_identities i
    where i.channel_id = p_channel_id
      and i.is_active
      and ((p_phone_e164 is not null and i.phone_e164 = p_phone_e164)
        or (p_bsuid_blind_index is not null and i.bsuid_blind_index = p_bsuid_blind_index))
  );
$body$;

revoke all on function private.whatsapp_is_internal_identity(uuid, text, bytea) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Ledger técnico de efeitos (idempotência pelo evento estável)
-- ---------------------------------------------------------------------

-- Alvos das FKs compostas do ledger: a inbox inteira (id e o contexto do
-- evento) e a mensagem com o canal dela. Só acrescentam unicidade sobre
-- colunas que já são únicas pelo id.
alter table public.whatsapp_webhook_inbox
  add constraint whatsapp_webhook_inbox_effect_ref_key
    unique (id, workspace_id, channel_id, environment, provider, provider_event_id);
alter table public.messages
  add constraint messages_id_workspace_channel_key unique (id, workspace_id, channel_id);

-- Não é uma segunda tabela de mensagens: só a chave do evento, o efeito
-- declarado e referências. Nenhum corpo, telefone, BSUID, mídia ou payload.
create table public.whatsapp_effect_ledger (
  id uuid primary key default gen_random_uuid(),
  environment public.whatsapp_environment not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  channel_id uuid not null,
  provider public.whatsapp_provider not null,
  provider_event_id text not null check (provider_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  effect text not null check (effect in (
    'message.inbound', 'message.outbound_observed', 'message.status', 'contact.identity_changed', 'account', 'ignored', 'unsupported'
  )),
  -- Todo efeito nasce de uma entrada da inbox.
  inbox_id uuid not null,
  -- Só quando o efeito produz mensagem (conta, identidade ou evento
  -- técnico não produzem).
  message_id uuid,
  recorded_at timestamptz not null default now(),
  -- O ambiente, o workspace e o provedor são os do canal: nenhum efeito
  -- cruza canal, workspace ou ambiente.
  constraint whatsapp_effect_ledger_channel_identity_fkey
    foreign key (workspace_id, channel_id, environment, provider)
    references public.whatsapp_channels (workspace_id, id, environment, provider) on delete restrict,
  -- A inbox é a do MESMO evento: workspace, canal, ambiente, provedor e
  -- provider_event_id iguais aos dela. Sem ação na remoção: o expurgo
  -- preserva a inbox como tombstone, e nada pode apagar a origem de um
  -- efeito (NO ACTION, conferido no fim do comando, deixa a cascata do
  -- workspace apagar os dois juntos).
  constraint whatsapp_effect_ledger_inbox_fkey
    foreign key (inbox_id) references public.whatsapp_webhook_inbox (id),
  -- A mensagem é do mesmo workspace E do mesmo canal. Se ela for
  -- removida, só message_id zera; o registro técnico fica.
  constraint whatsapp_effect_ledger_message_fkey
    foreign key (message_id, workspace_id, channel_id)
    references public.messages (id, workspace_id, channel_id) on delete set null (message_id)
);

comment on table public.whatsapp_effect_ledger is
  'Ledger técnico: um efeito por (ambiente, canal, provedor, id estável do evento), sempre preso à entrada da inbox do mesmo evento e, quando houver, à mensagem do mesmo canal. Sem conteúdo do webhook. Sem acesso direto; só a reserva interna, que lê o contexto da inbox.';

create unique index whatsapp_effect_ledger_event_key
  on public.whatsapp_effect_ledger (environment, channel_id, provider, provider_event_id);
create index whatsapp_effect_ledger_workspace_idx on public.whatsapp_effect_ledger (workspace_id);
create index whatsapp_effect_ledger_inbox_idx on public.whatsapp_effect_ledger (inbox_id);
create index whatsapp_effect_ledger_message_idx on public.whatsapp_effect_ledger (message_id) where message_id is not null;

-- Reserva o efeito de uma entrada da inbox. O chamador informa só a
-- entrada e o efeito; ambiente, workspace, canal, provedor e
-- provider_event_id vêm da própria linha da inbox, no ambiente autenticado.
-- Resultado:
--   reserved  — primeira vez: ledger_id é a linha nova;
--   duplicate — a mesma entrada já reservou o MESMO efeito: ledger_id é a
--               linha existente; nenhum efeito novo;
--   conflict  — a chave estável já foi reservada com outro efeito ou por
--               outra entrada: integridade quebrada, nunca tratada como
--               duplicação; ledger_id nulo.
-- Para a B3.2d-2b2: a RPC do efeito trava a inbox, confere token e lease
-- e chama esta reserva na mesma transação; se ela falhar depois, a reserva
-- é desfeita junto. Uma reserva concorrente da mesma chave espera a
-- primeira terminar (índice único) e então vê duplicate ou conflict, ou
-- reserva, se a primeira foi desfeita.
create function private.whatsapp_effect_ledger_reserve(
  p_inbox_id uuid,
  p_effect text,
  out outcome text,
  out ledger_id uuid
)
language plpgsql
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_inbox public.whatsapp_webhook_inbox;
  v_existing public.whatsapp_effect_ledger;
begin
  select i.* into v_inbox
  from public.whatsapp_webhook_inbox i
  where i.id = p_inbox_id and i.environment = v_env;
  if not found then
    raise exception 'ledger_inbox_not_found';
  end if;

  insert into public.whatsapp_effect_ledger (environment, workspace_id, channel_id, provider, provider_event_id, effect, inbox_id)
  values (v_inbox.environment, v_inbox.workspace_id, v_inbox.channel_id, v_inbox.provider, v_inbox.provider_event_id, p_effect, v_inbox.id)
  on conflict (environment, channel_id, provider, provider_event_id) do nothing
  returning id into ledger_id;
  if ledger_id is not null then
    outcome := 'reserved';
    return;
  end if;

  -- A chave já existe (gravada por quem terminou antes, inclusive numa
  -- transação concorrente pela qual o INSERT esperou).
  select l.* into v_existing
  from public.whatsapp_effect_ledger l
  where l.environment = v_inbox.environment and l.channel_id = v_inbox.channel_id
    and l.provider = v_inbox.provider and l.provider_event_id = v_inbox.provider_event_id;
  if not found then
    raise exception 'ledger_reserve_inconsistent';
  end if;
  if v_existing.inbox_id = v_inbox.id and v_existing.effect = p_effect then
    outcome := 'duplicate';
    ledger_id := v_existing.id;
  else
    outcome := 'conflict';
    ledger_id := null;
  end if;
end;
$body$;

revoke all on function private.whatsapp_effect_ledger_reserve(uuid, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- RLS e permissões: nenhuma das três tabelas é acessível diretamente
-- ---------------------------------------------------------------------

alter table public.whatsapp_identities enable row level security;
alter table public.whatsapp_identities force row level security;
alter table public.whatsapp_internal_identities enable row level security;
alter table public.whatsapp_internal_identities force row level security;
alter table public.whatsapp_effect_ledger enable row level security;
alter table public.whatsapp_effect_ledger force row level security;

revoke all on table public.whatsapp_identities from public, anon, authenticated, service_role;
revoke all on table public.whatsapp_internal_identities from public, anon, authenticated, service_role;
revoke all on table public.whatsapp_effect_ledger from public, anon, authenticated, service_role;

create policy whatsapp_identities_select_deny on public.whatsapp_identities for select to authenticated using (false);
create policy whatsapp_identities_insert_deny on public.whatsapp_identities for insert to authenticated with check (false);
create policy whatsapp_identities_update_deny on public.whatsapp_identities for update to authenticated using (false);
create policy whatsapp_identities_delete_deny on public.whatsapp_identities for delete to authenticated using (false);

create policy whatsapp_internal_identities_select_deny on public.whatsapp_internal_identities for select to authenticated using (false);
create policy whatsapp_internal_identities_insert_deny on public.whatsapp_internal_identities for insert to authenticated with check (false);
create policy whatsapp_internal_identities_update_deny on public.whatsapp_internal_identities for update to authenticated using (false);
create policy whatsapp_internal_identities_delete_deny on public.whatsapp_internal_identities for delete to authenticated using (false);

create policy whatsapp_effect_ledger_select_deny on public.whatsapp_effect_ledger for select to authenticated using (false);
create policy whatsapp_effect_ledger_insert_deny on public.whatsapp_effect_ledger for insert to authenticated with check (false);
create policy whatsapp_effect_ledger_update_deny on public.whatsapp_effect_ledger for update to authenticated using (false);
create policy whatsapp_effect_ledger_delete_deny on public.whatsapp_effect_ledger for delete to authenticated using (false);

-- EXECUTE das RPCs de identidade interna só para service_role.
revoke all on function public.whatsapp_list_internal_identities(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.whatsapp_create_internal_identity(uuid, uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.whatsapp_set_internal_identity_active(uuid, uuid, uuid, boolean) from public, anon, authenticated;

grant execute on function public.whatsapp_list_internal_identities(uuid, uuid, uuid) to service_role;
grant execute on function public.whatsapp_create_internal_identity(uuid, uuid, uuid, text, text, text, text, text) to service_role;
grant execute on function public.whatsapp_set_internal_identity_active(uuid, uuid, uuid, boolean) to service_role;
