-- Assistente (primeira versão): cadastro de pessoa + caso por conversa.
--
-- Não cria regra nova de cadastro. O Assistente usa o fluxo oficial do Praxis:
-- `public.create_contact` (permissão, auditoria e fila de duplicidades da A3) e
-- `public.create_lead` (permissão, contato do mesmo escritório, auditoria e evento de automação).
-- O que esta migration acrescenta:
--
--   1. `public.assistant_find_contact_matches`: LEITURA dos contatos do escritório que podem ser a
--      mesma pessoa, ANTES de cadastrar, para a pessoa decidir (mesmo telefone, mesmo e-mail, nome
--      igual ou parecido). Não grava nada nem mexe na fila de duplicidades.
--   2. `public.assistant_register_client`: as duas criações numa transação só, com uma chave de
--      solicitação. Clique duplo, reenvio ou duas chamadas simultâneas com a mesma chave devolvem o
--      MESMO cadastro, sem criar um segundo.
--
-- O escritório chega do servidor do app (sessão), e as funções conferem de novo o papel de quem chama.
-- Nenhuma tabela ou função anterior é alterada.

create table public.assistant_requests (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  request_id uuid not null,
  actor_user_id uuid not null references auth.users (id) on delete cascade,
  payload_hash text not null,
  contact_id uuid references public.contacts (id) on delete set null,
  lead_id uuid references public.leads (id) on delete set null,
  contact_created boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (workspace_id, request_id)
);

comment on table public.assistant_requests is
  'Uma linha por confirmação de cadastro do Assistente: impede que a mesma solicitação crie dois cadastros.';

-- Trancada como leads: RLS ligada e NENHUMA policy; só a função abaixo (SECURITY DEFINER) lê e grava.
alter table public.assistant_requests enable row level security;
revoke all on table public.assistant_requests from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Possíveis duplicidades antes de cadastrar (só leitura).
-- ---------------------------------------------------------------------
create function public.assistant_find_contact_matches(
  p_workspace_id uuid,
  p_name text,
  p_phone text default null,
  p_email text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if v_name = '' and v_phone is null and v_email is null then
    return '[]'::jsonb;
  end if;

  with sinais as (
    select c.id,
           c.name,
           c.created_at,
           exists (
             select 1 from public.contact_phones p
             where p.contact_id = c.id and v_phone is not null and p.value_normalized = v_phone
           ) as mesmo_telefone,
           exists (
             select 1 from public.contact_emails e
             where e.contact_id = c.id and v_email is not null and lower(e.value_normalized) = v_email
           ) as mesmo_email,
           v_name <> '' and lower(c.name) = lower(v_name) as nome_igual,
           -- Parecido = mesmo primeiro nome e grafia próxima ("Ana Ribeyro" para "Ana Ribeiro"). Só o
           -- sobrenome em comum não basta: "Marina Teixeira" não é aviso para "Marcos Teixeira".
           v_name <> ''
             and split_part(lower(btrim(c.name)), ' ', 1) = split_part(lower(v_name), ' ', 1)
             and extensions.similarity(lower(c.name), lower(v_name)) >= 0.6 as nome_parecido
    from public.contacts c
    where c.workspace_id = p_workspace_id
      and c.merged_into_contact_id is null
      and c.anonymized_at is null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'contact_id', s.id,
           'name', s.name,
           'created_at', s.created_at,
           'signals', to_jsonb(array_remove(array[
             case when s.mesmo_telefone then 'phone' end,
             case when s.mesmo_email then 'email' end,
             case when s.nome_igual then 'same_name' when s.nome_parecido then 'similar_name' end
           ], null)),
           'lead_count', (select count(*) from public.leads l where l.contact_id = s.id)
         ) order by (s.mesmo_telefone or s.mesmo_email) desc, s.nome_igual desc, s.created_at desc), '[]'::jsonb)
  into v_result
  from (
    select * from sinais
    where mesmo_telefone or mesmo_email or nome_igual or nome_parecido
    order by (mesmo_telefone or mesmo_email) desc, nome_igual desc, created_at desc
    limit 5
  ) s;

  return v_result;
end;
$body$;

comment on function public.assistant_find_contact_matches(uuid, text, text, text) is
  'Assistente: contatos do escritório que podem ser a mesma pessoa, antes de cadastrar. Só leitura.';

revoke all on function public.assistant_find_contact_matches(uuid, text, text, text) from public, anon;
grant execute on function public.assistant_find_contact_matches(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Cadastro confirmado: contato (novo ou existente) + lead, uma vez só por solicitação.
-- ---------------------------------------------------------------------
create function public.assistant_register_client(
  p_workspace_id uuid,
  p_request_id uuid,
  p_name text,
  p_legal_area text,
  p_summary text default null,
  p_phones jsonb default '[]'::jsonb,
  p_emails jsonb default '[]'::jsonb,
  p_existing_contact_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_hash text;
  v_inserted integer;
  v_request public.assistant_requests;
  v_contact public.contacts;
  v_contact_id uuid;
  v_lead_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  -- Mesmos papéis de create_contact e create_lead: quem não pode cadastrar não chega a reservar a chave.
  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if p_request_id is null then
    raise exception 'invalid_request';
  end if;

  v_hash := md5(jsonb_build_object(
    'name', btrim(coalesce(p_name, '')),
    'legal_area', btrim(coalesce(p_legal_area, '')),
    'summary', btrim(coalesce(p_summary, '')),
    'phones', coalesce(p_phones, '[]'::jsonb),
    'emails', coalesce(p_emails, '[]'::jsonb),
    'existing_contact_id', p_existing_contact_id
  )::text);

  -- A chave primária serializa duas chamadas simultâneas com a mesma solicitação: a segunda espera a
  -- primeira terminar e então encontra a linha já preenchida.
  insert into public.assistant_requests (workspace_id, request_id, actor_user_id, payload_hash)
  values (p_workspace_id, p_request_id, v_actor, v_hash)
  on conflict (workspace_id, request_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    select * into v_request from public.assistant_requests
    where workspace_id = p_workspace_id and request_id = p_request_id;
    if v_request.actor_user_id <> v_actor or v_request.payload_hash <> v_hash then
      raise exception 'assistant_request_conflict';
    end if;
    if v_request.lead_id is null then
      raise exception 'assistant_request_unavailable';
    end if;
    return jsonb_build_object(
      'contact_id', v_request.contact_id,
      'lead_id', v_request.lead_id,
      'contact_created', v_request.contact_created,
      'replayed', true
    );
  end if;

  if p_existing_contact_id is null then
    v_contact := public.create_contact(
      p_workspace_id, 'pf'::public.contact_type, p_name, null, null, null,
      coalesce(p_phones, '[]'::jsonb), coalesce(p_emails, '[]'::jsonb), null, null, null
    );
    v_contact_id := v_contact.id;
  else
    v_contact_id := p_existing_contact_id;
  end if;

  -- create_lead confere que o contato é deste escritório e não foi mesclado.
  v_lead_id := public.create_lead(p_workspace_id, v_contact_id, p_legal_area, p_summary);

  update public.assistant_requests
  set contact_id = v_contact_id, lead_id = v_lead_id, contact_created = p_existing_contact_id is null
  where workspace_id = p_workspace_id and request_id = p_request_id;

  return jsonb_build_object(
    'contact_id', v_contact_id,
    'lead_id', v_lead_id,
    'contact_created', p_existing_contact_id is null,
    'replayed', false
  );
end;
$body$;

comment on function public.assistant_register_client(uuid, uuid, text, text, text, jsonb, jsonb, uuid) is
  'Assistente: cadastra contato (ou usa um existente) e lead pelo fluxo oficial, uma vez só por solicitação.';

revoke all on function public.assistant_register_client(uuid, uuid, text, text, text, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.assistant_register_client(uuid, uuid, text, text, text, jsonb, jsonb, uuid) to authenticated;
