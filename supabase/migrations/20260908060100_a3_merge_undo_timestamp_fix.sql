-- A3 — corrige um bug real de merge_contacts()/unmerge_contact(), achado
-- testando o desfazer ao vivo (não por leitura de código): `now()` é
-- congelado durante toda a transação no Postgres, e contact_phones/
-- contact_emails/contact_consents/contacts têm gatilho `set_updated_at`
-- que dispara em QUALQUER UPDATE — inclusive o próprio UPDATE de
-- reparentamento/sobrescrita feito DENTRO de merge_contacts(). O código
-- original capturava `updated_at` ANTES desse UPDATE como "previous_
-- updated_at" (a base pra unmerge_contact() comparar depois), mas o
-- UPDATE seguinte já bate esse mesmo valor pra `now()` da transação — ou
-- seja, o valor "antes" gravado nunca bate com o valor real logo após a
-- mesclagem, e unmerge_contact() recusava o desfazer por "conflito" em
-- TODA mesclagem com telefone/e-mail/consentimento movido ou campo
-- sobrescrito, mesmo sem nenhuma edição real ter acontecido depois.
--
-- Correção: usar `UPDATE ... RETURNING updated_at` para capturar o
-- timestamp DEPOIS do próprio UPDATE de mesclagem (o baseline correto
-- contra o qual uma edição POSTERIOR de verdade é comparada), não antes.
-- Mesma assinatura, mesmo GRANT — só substitui o corpo.

create or replace function public.merge_contacts(
  p_kept_contact_id uuid,
  p_merged_contact_id uuid,
  p_field_resolutions jsonb default '{}'::jsonb,
  p_candidate_id uuid default null
)
returns public.contacts
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_kept public.contacts;
  v_merged public.contacts;
  v_workspace_id uuid;
  v_previous jsonb := '{}'::jsonb;
  v_moved jsonb := '[]'::jsonb;
  v_row record;
  v_field_updated_at timestamptz;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_kept_contact_id = p_merged_contact_id then
    raise exception 'cannot_merge_contact_with_itself';
  end if;

  -- Lock nas duas linhas antes de checar qualquer estado — impede duas
  -- mesclagens concorrentes no mesmo par.
  select * into v_kept from public.contacts where id = p_kept_contact_id for update;
  select * into v_merged from public.contacts where id = p_merged_contact_id for update;

  if v_kept.id is null or v_merged.id is null then
    raise exception 'contact_not_found';
  end if;

  if v_kept.workspace_id <> v_merged.workspace_id then
    raise exception 'cross_workspace_merge_denied';
  end if;
  v_workspace_id := v_kept.workspace_id;

  if not private.has_workspace_role(
    v_workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if v_kept.merged_into_contact_id is not null or v_merged.merged_into_contact_id is not null then
    raise exception 'contact_already_merged';
  end if;

  -- Resolução de campo conflitante: default mantém o valor do contato
  -- vencedor; só troca se o chamador escolher 'b' explicitamente.
  -- `previous_updated_at` vem do RETURNING do próprio UPDATE (o estado
  -- logo APÓS a mesclagem), nunca de um SELECT anterior a ele.
  if p_field_resolutions ->> 'name' = 'b' then
    update public.contacts set name = v_merged.name where id = v_kept.id
      returning updated_at into v_field_updated_at;
    v_previous := v_previous || jsonb_build_object(
      'name', jsonb_build_object('previous', v_kept.name, 'previous_updated_at', v_field_updated_at)
    );
  end if;
  if p_field_resolutions ->> 'city' = 'b' then
    update public.contacts set city = v_merged.city where id = v_kept.id
      returning updated_at into v_field_updated_at;
    v_previous := v_previous || jsonb_build_object(
      'city', jsonb_build_object('previous', v_kept.city, 'previous_updated_at', v_field_updated_at)
    );
  end if;
  if p_field_resolutions ->> 'uf' = 'b' then
    update public.contacts set uf = v_merged.uf where id = v_kept.id
      returning updated_at into v_field_updated_at;
    v_previous := v_previous || jsonb_build_object(
      'uf', jsonb_build_object('previous', v_kept.uf, 'previous_updated_at', v_field_updated_at)
    );
  end if;
  if p_field_resolutions ->> 'preferred_channel' = 'b' then
    update public.contacts set preferred_channel = v_merged.preferred_channel where id = v_kept.id
      returning updated_at into v_field_updated_at;
    v_previous := v_previous || jsonb_build_object(
      'preferred_channel', jsonb_build_object('previous', v_kept.preferred_channel, 'previous_updated_at', v_field_updated_at)
    );
  end if;

  -- Reparenta telefones/e-mails/identificadores/consentimentos — o
  -- UPDATE...RETURNING captura `updated_at` DEPOIS do próprio reparente
  -- (o gatilho já rodou), que é o baseline certo pra unmerge_contact()
  -- comparar contra uma edição futura de verdade.
  for v_row in
    update public.contact_phones set contact_id = v_kept.id
    where contact_id = v_merged.id
    returning id, updated_at
  loop
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'contact_phones', 'id', v_row.id, 'previous_updated_at', v_row.updated_at)
    );
  end loop;

  for v_row in
    update public.contact_emails set contact_id = v_kept.id
    where contact_id = v_merged.id
    returning id, updated_at
  loop
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'contact_emails', 'id', v_row.id, 'previous_updated_at', v_row.updated_at)
    );
  end loop;

  -- contact_identifiers não tem coluna updated_at — só existência importa
  -- pro undo (sem gatilho, sem bug de timestamp aqui).
  for v_row in
    update public.contact_identifiers set contact_id = v_kept.id
    where contact_id = v_merged.id
    returning id
  loop
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'contact_identifiers', 'id', v_row.id, 'previous_updated_at', null)
    );
  end loop;

  for v_row in
    update public.contact_consents set contact_id = v_kept.id
    where contact_id = v_merged.id
    returning id, updated_at
  loop
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'contact_consents', 'id', v_row.id, 'previous_updated_at', v_row.updated_at)
    );
  end loop;

  -- contact_sensitive: só reparenta se o vencedor ainda não tiver CPF — se
  -- os dois tiverem, a linha de v_merged fica onde está (nada é perdido,
  -- sem ambiguidade de qual CPF é "o" do vencedor). Undo checa só
  -- existência aqui (previous_updated_at null), não timestamp — mesmo sem
  -- o bug, não precisava do RETURNING, mas mantém o padrão.
  if not exists (select 1 from public.contact_sensitive where contact_id = v_kept.id)
     and exists (select 1 from public.contact_sensitive where contact_id = v_merged.id) then
    v_moved := v_moved || jsonb_build_array(
      jsonb_build_object('table', 'contact_sensitive', 'id', v_merged.id, 'previous_updated_at', null)
    );
    update public.contact_sensitive set contact_id = v_kept.id where contact_id = v_merged.id;
  end if;

  update public.contacts set merged_into_contact_id = v_kept.id where id = v_merged.id;

  insert into public.contact_merges (
    workspace_id, kept_contact_id, merged_contact_id, candidate_id,
    kept_contact_previous_values, moved_rows, merged_by
  )
  values (v_workspace_id, v_kept.id, v_merged.id, p_candidate_id, v_previous, v_moved, v_actor);

  if p_candidate_id is not null then
    update public.duplicate_candidates
      set status = 'merged', decided_by = v_actor, decided_at = now()
      where id = p_candidate_id and status = 'pending';
  end if;

  -- Qualquer outro candidato pendente envolvendo o contato que virou
  -- "mesclado" deixa de fazer sentido — ele não compete mais.
  update public.duplicate_candidates
    set status = 'dismissed', decided_by = v_actor, decided_at = now()
    where workspace_id = v_workspace_id
      and status = 'pending'
      and (contact_a_id = v_merged.id or contact_b_id = v_merged.id);

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_workspace_id, v_actor, 'contact.merged', 'contact', v_kept.id,
    jsonb_build_object('merged_contact_id', v_merged.id)
  );

  select * into v_kept from public.contacts where id = v_kept.id;
  return v_kept;
end;
$body$;
