-- A3 — private.detect_duplicate_candidates_for(): recalcula os candidatos
-- a duplicidade de um contato contra os demais do mesmo workspace.
--
-- Chamada explicitamente no fim de create_contact()/update_contact_*()
-- (próxima migration) — nunca por trigger em contact_phones/emails/
-- sensitive isoladamente, para não rodar em estado parcial (ver
-- docs/decisoes/a3-duplicidades.md, seção "Quando a detecção roda").
--
-- Regras determinísticas, sem ML, documentadas ANTES desta função em
-- docs/decisoes/a3-duplicidades.md — esta função só implementa o que já
-- estava decidido, não inventa limiar novo.

create function private.detect_duplicate_candidates_for(p_contact_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_workspace_id uuid;
  v_other record;
  v_cpf_match boolean;
  v_phone_match boolean;
  v_email_match boolean;
  v_name_city_match boolean;
  v_name_similarity real;
  v_signals jsonb;
  v_signal_count int;
  v_tier public.duplicate_tier;
  v_priority int;
begin
  select workspace_id into v_workspace_id
    from public.contacts
    where id = p_contact_id and merged_into_contact_id is null;

  if v_workspace_id is null then
    return; -- contato não existe, ou já está mesclado (não compete mais)
  end if;

  for v_other in
    select id, name, city, uf
    from public.contacts
    where workspace_id = v_workspace_id
      and id <> p_contact_id
      and merged_into_contact_id is null
  loop
    -- CPF/CNPJ exato — blind index já contextualizado por workspace
    -- (ambos os contatos são do mesmo workspace aqui, então basta comparar
    -- o índice bruto).
    select exists (
      select 1
      from public.contact_sensitive cs1
      join public.contact_sensitive cs2 on cs2.contact_id = v_other.id
      where cs1.contact_id = p_contact_id
        and cs2.cpf_cnpj_blind_index = cs1.cpf_cnpj_blind_index
    ) into v_cpf_match;

    -- Telefone exato
    select exists (
      select 1
      from public.contact_phones p1
      join public.contact_phones p2 on p2.contact_id = v_other.id
      where p1.contact_id = p_contact_id
        and p2.value_normalized = p1.value_normalized
    ) into v_phone_match;

    -- E-mail exato
    select exists (
      select 1
      from public.contact_emails e1
      join public.contact_emails e2 on e2.contact_id = v_other.id
      where e1.contact_id = p_contact_id
        and e2.value_normalized = e1.value_normalized
    ) into v_email_match;

    -- Nome parecido + cidade/UF compatível — nome sozinho NUNCA conta
    -- (decisão explícita, evita inflar a fila com coincidência de nome
    -- comum). limiar 0.6, documentado em a3-duplicidades.md.
    v_name_city_match := false;
    v_name_similarity := null;
    if v_other.city is not null and v_other.uf is not null then
      select
        (select c.city from public.contacts c where c.id = p_contact_id) is not null
        and (select c.uf from public.contacts c where c.id = p_contact_id) is not null
        and lower(btrim((select c.city from public.contacts c where c.id = p_contact_id))) = lower(btrim(v_other.city))
        and (select c.uf from public.contacts c where c.id = p_contact_id) = v_other.uf,
        extensions.similarity((select c.name from public.contacts c where c.id = p_contact_id), v_other.name)
        into v_name_city_match, v_name_similarity;

      if v_name_city_match and v_name_similarity >= 0.6 then
        v_name_city_match := true;
      else
        v_name_city_match := false;
      end if;
    end if;

    v_signal_count := 0;
    v_signals := '[]'::jsonb;

    if v_cpf_match then
      v_signals := v_signals || jsonb_build_array(jsonb_build_object('type', 'cpf_exact'));
      v_signal_count := v_signal_count + 1;
    end if;
    if v_phone_match then
      v_signals := v_signals || jsonb_build_array(jsonb_build_object('type', 'phone_exact'));
      v_signal_count := v_signal_count + 1;
    end if;
    if v_email_match then
      v_signals := v_signals || jsonb_build_array(jsonb_build_object('type', 'email_exact'));
      v_signal_count := v_signal_count + 1;
    end if;
    if v_name_city_match then
      v_signals := v_signals || jsonb_build_array(
        jsonb_build_object(
          'type', 'name_city_similarity',
          'score', round(v_name_similarity::numeric, 2),
          'city', v_other.city,
          'uf', v_other.uf
        )
      );
      v_signal_count := v_signal_count + 1;
    end if;

    if v_signal_count = 0 then
      -- Sinal que existia sumiu (ex.: telefone corrigido) — um candidato
      -- ainda PENDENTE para este par fica órfão com o sinal velho se não
      -- for removido aqui. Nunca toca em par já decidido (mesclado ou
      -- descartado): decisão humana não é desfeita por uma reavaliação.
      delete from public.duplicate_candidates
      where workspace_id = v_workspace_id
        and least(contact_a_id, contact_b_id) = least(p_contact_id, v_other.id)
        and greatest(contact_a_id, contact_b_id) = greatest(p_contact_id, v_other.id)
        and status = 'pending';
      continue;
    end if;

    -- Nível = o mais alto sinal presente. priority é só ordem de fila,
    -- nunca probabilidade de identidade (a3-duplicidades.md).
    if v_cpf_match then
      v_tier := 'strong';
      v_priority := 100 + v_signal_count;
    elsif v_phone_match or v_email_match then
      v_tier := 'review';
      v_priority := 50 + v_signal_count;
    else
      v_tier := 'low';
      v_priority := 10 + v_signal_count;
    end if;

    if v_signal_count > 0 then
      insert into public.duplicate_candidates (
        workspace_id, contact_a_id, contact_b_id, signals, tier, priority
      )
      values (
        v_workspace_id,
        least(p_contact_id, v_other.id),
        greatest(p_contact_id, v_other.id),
        v_signals, v_tier, v_priority
      )
      on conflict (workspace_id, least(contact_a_id, contact_b_id), greatest(contact_a_id, contact_b_id))
      do update set
        signals = excluded.signals,
        tier = excluded.tier,
        priority = excluded.priority,
        updated_at = now()
      -- Uma decisão humana já tomada (mesclado/descartado) nunca é
      -- reaberta silenciosamente por uma nova detecção — só refresca
      -- enquanto ainda pendente.
      where public.duplicate_candidates.status = 'pending';
    end if;
  end loop;
end;
$body$;

comment on function private.detect_duplicate_candidates_for(uuid) is
  'Recalcula candidatos a duplicidade de um contato contra os demais do workspace. Regras em docs/decisoes/a3-duplicidades.md.';

revoke all on function private.detect_duplicate_candidates_for(uuid) from public;
grant execute on function private.detect_duplicate_candidates_for(uuid) to authenticated;
