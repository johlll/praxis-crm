-- A7 — correções pedidas na revisão pré-merge do PR #8. Migration nova
-- (nenhuma das já aplicadas é reescrita).
--
-- Toda função que ganhou parâmetro novo aqui recebe um `drop function if
-- exists <assinatura antiga>` logo antes do `create` — `create or replace`
-- NÃO reaproveita a mesma function quando a lista de tipos de argumento
-- muda (mesmo só acrescentando um no fim, mesmo com default): a identidade
-- de uma function no catálogo do Postgres é nome+tipos dos argumentos, e
-- "OR REPLACE" sem uma correspondência exata cai para um CREATE comum,
-- deixando a versão antiga registrada como uma SOBRECARGA (overload)
-- separada em vez de ser substituída. Achado real neste CI (não
-- presumido) — ver nota detalhada antes de `private.contact_has_active_consent`
-- abaixo. Onde o parâmetro NÃO muda (send_message, corpo reescrito mas
-- mesma assinatura de sempre), `create or replace` continua preservando a
-- mesma identidade e os grants já concedidos, sem precisar de DROP.
--
-- Três achados corrigidos aqui:
-- 1) Consentimento só verificava canal+vigência, nunca finalidade —
--    decisão de ignorar `purpose` não tinha sido aprovada.
-- 2) list_conversation_messages() usava só created_at como cursor —
--    mensagens com o mesmo timestamp podiam ser puladas ou repetidas entre
--    páginas.
-- 3) send_message() aceitava reenvio com a mesma client_dedupe_key sem
--    checar se o conteúdo batia com o que já fora persistido — uma chave
--    reaproveitada com texto diferente devolvia "sucesso" silenciosamente
--    sobre o registro antigo.

-- ---------------------------------------------------------------------
-- 1) Finalidade técnica de consentimento (a7-conversas.md §10, revisado).
-- ---------------------------------------------------------------------

-- Vocabulário fechado, começando com as duas finalidades que já fazem
-- sentido hoje: "atendimento" (o único fluxo de envio ativo que existe
-- nesta fase — é o que o gate de send_message() passa a exigir) e
-- "marketing" (sem tela nem fluxo de envio ainda — existe só para que
-- "finalidade incompatível" seja um cenário real e testável: um contato
-- pode ter consentido para atendimento e não para campanha, ou vice-versa
-- — é exatamente essa distinção que a revisão pediu para ficar aplicada,
-- não só documentada). Novas finalidades entram por ALTER TYPE em
-- migration própria quando um novo fluxo de envio existir de verdade.
create type public.consent_purpose as enum ('whatsapp_atendimento', 'whatsapp_marketing');

comment on type public.consent_purpose is
  'Vocabulário fechado de finalidades técnicas verificadas no gate de envio ativo (private.contact_has_active_consent). Distinto de contact_consents.purpose, que continua texto livre — evidência/auditoria de qual finalidade foi de fato autorizada, exibida na tela, nunca usada para decidir acesso.';

-- Nullable e SEM backfill: consentimentos já existentes antes desta
-- migration ficam com purpose_code NULL — nunca inferidos automaticamente
-- a partir do texto livre de `purpose`. Um NULL nunca bate com a
-- comparação de igualdade do gate (ver função abaixo), então esses
-- registros passam a ser tratados como "finalidade não classificada" —
-- bloqueiam envio até alguém registrar um consentimento novo já com a
-- finalidade técnica certa. É o comportamento pedido: nada de conversão
-- automática, mesmo que isso signifique um consentimento antigo "vigente"
-- pelos critérios de antes deixar de autorizar envio.
alter table public.contact_consents add column purpose_code public.consent_purpose;

comment on column public.contact_consents.purpose_code is
  'Finalidade técnica fechada usada pelo gate de envio. NULL = consentimento anterior a esta migration ou registrado para um canal sem gate — nunca satisfaz a checagem de finalidade (nunca inferido do texto livre de `purpose`).';

create index contact_consents_active_lookup_idx
  on public.contact_consents (contact_id, channel, purpose_code)
  where granted_at is not null and revoked_at is null;

-- ---------------------------------------------------------------------
-- private.contact_has_active_consent — agora verifica finalidade também,
-- não só canal+vigência. Default aponta para a única finalidade com gate
-- de envio nesta fase, então o único chamador existente (send_message,
-- abaixo) nem precisa mudar a chamada — mas passa explícito mesmo assim,
-- por clareza.
--
-- IMPORTANTE (achado real neste CI): `create or replace function` NÃO
-- substitui em vigor quando o parâmetro novo muda a LISTA de tipos de
-- argumento (mesmo só acrescentando um no fim, mesmo com default) — a
-- identidade de uma function no catálogo do Postgres é nome+tipos dos
-- argumentos, então "OR REPLACE" simplesmente não encontra a assinatura
-- antiga para substituir e cai para um CREATE comum: as DUAS versões
-- (antiga e nova) ficam registradas como sobrecargas (overloads)
-- coexistindo. `supabase gen types` expõe isso ao gerar um tipo UNIÃO de
-- duas formas de Args em vez de um único objeto com o campo novo opcional
-- — foi assim que este achado apareceu (db:types:check). Corrigido: DROP
-- explícito da assinatura antiga logo antes de recriar, em cada função
-- abaixo que ganhou parâmetro novo.
-- ---------------------------------------------------------------------

drop function if exists private.contact_has_active_consent(uuid, public.contact_channel);

create or replace function private.contact_has_active_consent(
  p_contact_id uuid,
  p_channel public.contact_channel,
  p_purpose_code public.consent_purpose default 'whatsapp_atendimento'
)
returns boolean
language sql
stable
set search_path = ''
as $body$
  select exists (
    select 1 from public.contact_consents
    where contact_id = p_contact_id
      and channel = p_channel
      and purpose_code = p_purpose_code
      and granted_at is not null
      and revoked_at is null
  );
$body$;

comment on function private.contact_has_active_consent(uuid, public.contact_channel, public.consent_purpose) is
  'Consentimento vigente = canal certo + finalidade técnica certa + concedido + não revogado. purpose_code NULL (consentimento anterior a esta migration) nunca bate com nenhuma finalidade — nunca autoriza envio.';

-- Fresh CREATE (não um REPLACE de verdade, ver nota acima) começa sem os
-- grants explícitos de sempre — Postgres concede EXECUTE a PUBLIC por
-- padrão numa function nova, então sem este revoke ficaria executável por
-- QUALQUER role (inclusive anon), mesmo sem rota HTTP exposta (schema
-- `private` não está em `schemas` no config.toml). Mesma disciplina do
-- resto do arquivo.
revoke all on function private.contact_has_active_consent(uuid, public.contact_channel, public.consent_purpose) from public;
grant execute on function private.contact_has_active_consent(uuid, public.contact_channel, public.consent_purpose) to authenticated;

-- ---------------------------------------------------------------------
-- register_contact_consent — novo parâmetro p_purpose_code ao FINAL.
-- Exigido (não pode ficar null) quando o canal é 'whatsapp', porque é o
-- único canal com gate de envio nesta fase — outros canais (email/
-- telefone/presencial) não têm fluxo de envio ainda, então nada consulta
-- a finalidade deles por enquanto. DROP da assinatura antiga (6 args)
-- antes de recriar (ver nota acima sobre CREATE OR REPLACE + novo
-- parâmetro) — precisa de GRANT novo depois, porque é um objeto de
-- catálogo genuinamente novo.
-- ---------------------------------------------------------------------

drop function if exists public.register_contact_consent(
  uuid, public.contact_channel, public.consent_legal_basis, text, text, text
);

create or replace function public.register_contact_consent(
  p_contact_id uuid,
  p_channel public.contact_channel,
  p_legal_basis public.consent_legal_basis,
  p_purpose text,
  p_evidence_source text default null,
  p_accepted_text text default null,
  p_purpose_code public.consent_purpose default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_contact public.contacts;
  v_consent_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_contact from public.contacts where id = p_contact_id;
  if v_contact.id is null then
    raise exception 'contact_not_found';
  end if;

  if not private.has_workspace_role(
    v_contact.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if btrim(coalesce(p_purpose, '')) = '' then
    raise exception 'purpose_required';
  end if;

  if p_channel = 'whatsapp' and p_purpose_code is null then
    raise exception 'purpose_code_required';
  end if;

  insert into public.contact_consents (
    workspace_id, contact_id, channel, legal_basis, purpose, purpose_code, granted_at, evidence_source, accepted_text, created_by
  )
  values (
    v_contact.workspace_id, p_contact_id, p_channel, p_legal_basis, btrim(p_purpose), p_purpose_code, now(),
    nullif(btrim(coalesce(p_evidence_source, '')), ''), nullif(btrim(coalesce(p_accepted_text, '')), ''), v_actor
  )
  returning id into v_consent_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_contact.workspace_id, v_actor, 'consent.registered', 'contact', p_contact_id,
    jsonb_build_object('consent_id', v_consent_id, 'channel', p_channel, 'purpose_code', p_purpose_code)
  );

  return v_consent_id;
end;
$body$;

revoke all on function public.register_contact_consent(
  uuid, public.contact_channel, public.consent_legal_basis, text, text, text, public.consent_purpose
) from public;
grant execute on function public.register_contact_consent(
  uuid, public.contact_channel, public.consent_legal_basis, text, text, text, public.consent_purpose
) to authenticated;

-- ---------------------------------------------------------------------
-- 2) list_conversation_messages — cursor composto (created_at, id) com
--    desempate único. p_before_id acrescentado ao FINAL da lista, DROP da
--    assinatura antiga (3 args) antes de recriar (ver nota no topo do
--    arquivo); p_before sozinho (sem p_before_id) só é válido quando null
--    (primeira página) — combinação inválida vira erro explícito, nunca
--    um cursor "quebrado" silencioso.
-- ---------------------------------------------------------------------

drop function if exists public.list_conversation_messages(uuid, timestamptz, integer);

create or replace function public.list_conversation_messages(
  p_conversation_id uuid,
  p_before timestamptz default null,
  p_limit integer default 30,
  p_before_id uuid default null
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
  v_conv public.conversations;
  v_lead_assigned_to uuid;
  v_limit integer;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_conv from public.conversations where id = p_conversation_id;
  if v_conv.id is null then
    raise exception 'conversation_not_found';
  end if;

  if not private.has_workspace_role(
    v_conv.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_conv.workspace_id and user_id = v_actor and status = 'active';

  select assigned_to into v_lead_assigned_to from public.leads where id = v_conv.lead_id;

  if not private.conversation_accessible_to_role(v_role, v_conv.lead_id, v_lead_assigned_to, v_actor) then
    raise exception 'conversation_not_found';
  end if;

  if p_before is not null and p_before_id is null then
    raise exception 'invalid_cursor';
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 30), 100));

  return query
  with page as (
    select m.*
    from public.messages m
    where m.conversation_id = p_conversation_id
      and (
        p_before is null
        -- Comparação de linha (created_at, id): desempata mensagens com o
        -- MESMO created_at pelo id, sem o que uma página podia pular ou
        -- repetir mensagens empatadas no timestamp entre duas buscas.
        or (m.created_at, m.id) < (p_before, p_before_id)
      )
    order by m.created_at desc, m.id desc
    limit v_limit
  ),
  cursor_point as (
    select created_at, id from page order by created_at asc, id asc limit 1
  ),
  older_count as (
    select count(*) as n
    from public.messages m, cursor_point cp
    where m.conversation_id = p_conversation_id
      and (m.created_at, m.id) < (cp.created_at, cp.id)
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id, 'direction', p.direction, 'body_text', p.body_text, 'status', p.status,
            'status_updated_at', p.status_updated_at, 'error_reason', p.error_reason,
            'sent_by', p.sent_by, 'created_at', p.created_at, 'wa_message_id', p.wa_message_id
          )
          order by p.created_at asc, p.id asc
        )
        from page p
      ),
      '[]'::jsonb
    ),
    coalesce((select n from older_count), 0) > 0;
end;
$body$;

revoke all on function public.list_conversation_messages(uuid, timestamptz, integer, uuid) from public;
grant execute on function public.list_conversation_messages(uuid, timestamptz, integer, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3) send_message — client_dedupe_key vira uma chave IMUTÁVEL: a mesma
--    chave com o MESMO texto continua idempotente (devolve o que já foi
--    gravado); a mesma chave com texto DIFERENTE nunca mais é tratada como
--    sucesso — devolve content_conflict=true junto do registro
--    REALMENTE persistido (texto, status, tudo), para a interface
--    reconciliar em vez de fingir que o texto novo foi enviado. Mesma
--    assinatura de antes (3 parâmetros, nenhum novo) — só o corpo muda,
--    então CREATE OR REPLACE não precisa alterar grants.
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
