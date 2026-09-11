-- A7 — Conversas + simulador de WhatsApp: schema.
--
-- Ver docs/decisoes/a7-conversas.md para o raciocínio completo (formato dos
-- eventos, resolução de workspace/contato/lead, idempotência em camadas,
-- estados de mensagem, consentimento). Resumo do que este arquivo cria:
--
--   whatsapp_channels     — canal autorizado (real ou simulador) que
--                            resolve o workspace de um evento. Config, não
--                            sensível — SELECT direto (próxima migration).
--   conversations         — uma por (canal, wa_id), sempre. Vínculo com
--                            contato/lead/oportunidade é OPCIONAL (fica nulo
--                            enquanto ambíguo — nunca escolhido a esmo).
--   messages              — idempotente por (channel_id, wa_message_id)
--                            [entrada] e por (conversation_id,
--                            client_dedupe_key) [reenvio de saída].
--   message_status_events — log bruto dos eventos de status, distinto da
--                            projeção em messages.status (nunca regride).
--
-- Toda tabela nova: workspace_id not null, índice composto começando por
-- workspace_id, updated_at por trigger — mesma convenção de A2-A6.

create type public.message_direction as enum ('inbound', 'outbound');

-- Rank de progresso: queued(0) < sent(1) < delivered(2) < read(3).
-- 'failed' só é alcançável a partir de queued/sent — ver
-- private.message_status_rank() e apply_message_status_event().
create type public.message_status as enum ('queued', 'sent', 'delivered', 'read', 'failed');

-- ---------------------------------------------------------------------
-- whatsapp_channels
-- ---------------------------------------------------------------------

create table public.whatsapp_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 120),
  -- Cloud API real: phone_number_id é globalmente único (não por
  -- workspace) — é justamente essa unicidade global que permite resolver o
  -- workspace a partir do evento sem confiar em nenhum campo do payload.
  phone_number_id text not null check (char_length(btrim(phone_number_id)) between 1 and 64),
  display_phone_number text not null check (char_length(btrim(display_phone_number)) between 1 and 32),
  is_simulator boolean not null default true,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_channels_workspace_id_id_key unique (workspace_id, id)
);

comment on table public.whatsapp_channels is
  'Canal autorizado (nesta fase, sempre simulador) que resolve o workspace de um evento pelo phone_number_id — nunca por um workspace_id dentro do payload.';

create unique index whatsapp_channels_phone_number_id_key on public.whatsapp_channels (phone_number_id);
create index whatsapp_channels_workspace_id_idx on public.whatsapp_channels (workspace_id);

create trigger whatsapp_channels_set_updated_at
  before update on public.whatsapp_channels
  for each row execute function private.set_updated_at();

create trigger whatsapp_channels_set_created_by
  before insert on public.whatsapp_channels
  for each row execute function private.set_created_by_to_current_user();

-- ---------------------------------------------------------------------
-- conversations — sempre o par (channel_id, wa_id); vínculo de identidade
-- é resolvido à parte e pode ficar pendente (ver a7-conversas.md §5-§7).
-- ---------------------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  channel_id uuid not null,
  -- E.164, mesma regex de contact_phones.value_normalized.
  wa_id text not null check (wa_id ~ '^\+[1-9][0-9]{7,14}$'),
  contact_id uuid,
  lead_id uuid,
  opportunity_id uuid,
  needs_link_review boolean not null default false,
  link_candidate_contact_ids uuid[] not null default '{}'::uuid[],
  link_candidate_lead_ids uuid[] not null default '{}'::uuid[],
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_workspace_id_id_key unique (workspace_id, id),
  constraint conversations_channel_same_workspace_fkey
    foreign key (workspace_id, channel_id) references public.whatsapp_channels (workspace_id, id) on delete restrict,
  -- "on delete set null" restrito à própria coluna (sintaxe de lista de
  -- colunas, Postgres 15+) — sem isso, numa FK composta, zeraria TAMBÉM
  -- workspace_id (NOT NULL). Mesmo bug já corrigido na A6
  -- (20260911130000_a6_fix_source_rule_deletion.sql) — aplicado aqui desde
  -- o desenho inicial, não como correção posterior.
  constraint conversations_contact_same_workspace_fkey
    foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete set null (contact_id),
  constraint conversations_lead_same_workspace_fkey
    foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete set null (lead_id),
  constraint conversations_opportunity_same_workspace_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete set null (opportunity_id),
  constraint conversations_lead_requires_contact check (lead_id is null or contact_id is not null),
  constraint conversations_opportunity_requires_lead check (opportunity_id is null or lead_id is not null)
);

comment on table public.conversations is
  'Uma por (channel_id, wa_id), sempre — thread real do WhatsApp. contact_id/lead_id/opportunity_id ficam nulos enquanto o vínculo for ambíguo (needs_link_review); nunca escolhidos a esmo.';

create unique index conversations_workspace_channel_wa_id_key
  on public.conversations (workspace_id, channel_id, wa_id);
create index conversations_workspace_id_last_message_idx
  on public.conversations (workspace_id, last_message_at desc nulls last);
create index conversations_contact_id_idx on public.conversations (contact_id) where contact_id is not null;
create index conversations_lead_id_idx on public.conversations (lead_id) where lead_id is not null;

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  conversation_id uuid not null,
  channel_id uuid not null,
  direction public.message_direction not null,
  -- Sempre preenchido: para inbound, vem do evento simulado; para
  -- outbound, o próprio send_message() gera um id no formato do wamid real
  -- (não há transporte assíncrono real nesta fase — ver a7-conversas.md §8).
  wa_message_id text not null check (char_length(btrim(wa_message_id)) between 1 and 128),
  -- Só outbound: gerado no NAVEGADOR antes do primeiro envio de uma
  -- composição, para reenvio após falha nunca duplicar a mensagem aceita.
  client_dedupe_key uuid,
  body_text text not null check (char_length(btrim(body_text)) between 1 and 4096),
  status public.message_status not null,
  status_updated_at timestamptz not null default now(),
  error_reason text,
  sent_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint messages_workspace_id_id_key unique (workspace_id, id),
  constraint messages_conversation_same_workspace_fkey
    foreign key (workspace_id, conversation_id) references public.conversations (workspace_id, id) on delete cascade,
  constraint messages_channel_same_workspace_fkey
    foreign key (workspace_id, channel_id) references public.whatsapp_channels (workspace_id, id) on delete restrict,
  constraint messages_direction_dedupe_key_consistency check (
    (direction = 'inbound' and client_dedupe_key is null) or
    (direction = 'outbound' and client_dedupe_key is not null)
  ),
  constraint messages_direction_sent_by_consistency check (
    (direction = 'inbound' and sent_by is null) or
    (direction = 'outbound' and sent_by is not null)
  )
);

comment on table public.messages is
  'Idempotente por (channel_id, wa_message_id) [evento repetido] e por (conversation_id, client_dedupe_key) [reenvio de saída] — nunca a mesma mensagem duas vezes por nenhum dos dois caminhos.';

create unique index messages_channel_wa_message_id_key on public.messages (channel_id, wa_message_id);
create unique index messages_conversation_client_dedupe_key_key
  on public.messages (conversation_id, client_dedupe_key) where client_dedupe_key is not null;
create index messages_conversation_id_created_at_idx on public.messages (conversation_id, created_at desc);

create trigger messages_set_updated_at
  before update on public.messages
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- message_status_events — log bruto; messages.status é a PROJEÇÃO.
-- ---------------------------------------------------------------------

create table public.message_status_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  message_id uuid not null,
  status public.message_status not null check (status <> 'queued'),
  event_wa_timestamp timestamptz not null,
  error_code text,
  error_message text,
  -- false quando o evento chegou mas não mudou messages.status (tardio,
  -- duplicado, ou "failed" depois de já entregue) — nunca apagado, só
  -- marcado como não aplicado. Ver private.message_status_rank().
  applied boolean not null,
  received_at timestamptz not null default now(),
  constraint message_status_events_message_same_workspace_fkey
    foreign key (workspace_id, message_id) references public.messages (workspace_id, id) on delete cascade
);

comment on table public.message_status_events is
  'Log bruto de cada evento de status recebido, distinto da projeção em messages.status — nunca regride uma mensagem já lida/entregue.';

-- Colapsa o MESMO evento exato reenviado (mesma mensagem+status+timestamp
-- do evento) — não impede status genuinamente repetidos em timestamps
-- diferentes, que são um caso real (Meta pode reenviar com timestamp novo).
create unique index message_status_events_dedupe_key
  on public.message_status_events (message_id, status, event_wa_timestamp);
create index message_status_events_message_id_idx on public.message_status_events (message_id, received_at desc);

-- ---------------------------------------------------------------------
-- activities — rastreabilidade da atividade automática de primeiro
-- contato (mesmo padrão de source_stage_transition_id/source_rule_id da
-- A6: idempotência por índice único parcial + FK composta com ON DELETE
-- SET NULL restrito à própria coluna).
-- ---------------------------------------------------------------------

alter table public.activities
  add column source_conversation_message_id uuid;

alter table public.activities
  add constraint activities_source_conversation_message_same_workspace_fkey
  foreign key (workspace_id, source_conversation_message_id)
  references public.messages (workspace_id, id)
  on delete set null (source_conversation_message_id);

create unique index activities_source_conversation_message_id_key
  on public.activities (source_conversation_message_id)
  where source_conversation_message_id is not null;

-- Estende activities_source_consistency (já reescrita uma vez na A6 —
-- 20260911130000) para o terceiro valor de source. 'whatsapp_inbound'
-- exige source_conversation_message_id e não usa os campos de stage_rule.
alter table public.activities
  drop constraint activities_source_consistency;

alter table public.activities
  add constraint activities_source_consistency check (
    (source = 'manual' and source_stage_transition_id is null and source_rule_id is null and source_conversation_message_id is null) or
    (source = 'stage_rule' and source_stage_transition_id is not null and source_conversation_message_id is null) or
    (source = 'whatsapp_inbound' and source_conversation_message_id is not null and source_stage_transition_id is null and source_rule_id is null)
  );

comment on constraint activities_source_consistency on public.activities is
  'Cada source exige sua própria coluna de rastreabilidade (e só ela): stage_rule -> source_stage_transition_id; whatsapp_inbound -> source_conversation_message_id; manual -> nenhuma.';
