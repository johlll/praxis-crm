-- B1 — Propostas: funções de geração/leitura de proposal_documents.
--
-- Duas famílias, com GRANT deliberadamente diferente:
--
-- 1) begin_proposal_document/finalize_proposal_document/fail_proposal_document
--    — ALTERAM estado. GRANT só para service_role. Recebem p_actor_user_id
--    explícito (não auth.uid(): sob service_role não há sessão) — o valor
--    só chega aqui a partir de src/server/proposals/admin/*, que o lê de
--    requireUser().id já verificado contra o Supabase Auth antes de
--    invocar. Nenhum usuário autenticado tem EXECUTE nestas funções — uma
--    tentativa de chamada direta via supabase.rpc() do navegador falha na
--    própria permissão do Postgres, antes de entrar no corpo da função
--    (B1, correção 3: nada aqui é forjável por RPC).
--
-- 2) list_proposal_documents/get_proposal_document_for_download — só
--    LEEM. GRANT para authenticated, auth.uid() interno, projeção por
--    papel — mesmo estilo de get_proposal/list_proposals_for_lead (A9).

-- ---------------------------------------------------------------------
-- begin_proposal_document
-- ---------------------------------------------------------------------

create function public.begin_proposal_document(
  p_proposal_id uuid,
  p_actor_user_id uuid
)
returns table (document_id uuid, version integer, storage_path text)
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_role public.membership_role;
  v_proposal public.proposals;
  v_lead public.leads;
  v_next_version integer;
  v_document_id uuid;
  v_storage_path text;
begin
  if p_actor_user_id is null then
    raise exception 'actor_required';
  end if;

  -- Trava a linha da proposta pelo tempo da transação: um segundo pedido
  -- concorrente de geração para a MESMA proposta espera aqui e só lê o
  -- max(version) depois que o primeiro terminou — duas versões distintas,
  -- nunca colisão (B1, correção 3).
  select * into v_proposal from public.proposals where id = p_proposal_id for update;
  if v_proposal.id is null then
    raise exception 'proposal_not_found';
  end if;

  select * into v_lead from public.leads where id = v_proposal.lead_id;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = p_actor_user_id and status = 'active';

  -- Só quem vê o valor exato da proposta pode gerar o PDF — ele carrega o
  -- valor exato por definição. `sales` continua podendo criar/editar/
  -- registrar envio manual (inalterado desde a A9); só não gera nem baixa
  -- o documento. Mesmo nível de conflict_check.edit (A9).
  if v_role is null or v_role not in ('owner', 'admin', 'manager', 'lawyer') then
    raise exception 'insufficient_permission';
  end if;

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, p_actor_user_id) then
    raise exception 'lead_not_found';
  end if;

  -- Depois de decidida (aceita/recusada), nenhuma versão nova — revisão
  -- comercial é uma PROPOSTA NOVA (create_proposal, já suportado desde a
  -- A9: um lead tem várias propostas), nunca uma reescrita de uma proposta
  -- já fechada. Versões já geradas continuam lendo/baixando normalmente
  -- (B1, correção 4).
  if v_proposal.status in ('aceita', 'recusada') then
    raise exception 'proposal_decided_no_new_document';
  end if;

  -- `version` bare seria ambíguo aqui: o parâmetro de saída de
  -- `returns table (..., version integer, ...)` também se chama version e
  -- fica em escopo na função inteira — daí a qualificação explícita.
  select coalesce(max(proposal_documents.version), 0) + 1 into v_next_version
  from public.proposal_documents where proposal_id = p_proposal_id;

  v_storage_path := 'workspace/' || v_lead.workspace_id::text
    || '/proposal/' || p_proposal_id::text || '/v' || v_next_version::text || '.pdf';

  insert into public.proposal_documents (workspace_id, proposal_id, version, status, storage_path, requested_by)
  values (v_lead.workspace_id, p_proposal_id, v_next_version, 'pending', v_storage_path, p_actor_user_id)
  returning id into v_document_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_lead.workspace_id, p_actor_user_id, 'proposal.document.generation_started', 'proposal_document', v_document_id,
    jsonb_build_object('proposal_id', p_proposal_id, 'version', v_next_version)
  );

  return query select v_document_id, v_next_version, v_storage_path;
end;
$body$;

revoke all on function public.begin_proposal_document(uuid, uuid) from public;
grant execute on function public.begin_proposal_document(uuid, uuid) to service_role;
-- `revoke ... from public` NÃO retira a concessão automática que o
-- Supabase dá a anon/authenticated em toda função nova do schema public
-- (mesmo motivo documentado em 20260921100900_a11_revoke_default_execute.sql)
-- — precisa da revogação explícita abaixo, senão a função fica chamável
-- direto pelo navegador apesar do "revoke ... from public" acima.
revoke execute on function public.begin_proposal_document(uuid, uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- finalize_proposal_document — só vira 'ready' depois de confirmar,
-- lendo storage.objects (MESMO Postgres, MESMO projeto — não é uma
-- chamada de rede), que o arquivo existe com o tamanho esperado (B1,
-- correção 5). Nunca sobrescreve uma linha já 'ready': o UPDATE é
-- filtrado por status='pending', e uma segunda finalização da mesma
-- linha é no-op (document_not_pending), nunca uma troca silenciosa de
-- checksum/tamanho.
-- ---------------------------------------------------------------------

create function public.finalize_proposal_document(
  p_document_id uuid,
  p_checksum_sha256 text,
  p_byte_size bigint,
  p_actor_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_document public.proposal_documents;
  v_object_ok boolean;
  v_updated integer;
begin
  if p_checksum_sha256 is null or p_checksum_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_checksum';
  end if;
  if p_byte_size is null or p_byte_size <= 0 then
    raise exception 'invalid_byte_size';
  end if;

  select * into v_document from public.proposal_documents where id = p_document_id for update;
  if v_document.id is null then
    raise exception 'document_not_found';
  end if;
  if v_document.status <> 'pending' then
    raise exception 'document_not_pending';
  end if;

  select exists (
    select 1 from storage.objects
    where bucket_id = 'proposal-documents'
      and name = v_document.storage_path
      and coalesce((metadata->>'size')::bigint, -1) = p_byte_size
  ) into v_object_ok;

  if not v_object_ok then
    raise exception 'document_object_missing_or_size_mismatch';
  end if;

  update public.proposal_documents
  set status = 'ready', checksum_sha256 = p_checksum_sha256, byte_size = p_byte_size, resolved_at = now()
  where id = p_document_id and status = 'pending';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'document_not_pending';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_document.workspace_id, p_actor_user_id, 'proposal.document.ready', 'proposal_document', p_document_id,
    jsonb_build_object('proposal_id', v_document.proposal_id, 'version', v_document.version, 'byte_size', p_byte_size)
  );
end;
$body$;

revoke all on function public.finalize_proposal_document(uuid, text, bigint, uuid) from public;
grant execute on function public.finalize_proposal_document(uuid, text, bigint, uuid) to service_role;
revoke execute on function public.finalize_proposal_document(uuid, text, bigint, uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- fail_proposal_document — idempotente: só transiciona pending→failed,
-- nunca rebaixa um ready.
-- ---------------------------------------------------------------------

create function public.fail_proposal_document(
  p_document_id uuid,
  p_error_code text,
  p_actor_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_document public.proposal_documents;
  v_updated integer;
begin
  select * into v_document from public.proposal_documents where id = p_document_id for update;
  if v_document.id is null then
    raise exception 'document_not_found';
  end if;
  if v_document.status <> 'pending' then
    return;
  end if;

  update public.proposal_documents
  set status = 'failed', error_code = coalesce(nullif(btrim(p_error_code), ''), 'unknown'), resolved_at = now()
  where id = p_document_id and status = 'pending';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return;
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_document.workspace_id, p_actor_user_id, 'proposal.document.failed', 'proposal_document', p_document_id,
    jsonb_build_object('proposal_id', v_document.proposal_id, 'version', v_document.version, 'error_code', p_error_code)
  );
end;
$body$;

revoke all on function public.fail_proposal_document(uuid, text, uuid) from public;
grant execute on function public.fail_proposal_document(uuid, text, uuid) to service_role;
revoke execute on function public.fail_proposal_document(uuid, text, uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- list_proposal_documents — leitura, projeção por papel. Nunca devolve
-- storage_path/checksum: download passa por
-- get_proposal_document_for_download, nunca por aqui.
-- ---------------------------------------------------------------------

create function public.list_proposal_documents(p_proposal_id uuid)
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
  v_can_download boolean;
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

  v_can_download := v_role in ('owner', 'admin', 'manager', 'lawyer');

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', d.id,
          'version', d.version,
          'status', d.status,
          'requestedAt', d.requested_at,
          'resolvedAt', d.resolved_at,
          'canDownload', v_can_download and d.status = 'ready'
        )
        order by d.version desc
      )
      from public.proposal_documents d
      where d.proposal_id = p_proposal_id
    ),
    '[]'::jsonb
  );
end;
$body$;

revoke all on function public.list_proposal_documents(uuid) from public;
grant execute on function public.list_proposal_documents(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- get_proposal_document_for_download — só devolve storage_path para o
-- papel que enxerga o valor exato, e só de documento 'ready'. Recurso de
-- outro workspace, ou de proposta fora do alcance de 'lawyer', responde
-- 'document_not_found' — nunca 403 (convenção já usada em toda a base).
-- ---------------------------------------------------------------------

create function public.get_proposal_document_for_download(p_document_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_document public.proposal_documents;
  v_proposal public.proposals;
  v_lead public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_document from public.proposal_documents where id = p_document_id;
  if v_document.id is null or v_document.status <> 'ready' then
    raise exception 'document_not_found';
  end if;

  select * into v_proposal from public.proposals where id = v_document.proposal_id;
  select * into v_lead from public.leads where id = v_proposal.lead_id;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if v_role is null or v_role not in ('owner', 'admin', 'manager', 'lawyer') then
    raise exception 'document_not_found';
  end if;

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'document_not_found';
  end if;

  return jsonb_build_object('storagePath', v_document.storage_path, 'version', v_document.version);
end;
$body$;

revoke all on function public.get_proposal_document_for_download(uuid) from public;
grant execute on function public.get_proposal_document_for_download(uuid) to authenticated;
