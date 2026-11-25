-- Conversas + IA — aplicador: ALVO ESTÁVEL até a gravação (correção de concorrência da 20261125120000).
--
-- Problema reproduzido com sessões reais (docs/decisoes/conversas-aplicador.md, "Alvo estável"): a conversa, o
-- caso e a resolução do vínculo eram lidos ANTES de private.status_track_lock e não eram reconferidos depois de
-- esperar a trava da trilha. Enquanto o aplicador esperava, outra sessão criava um segundo caso para o contato
-- (resolução ficava ambígua) ou revinculava a conversa a outro caso (resolve_conversation_link), e o aplicador
-- aplicava no caso antigo.
--
-- Correção: a função é a MESMA (mesma assinatura, mesmo corpo), com uma única mudança — o alvo é travado antes de
-- ser lido e antes da trava da trilha, sem espera (NOWAIT), e fica travado até a gravação. Nenhuma tabela, coluna
-- ou permissão muda; `create or replace` com a mesma assinatura preserva a ACL (só service_role). O portão continua
-- como estiver (fechado).

create or replace function public.apply_status_track_automation(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_change text,
  p_track public.status_track_kind,
  p_opportunity_id uuid,
  p_to_status text,
  p_step_id uuid,
  p_expected_version bigint,
  p_evidence_message_ids uuid[],
  p_idempotency_key uuid,
  p_extractor_ref text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_gate public.status_track_automation_gate;
  v_conv public.conversations;
  v_opp public.opportunities;
  v_lead public.leads;
  v_ids uuid[];
  v_fp text;
  v_existing public.status_track_automation_decisions;
  v_d public.status_track_automation_decisions;
  v_row public.status_tracks;
  v_from text;
  v_rule record;
  v_resolution jsonb;
  v_evidence jsonb := '[]'::jsonb;
  v_found integer;
  v_last_auto timestamptz;
  v_origin_max timestamptz;
  v_plan public.case_service_plans;
  v_step public.case_service_plan_steps;
  v_current public.case_service_plan_steps;
  v_event_id uuid;
  v_reason text;
  v_contact uuid;
begin
  -- Portão.
  select * into v_gate from public.status_track_automation_gate where singleton;
  if v_gate.enabled is distinct from true then
    raise exception 'automation_disabled';
  end if;

  -- Forma da proposta. Nada aqui é decidido pelo conteúdo: só o formato.
  v_ids := coalesce(p_evidence_message_ids, '{}'::uuid[]);
  if p_workspace_id is null or p_conversation_id is null or p_track is null or p_idempotency_key is null
     or p_expected_version is null or p_expected_version < 0
     or cardinality(v_ids) < 1 or cardinality(v_ids) > 20
     or array_position(v_ids, null) is not null
     or (select count(distinct x) from unnest(v_ids) x) <> cardinality(v_ids)
     or (p_extractor_ref is not null and p_extractor_ref !~ '^[A-Za-z0-9._:-]{1,120}$')
     or p_change is null
     or p_change not in ('set_status', 'set_current_step', 'complete_step', 'commercial_stage', 'commercial_outcome')
     or (p_track = 'attendance' and (p_change <> 'set_status' or p_opportunity_id is not null))
     or (p_track <> 'attendance' and p_opportunity_id is null)
     or (p_change = 'set_status' and (p_track = 'commercial_stage' or p_step_id is not null or p_to_status is null))
     or (p_change in ('set_current_step', 'complete_step') and (p_track <> 'case_progress' or p_step_id is null or p_to_status is not null))
     or (p_change in ('commercial_stage', 'commercial_outcome') and p_track <> 'commercial_stage')
     or (p_change = 'set_status' and p_track = 'attendance'
         and p_to_status not in ('novo', 'aguardando_escritorio', 'aguardando_cliente', 'encerrado'))
     or (p_change = 'set_status' and p_track = 'case_progress'
         and p_to_status not in ('aguardando_documentos', 'documentos_recebidos', 'em_analise', 'aguardando_cliente',
                                 'aguardando_terceiros', 'em_execucao', 'concluido', 'suspenso')) then
    raise exception 'invalid_proposal';
  end if;

  -- Alvo: a conversa e o caso precisam ser DESTE escritório (outro escritório = inexistente).
  --
  -- ALVO ESTÁVEL ATÉ A GRAVAÇÃO. Tudo o que decide o alvo (vínculo da conversa, contato, leads e oportunidades
  -- do contato, status do caso) é TRAVADO antes de ser lido e antes da trava da trilha, e fica travado até o fim
  -- da transação: enquanto o aplicador espera a trilha, ninguém troca o vínculo (resolve_conversation_link
  -- atualiza a conversa), cria outro caso para o contato (o INSERT confere a chave estrangeira do lead/contato)
  -- nem muda o status ou o lead do caso. Os escritores existentes só esperam o fim desta transação.
  -- As travas do alvo são pedidas SEM ESPERA (NOWAIT): se outro escritor estiver no meio de uma mudança, o
  -- aplicador desiste na hora com target_busy (erro sem gravação; a mesma proposta pode ser repetida com a
  -- mesma chave). Assim o aplicador nunca espera trava de alvo e não forma ciclo de espera com escritores que
  -- travam em outra ordem (troca de vínculo: conversa → lead; anonimização: contato → conversa).
  -- Dois aplicadores do mesmo contato se ENFILEIRAM numa trava consultiva só deles (sem isso o segundo
  -- receberia target_busy da trava do primeiro); nenhum outro escritor usa esta trava.
  if p_track = 'case_progress' then
    select c.contact_id into v_contact from public.conversations c
    where c.id = p_conversation_id and c.workspace_id = p_workspace_id;
    if v_contact is not null then
      perform pg_advisory_xact_lock(hashtextextended('praxis.aplicador.contato:' || v_contact::text, 0));
    end if;
  end if;
  begin
    select * into v_conv from public.conversations where id = p_conversation_id and workspace_id = p_workspace_id
    for share nowait;
  exception when lock_not_available then
    raise exception 'target_busy';
  end;
  if v_conv.id is null then
    raise exception 'target_not_found';
  end if;
  if p_track = 'case_progress' and v_conv.contact_id is distinct from v_contact then
    -- O vínculo da conversa mudou entre a leitura e a trava: nada é decidido sobre o contato antigo.
    raise exception 'target_busy';
  end if;
  if p_track = 'case_progress' and v_conv.contact_id is not null then
    begin
      perform 1 from public.contacts where id = v_conv.contact_id for update nowait;
      perform 1 from public.leads l where l.workspace_id = p_workspace_id and l.contact_id = v_conv.contact_id
      order by l.id for update nowait;
      perform 1 from public.opportunities o
      where o.workspace_id = p_workspace_id
        and (o.id = p_opportunity_id
             or o.lead_id in (select l.id from public.leads l where l.workspace_id = p_workspace_id and l.contact_id = v_conv.contact_id))
      order by o.id for share nowait;
    exception when lock_not_available then
      raise exception 'target_busy';
    end;
  end if;
  if v_conv.contact_id is not null and private.privacy_contact_anonymized(v_conv.contact_id) then
    raise exception 'contact_anonymized';
  end if;
  if p_opportunity_id is not null then
    select * into v_opp from public.opportunities where id = p_opportunity_id and workspace_id = p_workspace_id;
    if v_opp.id is null then
      raise exception 'target_not_found';
    end if;
    if private.privacy_opportunity_anonymized(v_opp.id) then
      raise exception 'contact_anonymized';
    end if;
    select * into v_lead from public.leads where id = v_opp.lead_id and workspace_id = p_workspace_id;
  end if;

  v_fp := md5(concat_ws('|', 'automation.v1', p_workspace_id, p_conversation_id, p_change, p_track,
                        coalesce(p_opportunity_id::text, '-'), coalesce(p_to_status, '-'), coalesce(p_step_id::text, '-'),
                        p_expected_version, coalesce(p_extractor_ref, '-'),
                        (select string_agg(x::text, ',' order by x) from unnest(v_ids) x)));

  -- Repetição (resposta perdida, reenvio): a mesma chave com o mesmo pedido devolve a mesma decisão.
  select * into v_existing from public.status_track_automation_decisions
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.request_fingerprint <> v_fp then
      raise exception 'idempotency_conflict';
    end if;
    return private.status_track_automation_result(v_existing, true);
  end if;
  perform private.status_track_key_assert_free(p_workspace_id, p_idempotency_key, 'status_track_automation_decisions');

  v_d.id := gen_random_uuid();
  v_d.workspace_id := p_workspace_id;
  v_d.idempotency_key := p_idempotency_key;
  v_d.conversation_id := v_conv.id;
  v_d.track := p_track;
  v_d.opportunity_id := p_opportunity_id;
  v_d.change := p_change;
  v_d.to_status := p_to_status;
  v_d.step_id := p_step_id;
  v_d.expected_version := p_expected_version;
  v_d.outcome := 'refused';
  v_d.evidence_count := 0;
  v_d.extractor_ref := p_extractor_ref;
  v_d.request_fingerprint := v_fp;
  v_d.decided_at := clock_timestamp();

  -- Sempre humanos nesta etapa.
  if p_track = 'commercial_stage' then
    v_d.reason := 'commercial_manual_only';
    return private.status_track_automation_record(v_d, null);
  end if;
  if p_change = 'complete_step' then
    v_d.reason := 'step_completion_manual_only';
    return private.status_track_automation_record(v_d, null);
  end if;

  -- Evidências: todas desta conversa (e, portanto, deste escritório).
  select count(*) into v_found from public.messages m
  where m.id = any(v_ids) and m.workspace_id = p_workspace_id and m.conversation_id = v_conv.id;
  if v_found <> cardinality(v_ids) then
    v_d.reason := 'evidence_invalid';
    return private.status_track_automation_record(v_d, null);
  end if;

  -- Caso inequívoco, ganho, da conversa vinculada ao contato do caso.
  if p_track = 'case_progress' then
    if v_conv.contact_id is null or v_conv.needs_link_review then
      v_d.reason := 'conversation_link_unresolved';
      return private.status_track_automation_record(v_d, null);
    end if;
    v_resolution := private.conversation_case_resolution(v_conv.id, 'owner', null);
    -- Só vínculo persistido da conversa ou caso ÚNICO do contato; o palpite "único do lead" com outros
    -- casos no contato não basta para uma mudança automática.
    if (v_resolution ->> 'default_opportunity_id') is null
       or not ((v_resolution ->> 'default_source') = 'linked' or (v_resolution ->> 'case_count')::int = 1) then
      v_d.reason := 'ambiguous_case';
      return private.status_track_automation_record(v_d, null);
    end if;
    if (v_resolution ->> 'default_opportunity_id')::uuid <> v_opp.id or v_lead.contact_id is distinct from v_conv.contact_id then
      v_d.reason := 'target_mismatch';
      return private.status_track_automation_record(v_d, null);
    end if;
    if v_opp.status <> 'won' then
      v_d.reason := 'opportunity_not_won';
      return private.status_track_automation_record(v_d, null);
    end if;
  end if;

  -- Trava a trilha (a MESMA trava da correção manual e do roteiro).
  v_row := private.status_track_lock(p_workspace_id, p_track, v_conv.id, p_opportunity_id);
  v_d.track_id := v_row.id;
  v_d.track_version := v_row.version;

  -- Depois da trava: a repetição simultânea da mesma chave enfileira aqui e devolve a decisão gravada.
  select * into v_existing from public.status_track_automation_decisions
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.request_fingerprint <> v_fp then
      raise exception 'idempotency_conflict';
    end if;
    return private.status_track_automation_result(v_existing, true);
  end if;

  -- Classificação e veredito temporal de cada evidência, contra a decisão humana DESTA trilha.
  select coalesce(jsonb_agg(jsonb_build_object(
           'message_id', m.id,
           'kind', private.status_track_automation_message_kind(m),
           'verdict', private.message_origin_time_evidence_verdict(m.id, v_row.manual_decided_at),
           'origin_at', m.origin_time_at) order by m.id), '[]'::jsonb)
  into v_evidence
  from public.messages m
  where m.id = any(v_ids) and m.workspace_id = p_workspace_id;
  v_d.evidence_count := jsonb_array_length(v_evidence);

  if v_row.automation_paused then
    v_d.reason := 'automation_paused';
  elsif v_row.version <> p_expected_version then
    v_d.reason := 'version_stale';
  elsif exists (select 1 from jsonb_array_elements(v_evidence) e where e ->> 'verdict' <> 'eligible') then
    v_d.reason := 'evidence_not_eligible';
  end if;
  if v_d.reason is not null then
    return private.status_track_automation_record(v_d, v_evidence);
  end if;

  -- Mensagem atrasada não desfaz aplicação automática feita com evidência mais nova.
  select max(d.evidence_origin_max) into v_last_auto
  from public.status_track_automation_decisions d
  where d.track_id = v_row.id and d.outcome = 'applied';
  select max((e ->> 'origin_at')::timestamptz) into v_origin_max from jsonb_array_elements(v_evidence) e;
  if v_last_auto is not null and exists (
       select 1 from jsonb_array_elements(v_evidence) e where (e ->> 'origin_at')::timestamptz <= v_last_auto) then
    v_d.reason := 'evidence_superseded';
    return private.status_track_automation_record(v_d, v_evidence);
  end if;

  if p_change = 'set_status' then
    v_from := coalesce(v_row.attendance_status::text, v_row.case_progress_status::text);
    if v_from = p_to_status then
      v_d.reason := 'status_unchanged';
      return private.status_track_automation_record(v_d, v_evidence);
    end if;
    select * into v_rule from private.status_track_automation_rule(p_track, v_from, p_to_status);
    if v_rule.o_reason is not null then
      v_d.reason := v_rule.o_reason;
      return private.status_track_automation_record(v_d, v_evidence);
    end if;
  else
    -- set_current_step: avança a etapa atual, sem concluir nada.
    select * into v_plan from public.case_service_plans where opportunity_id = v_opp.id and status = 'active';
    if v_plan.id is null then
      v_reason := 'service_plan_missing';
    else
      select * into v_step from public.case_service_plan_steps where id = p_step_id and plan_id = v_plan.id;
      select * into v_current from public.case_service_plan_steps where id = v_plan.current_step_id;
      if v_step.id is null or v_step.completed_at is not null then
        v_reason := 'step_not_pending';
      elsif v_plan.current_step_id = v_step.id then
        v_reason := 'status_unchanged';
      elsif v_current.id is not null and v_step.position <= v_current.position then
        v_reason := 'step_not_after_current';
      end if;
    end if;
    if v_reason is not null then
      v_d.reason := v_reason;
      return private.status_track_automation_record(v_d, v_evidence);
    end if;
    v_rule := null;
    select null::text as o_reason, array['client_message', 'client_file', 'office_message'] as o_kinds into v_rule;
  end if;

  -- Toda evidência precisa ser do tipo que a regra aceita; mensagem recebida que não é do cliente
  -- (equipe ou remetente indeterminado) é falta de autoridade, não só de tipo.
  if exists (
    select 1 from jsonb_array_elements(v_evidence) e
    join public.messages m on m.id = (e ->> 'message_id')::uuid
    where e ->> 'kind' = 'other' and m.direction = 'inbound') then
    v_d.reason := 'sender_not_authorized';
    return private.status_track_automation_record(v_d, v_evidence);
  end if;
  if exists (select 1 from jsonb_array_elements(v_evidence) e where not ((e ->> 'kind') = any(v_rule.o_kinds))) then
    v_d.reason := 'evidence_kind_insufficient';
    return private.status_track_automation_record(v_d, v_evidence);
  end if;

  -- Aplicar. A trilha NÃO ganha manual_decided_at: a aplicação automática não é decisão humana.
  perform set_config('praxis.automation_decision', v_d.id::text, true);
  if p_change = 'set_status' then
    if p_track = 'attendance' then
      update public.status_tracks
      set attendance_status = p_to_status::public.conversation_attendance_status, version = version + 1
      where id = v_row.id returning * into v_row;
    else
      update public.status_tracks
      set case_progress_status = p_to_status::public.case_progress_status, version = version + 1
      where id = v_row.id returning * into v_row;
    end if;
    insert into public.status_track_events (
      workspace_id, track_id, event, from_status, to_status, from_version, to_version,
      actor_kind, actor_user_id, evidence_count, idempotency_key, automation_decision_id
    ) values (
      v_row.workspace_id, v_row.id, 'status_changed', v_from, p_to_status, v_row.version - 1, v_row.version,
      'automation', null, cardinality(v_ids), null, v_d.id
    ) returning id into v_event_id;
    insert into public.status_track_event_evidence (workspace_id, event_id, message_id)
    select v_row.workspace_id, v_event_id, x from unnest(v_ids) x;
    v_d.event_source := 'status_track_events';
    -- Situação do atendimento e andamento nunca convivem com concluído inconsistente (I1).
    if p_track = 'case_progress' then
      perform private.case_service_assert(v_row.opportunity_id);
    end if;
  else
    update public.case_service_plans set current_step_id = v_step.id where id = v_plan.id;
    update public.status_tracks set version = version + 1 where id = v_row.id returning * into v_row;
    insert into public.case_service_events (
      workspace_id, opportunity_id, plan_id, op, step_id, previous_plan_id,
      current_step_before, current_step_after, progress_from, progress_to,
      from_version, to_version, actor_kind, actor_user_id, idempotency_key, request_fingerprint, automation_decision_id
    ) values (
      v_row.workspace_id, v_row.opportunity_id, v_plan.id, 'current_step_set', null, null,
      v_plan.current_step_id, v_step.id, null, null,
      v_row.version - 1, v_row.version, 'automation', null, null, v_fp, v_d.id
    ) returning id into v_event_id;
    v_d.event_source := 'case_service_events';
    perform private.case_service_assert(v_row.opportunity_id);
  end if;
  perform set_config('praxis.automation_decision', '', true);

  v_d.outcome := 'applied';
  v_d.reason := null;
  v_d.event_id := v_event_id;
  v_d.evidence_origin_max := v_origin_max;
  return private.status_track_automation_record(v_d, v_evidence);
end;
$body$;

comment on function public.apply_status_track_automation(uuid, uuid, text, public.status_track_kind, uuid, text, uuid, bigint, uuid[], uuid, text) is
  'Conversas + IA (aplicador): aplica ou recusa UMA proposta estruturada de mudança de status, revalidando tudo no banco (escritório, alvo, caso inequívoco, evidências, horário de origem, versão, pausa, decisão humana, catálogo). O alvo fica travado (sem espera; target_busy) desde antes da leitura até a gravação. Só o processamento interno (service_role) e só com o portão aberto. Idempotente pela chave; recusa registrada com motivo em código.';
