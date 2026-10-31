-- B3.2d-2b2b3b — efeito atômico dos eventos OPERACIONAIS da conta e do
-- número (docs/decisoes/b3-whatsapp-real.md §26).
--
-- Aplica um NormalizedAccountEvent (evento da conta WhatsApp Business ou do
-- número do escritório) ao canal da entrada da inbox. Não envia nada, não
-- chama o provedor, não toca o chatbot e não liga o consumidor.
--
-- Esta migration faz três coisas, nenhuma altera dado existente:
--   1. whatsapp_channels ganha `provider_account_ref` (referência técnica
--      NEUTRA e IMUTÁVEL da conta do provedor) e as datas operacionais
--      `last_event_at` e `provider_status_event_at`, que só avançam. A guarda
--      da identidade do canal passa a travar a referência e as duas datas;
--   2. whatsapp_channel_events: o que sobra de cada evento depois do
--      expurgo do corpo cifrado da inbox. Deny-all, só por função
--      SECURITY DEFINER. Nenhum telefone, routing key, referência da conta,
--      payload, texto, BSUID, segredo ou cifra;
--   3. public.whatsapp_effect_account_event.
--
-- A RPC aplica, numa transação só e sob a trava da entrada da inbox:
--   1. inbox no ambiente autenticado, em processing, com o token do claim e
--      a lease vigente. O tipo do evento (que decide se o canal é
--      desconectado) só vale se for o gravado na entrada;
--   2. canal da própria linha FOR UPDATE (qualquer estado: pausado,
--      desconectado ou desativado não bloqueiam este efeito) e workspace
--      protegido (a gravação referencia a chave dele);
--   3. a lease é conferida DE NOVO com o relógio de agora, logo depois da
--      última trava e antes da primeira escrita (as travas de linha podem
--      esperar quem não passa por nenhuma outra trava, e a lease vencer);
--   4. reserva do efeito `account` no ledger (o mesmo nome do `kind` do
--      contrato neutro, já previsto no vocabulário do ledger);
--   5. destino: o escopo do número exige a routing key IGUAL à do canal; os
--      dois escopos exigem a referência da conta IGUAL à do canal. Canal sem
--      referência: account_reference_unverified. A conta NUNCA é deduzida da
--      routing key, que o domínio não divide nem interpreta;
--   6. o evento é gravado e last_event_at avança;
--   7. SÓ whatsapp.phone_number.deleted e whatsapp.business_account.deleted
--      desconectam: active/paused → disconnected, send_enabled=false,
--      provider_status_event_at, status_changed_at (relógio do CRM) e uma
--      auditoria sanitizada (ator nulo, origem whatsapp_webhook). Evento
--      igual ou anterior a provider_status_event_at é stale_event: registrado,
--      sem mudar o canal nem auditar. disconnected e disabled só registram
--      (disabled nunca é reativado nem rebaixado). Os demais tipos só são
--      registrados, e o `code` é opaco: nada o interpreta;
--   8. inbox processed na mesma transação.
-- Qualquer falha desfaz tudo. Workspace, canal, ambiente, provedor e id do
-- evento vêm da linha da inbox, nunca do chamador.
--
-- Fica de fora: a ligação do consumidor (B3.2d-2b3), a reativação
-- automática, alertas, retenção, envio, mídia e interface. Esta migration
-- não edita as anteriores: substitui a guarda do canal e acrescenta colunas,
-- uma tabela e uma função.

-- ---------------------------------------------------------------------
-- Canal: referência técnica da conta e datas operacionais
-- ---------------------------------------------------------------------

alter table public.whatsapp_channels
  add column provider_account_ref text,
  add column last_event_at timestamptz,
  add column provider_status_event_at timestamptz;

alter table public.whatsapp_channels
  -- Formato neutro: letras, dígitos, ponto, sublinhado e hífen; até 64
  -- caracteres; sem espaço nem caractere de controle. Nunca derivado da
  -- routing key.
  add constraint whatsapp_channels_provider_account_ref_format
    check (provider_account_ref is null or provider_account_ref ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  -- Só canal da B3 (com ambiente) tem referência: a linha legada da A7 é
  -- legível por SELECT direto e nunca carrega a conta do provedor.
  add constraint whatsapp_channels_provider_account_ref_b3_only
    check (provider_account_ref is null or environment is not null);

comment on column public.whatsapp_channels.provider_account_ref is
  'Referência técnica neutra e imutável da conta do provedor (B3.2d-2b2b3b). Gravada na criação do canal real; nula nos canais legados e simulados. Nunca derivada da routing key e nunca exposta em resposta, erro, log ou auditoria.';
comment on column public.whatsapp_channels.last_event_at is
  'Maior occurredAt de qualquer evento operacional da conta ou do número aceito para o canal (B3.2d-2b2b3b). Só avança.';
comment on column public.whatsapp_channels.provider_status_event_at is
  'Horário, no relógio do PROVEDOR, do último evento que efetivamente decidiu o estado do canal (B3.2d-2b2b3b). Só avança. Não é status_changed_at, que é o relógio do CRM.';

-- A identidade do canal (workspace, ambiente, provedor, roteamento,
-- localizador e agora a referência da conta) é imutável depois de criada. As
-- datas operacionais nunca regridem nem voltam a nulo.
create or replace function private.whatsapp_channels_guard()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if tg_op = 'INSERT' then
    if new.routing_key is null then
      new.routing_key := new.phone_number_id;
    end if;
    return new;
  end if;

  if new.workspace_id is distinct from old.workspace_id
     or new.environment is distinct from old.environment
     or new.provider is distinct from old.provider
     or new.routing_key is distinct from old.routing_key
     or new.is_simulator is distinct from old.is_simulator
     or new.webhook_route_id is distinct from old.webhook_route_id
     or new.provider_account_ref is distinct from old.provider_account_ref then
    raise exception 'channel_identity_immutable';
  end if;

  if (old.last_event_at is not null and (new.last_event_at is null or new.last_event_at < old.last_event_at))
     or (old.provider_status_event_at is not null
         and (new.provider_status_event_at is null or new.provider_status_event_at < old.provider_status_event_at)) then
    raise exception 'channel_clock_regression';
  end if;
  return new;
end;
$body$;

revoke all on function private.whatsapp_channels_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- whatsapp_channel_events — o registro operacional de cada evento
-- ---------------------------------------------------------------------

create table public.whatsapp_channel_events (
  id uuid primary key default gen_random_uuid(),
  inbox_id uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  channel_id uuid not null,
  environment public.whatsapp_environment not null,
  provider public.whatsapp_provider not null,
  provider_event_id text not null check (provider_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  -- Tipo BRUTO do provedor, o mesmo gravado na inbox (lista aberta: só o
  -- formato é conferido).
  provider_type text not null
    check (char_length(provider_type) <= 128 and provider_type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
  scope text not null check (scope in ('business_account', 'phone_number')),
  -- Código do provedor, opaco: 1 a 64 caracteres, sem controle. Nunca
  -- interpretado.
  code text check (code is null or (char_length(code) between 1 and 64 and code !~ '[\u0001-\u001f\u007f-\u009f]')),
  occurred_at timestamptz not null check (isfinite(occurred_at)),
  -- applied: o canal passou para disconnected; recorded: registrado sem
  -- mudar o canal; stale_event: registrado, mas antigo demais para decidir
  -- o estado.
  result text not null check (result in ('applied', 'recorded', 'stale_event')),
  created_at timestamptz not null default now(),
  constraint whatsapp_channel_events_inbox_key unique (inbox_id),
  -- Nenhum evento cruza workspace, ambiente ou provedor do canal.
  constraint whatsapp_channel_events_channel_identity_fkey
    foreign key (workspace_id, channel_id, environment, provider)
    references public.whatsapp_channels (workspace_id, id, environment, provider) on delete restrict,
  -- A inbox é a do MESMO evento: workspace, canal, ambiente, provedor e
  -- provider_event_id iguais aos dela. Sem ação na remoção (como o ledger):
  -- o expurgo preserva a inbox como tombstone, e nada pode apagar a origem
  -- de um evento operacional.
  constraint whatsapp_channel_events_inbox_fkey
    foreign key (inbox_id, workspace_id, channel_id, environment, provider, provider_event_id)
    references public.whatsapp_webhook_inbox (id, workspace_id, channel_id, environment, provider, provider_event_id)
);

comment on table public.whatsapp_channel_events is
  'Evento operacional da conta ou do número (B3.2d-2b2b3b): tipo, escopo, código opaco, horário do provedor e resultado, preso à inbox e ao canal do mesmo evento. Sem telefone, routing key, referência da conta, payload, texto, BSUID, segredo ou cifra. Deny-all; só a RPC do efeito.';

create index whatsapp_channel_events_workspace_idx on public.whatsapp_channel_events (workspace_id);
create index whatsapp_channel_events_channel_idx on public.whatsapp_channel_events (channel_id, occurred_at desc);

alter table public.whatsapp_channel_events enable row level security;
alter table public.whatsapp_channel_events force row level security;
revoke all on table public.whatsapp_channel_events from public, anon, authenticated, service_role;

create policy whatsapp_channel_events_select_deny on public.whatsapp_channel_events for select to authenticated using (false);
create policy whatsapp_channel_events_insert_deny on public.whatsapp_channel_events for insert to authenticated with check (false);
create policy whatsapp_channel_events_update_deny on public.whatsapp_channel_events for update to authenticated using (false);
create policy whatsapp_channel_events_delete_deny on public.whatsapp_channel_events for delete to authenticated using (false);

-- ---------------------------------------------------------------------
-- O efeito
-- ---------------------------------------------------------------------

-- Resultados (contrato fechado):
--   applied                      — exclusão válida: o canal passou para
--                                  disconnected, sem envio; evento gravado;
--   recorded                     — evento gravado sem mudar o status (os
--                                  tipos só observados; exclusão em canal já
--                                  desconectado ou desativado);
--   stale_event                  — exclusão igual ou anterior a
--                                  provider_status_event_at: gravada, sem
--                                  mudar o canal nem auditar;
--   duplicate                    — o mesmo efeito já estava no ledger para
--                                  esta entrada: inbox processed;
--   routing_mismatch             — escopo do número com routing key diferente
--                                  da do canal;
--   account_reference_mismatch   — a referência da conta difere da do canal;
--   account_reference_unverified — o canal não tem referência confiável (nos
--                                  dois escopos);
--   effect_conflict              — a chave estável já tem outro efeito ou
--                                  entrada;
--   already_processed, terminal_failed, claim_lost, not_found — como na
--                                  finalização da B3.2d-1, sem mudar nada
--                                  (claim_lost também quando a lease vence
--                                  durante a espera por uma trava de linha).
-- Nas três divergências e em effect_conflict nada fica gravado (nenhum
-- ledger, evento ou mudança) e o claim continua: quem chama decide fail ou
-- release (B3.2d-2b3). Entrada malformada: invalid_account_event.
create function public.whatsapp_effect_account_event(
  p_inbox_id uuid,
  p_claim_token uuid,
  p_scope text,
  p_provider_type text,
  p_provider_account_ref text,
  p_routing_key text,
  p_occurred_at timestamptz,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_row public.whatsapp_webhook_inbox;
  v_channel public.whatsapp_channels;
  v_now timestamptz;
  v_reserve record;
  v_deletes boolean;
  v_result text;
begin
  -- Entrada: falha fechada antes de qualquer trava ou escrita. Nenhuma
  -- mensagem de erro leva valor.
  if p_scope is null or p_scope not in ('business_account', 'phone_number')
     or p_provider_type is null or char_length(p_provider_type) > 128 or p_provider_type !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'
     or (p_scope = 'phone_number' and not starts_with(p_provider_type, 'whatsapp.phone_number.'))
     or (p_scope = 'business_account' and not starts_with(p_provider_type, 'whatsapp.business_account.'))
     or p_provider_account_ref is null or p_provider_account_ref !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
     or p_occurred_at is null or not isfinite(p_occurred_at)
     or (p_code is not null and (char_length(p_code) not between 1 and 64 or p_code ~ '[\u0001-\u001f\u007f-\u009f]'))
     or (p_scope = 'phone_number'
         and (p_routing_key is null or char_length(p_routing_key) not between 1 and 128 or p_routing_key ~ '[\u0001-\u001f\u007f-\u009f]'))
     or (p_scope = 'business_account' and p_routing_key is not null) then
    raise exception 'invalid_account_event';
  end if;

  if p_inbox_id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- Trava da entrada: uma execução de cada vez; a outra relê o estado final.
  select i.* into v_row
  from public.whatsapp_webhook_inbox i
  where i.id = p_inbox_id
  for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_row.state = 'processed' then
    return jsonb_build_object('outcome', 'already_processed');
  end if;
  if v_row.state = 'failed' then
    return jsonb_build_object('outcome', 'terminal_failed');
  end if;
  if v_row.state <> 'processing' or p_claim_token is null or v_row.claim_token is distinct from p_claim_token then
    return jsonb_build_object('outcome', 'claim_lost');
  end if;
  if v_row.lease_until is null or v_row.lease_until <= clock_timestamp() then
    return jsonb_build_object('outcome', 'claim_lost');
  end if;

  -- O tipo vem do chamador, mas só vale o gravado na entrada: é ele que
  -- decide se o canal é desconectado.
  if p_provider_type is distinct from v_row.provider_event_type then
    raise exception 'invalid_account_event';
  end if;

  -- O canal da própria linha, em QUALQUER estado atual, travado para
  -- escrita: duas exclusões, ou uma pausa e uma exclusão, esperam uma pela
  -- outra e a segunda relê o estado final.
  select c.* into v_channel
  from public.whatsapp_channels c
  where c.id = v_row.channel_id and c.workspace_id = v_row.workspace_id
    and c.environment = v_row.environment and c.provider = v_row.provider
  for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  -- Os registros gravados abaixo referenciam o workspace: a trava da chave
  -- vem aqui, para que nenhuma escrita espere depois da conferência seguinte.
  perform 1 from public.workspaces w where w.id = v_row.workspace_id for key share;

  -- As travas de linha podem esperar transações que não passam por nenhuma
  -- outra trava, e a lease pode vencer nessa espera. Conferida de novo, com o
  -- relógio de agora, antes da primeira escrita; o processed_at e o
  -- status_changed_at usam este horário.
  v_now := clock_timestamp();
  if v_row.lease_until is null or v_row.lease_until <= v_now then
    return jsonb_build_object('outcome', 'claim_lost');
  end if;

  begin
    select r.outcome, r.ledger_id into v_reserve
    from private.whatsapp_effect_ledger_reserve(v_row.id, 'account') r;
    if v_reserve.outcome = 'conflict' then
      raise exception 'effect_conflict';
    end if;
    if v_reserve.outcome = 'duplicate' then
      update public.whatsapp_webhook_inbox
      set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
      where id = v_row.id;
      return jsonb_build_object('outcome', 'duplicate');
    end if;

    -- Destino. O roteamento só vale com a routing key exatamente igual à do
    -- canal; a conta, com a referência igual à do canal. Canal sem referência
    -- confiável nunca é comparado.
    if p_scope = 'phone_number' and p_routing_key is distinct from v_channel.routing_key then
      raise exception 'routing_mismatch';
    end if;
    if v_channel.provider_account_ref is null then
      raise exception 'account_reference_unverified';
    end if;
    if p_provider_account_ref is distinct from v_channel.provider_account_ref then
      raise exception 'account_reference_mismatch';
    end if;

    -- Só estes dois tipos decidem o estado do canal.
    v_deletes := p_provider_type in ('whatsapp.phone_number.deleted', 'whatsapp.business_account.deleted');
    if v_deletes and v_channel.provider_status_event_at is not null and p_occurred_at <= v_channel.provider_status_event_at then
      v_result := 'stale_event';
    elsif v_deletes and v_channel.status in ('active', 'paused') then
      v_result := 'applied';
    else
      v_result := 'recorded';
    end if;

    insert into public.whatsapp_channel_events (
      inbox_id, workspace_id, channel_id, environment, provider, provider_event_id, provider_type, scope, code, occurred_at, result
    ) values (
      v_row.id, v_row.workspace_id, v_row.channel_id, v_row.environment, v_row.provider, v_row.provider_event_id,
      p_provider_type, p_scope, p_code, p_occurred_at, v_result
    );

    if v_result = 'applied' then
      update public.whatsapp_channels
      set status = 'disconnected',
          send_enabled = false,
          status_changed_at = v_now,
          provider_status_event_at = p_occurred_at,
          last_event_at = greatest(last_event_at, p_occurred_at)
      where id = v_channel.id;

      insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (
        v_row.workspace_id, null, 'whatsapp.channel.disconnected', 'whatsapp_channel', v_channel.id,
        jsonb_build_object('source', 'whatsapp_webhook', 'environment', v_row.environment, 'provider', v_row.provider,
                           'scope', p_scope, 'provider_type', p_provider_type, 'from_status', v_channel.status,
                           'to_status', 'disconnected', 'send_enabled_before', v_channel.send_enabled)
      );
    elsif v_channel.last_event_at is null or p_occurred_at > v_channel.last_event_at then
      update public.whatsapp_channels set last_event_at = p_occurred_at where id = v_channel.id;
    end if;

    update public.whatsapp_webhook_inbox
    set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
    where id = v_row.id;
    return jsonb_build_object('outcome', v_result);
  exception
    when raise_exception then
      -- Divergência de destino e conflito de efeito desfazem o bloco (ledger
      -- incluído) e voltam como resultado; o resto propaga e desfaz tudo.
      if sqlerrm in ('routing_mismatch', 'account_reference_mismatch', 'account_reference_unverified', 'effect_conflict') then
        return jsonb_build_object('outcome', sqlerrm);
      end if;
      raise;
  end;
end;
$body$;

revoke all on function public.whatsapp_effect_account_event(uuid, uuid, text, text, text, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.whatsapp_effect_account_event(uuid, uuid, text, text, text, text, timestamptz, text)
  to service_role;
