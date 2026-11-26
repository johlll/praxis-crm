-- Conversas + IA — EXTRATOR: contexto autorizado para produzir propostas ao aplicador.
--
-- Decisões em docs/decisoes/conversas-extrator.md. Uma única função de LEITURA, só do processamento interno
-- (service_role) e só com o portão do aplicador aberto (status_track_automation_gate): fechado, ela recusa com
-- automation_disabled, como o aplicador. Nada aqui grava, envia mensagem ou muda status.
--
-- O que entrega (da conversa pedida, DESTE escritório):
--   * situação do atendimento: estado, versão e pausa;
--   * o caso SÓ quando inequívoco (vínculo persistido ou caso único do contato, a mesma regra do aplicador) e
--     ganho, com estado, versão, pausa e roteiro (etapas, posição e se estão concluídas); senão, o motivo;
--   * as últimas mensagens (no máximo 50), em ordem, com: id, autor calculado pelo banco (cliente, escritório,
--     outro — a mesma classificação do aplicador), tipo de conteúdo, texto (cortado em 1.500 caracteres) e se a
--     mensagem é elegível no tempo para cada trilha (veredito da #358 contra a decisão humana da trilha).
-- O que NÃO entrega: horários, telefones, nomes, identidade do remetente, papel, permissão, chave ou qualquer
-- dado de outra conversa ou escritório. O extrator não recebe nada que possa repassar como "fato" de tempo,
-- identidade ou autoridade.

create function public.get_status_automation_context(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_limit integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_gate public.status_track_automation_gate;
  v_conv public.conversations;
  v_att public.status_tracks;
  v_cp public.status_tracks;
  v_opp public.opportunities;
  v_plan public.case_service_plans;
  v_resolution jsonb;
  v_case jsonb;
  v_reason text;
  v_messages jsonb;
begin
  select * into v_gate from public.status_track_automation_gate where singleton;
  if v_gate.enabled is distinct from true then
    raise exception 'automation_disabled';
  end if;
  if p_workspace_id is null or p_conversation_id is null or p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'invalid_request';
  end if;

  select * into v_conv from public.conversations where id = p_conversation_id and workspace_id = p_workspace_id;
  if v_conv.id is null then
    raise exception 'target_not_found';
  end if;
  if v_conv.contact_id is not null and private.privacy_contact_anonymized(v_conv.contact_id) then
    raise exception 'contact_anonymized';
  end if;

  select * into v_att from public.status_tracks where conversation_id = v_conv.id and track = 'attendance';

  -- Caso: a mesma regra do aplicador (vínculo persistido ou caso único do contato; ganho).
  if v_conv.contact_id is null or v_conv.needs_link_review then
    v_reason := 'conversation_link_unresolved';
  else
    v_resolution := private.conversation_case_resolution(v_conv.id, 'owner', null);
    if coalesce((v_resolution ->> 'case_count')::int, 0) = 0 then
      v_reason := 'no_case';
    elsif (v_resolution ->> 'default_opportunity_id') is null
          or not ((v_resolution ->> 'default_source') = 'linked' or (v_resolution ->> 'case_count')::int = 1) then
      v_reason := 'ambiguous_case';
    else
      select * into v_opp from public.opportunities
      where id = (v_resolution ->> 'default_opportunity_id')::uuid and workspace_id = p_workspace_id;
      if v_opp.status <> 'won' then
        v_reason := 'opportunity_not_won';
      elsif private.privacy_opportunity_anonymized(v_opp.id) then
        v_reason := 'contact_anonymized';
      end if;
    end if;
  end if;

  if v_reason is null then
    select * into v_cp from public.status_tracks where opportunity_id = v_opp.id and track = 'case_progress';
    select * into v_plan from public.case_service_plans where opportunity_id = v_opp.id and status = 'active';
    v_case := jsonb_build_object(
      'opportunity_id', v_opp.id,
      'status', coalesce(v_cp.case_progress_status::text, 'nao_informado'),
      'version', coalesce(v_cp.version, 0),
      'paused', coalesce(v_cp.automation_paused, false),
      'plan', case when v_plan.id is null then null else jsonb_build_object(
        'current_step_id', v_plan.current_step_id,
        'steps', coalesce((
          select jsonb_agg(jsonb_build_object('step_id', s.id, 'position', s.position, 'name', s.name,
                                              'completed', s.completed_at is not null) order by s.position)
          from public.case_service_plan_steps s where s.plan_id = v_plan.id), '[]'::jsonb)) end
    );
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'message_id', m.id,
           'author', case private.status_track_automation_message_kind(m)
                       when 'client_message' then 'client' when 'client_file' then 'client'
                       when 'office_message' then 'office' else 'other' end,
           'content_kind', m.content_kind,
           'text', left(m.body_text, 1500),
           'eligible_attendance', private.message_origin_time_evidence_verdict(m.id, v_att.manual_decided_at) = 'eligible',
           'eligible_case', v_reason is null
                            and private.message_origin_time_evidence_verdict(m.id, v_cp.manual_decided_at) = 'eligible'
         ) order by m.created_at, m.id), '[]'::jsonb)
  into v_messages
  from (
    select * from public.messages x
    where x.workspace_id = p_workspace_id and x.conversation_id = v_conv.id
    order by x.created_at desc, x.id desc
    limit p_limit
  ) m;

  return jsonb_build_object(
    'workspace_id', p_workspace_id,
    'conversation_id', v_conv.id,
    'attendance', jsonb_build_object(
      'status', coalesce(v_att.attendance_status::text, 'nao_informado'),
      'version', coalesce(v_att.version, 0),
      'paused', coalesce(v_att.automation_paused, false)),
    'case', v_case,
    'case_unavailable_reason', v_reason,
    'messages', v_messages
  );
end;
$body$;

comment on function public.get_status_automation_context(uuid, uuid, integer) is
  'Conversas + IA (extrator): contexto de LEITURA para propor mudanças ao aplicador — situação do atendimento, caso só quando inequívoco e ganho (com roteiro), últimas mensagens com autor calculado pelo banco, texto cortado e elegibilidade temporal por trilha. Sem horários, telefones, nomes, papel ou permissão. Só service_role e só com o portão do aplicador aberto.';

revoke all on function public.get_status_automation_context(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.get_status_automation_context(uuid, uuid, integer) to service_role;
