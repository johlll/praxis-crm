-- A11 — funções auxiliares (schema private, nunca expostas ao cliente).
--
-- Contrato: docs/decisoes/a11-ingestao-atribuicao.md §9 e §10.

-- ---------------------------------------------------------------------
-- private.touchpoint_effective_opportunity — a ponta VIGENTE da cadeia
--
-- Precedência (contrato §10):
--   1. sem cadeia de correção → vale o vínculo ORIGINAL do touchpoint;
--   2. existindo cadeia       → só a ponta vigente vale;
--   3. 'unassign' vigente     → o touchpoint fica NÃO atribuído.
--
-- A ponta vigente é encontrada sem recursão: como `supersedes_id` só pode
-- ser usado uma vez (índice parcial único), a folha é a única linha do
-- touchpoint que ninguém sucede.
-- ---------------------------------------------------------------------

create function private.touchpoint_effective_opportunity(p_touchpoint_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $body$
  select case
    when leaf.id is null then t.opportunity_id
    when leaf.action = 'unassign' then null
    else leaf.opportunity_id
  end
  from public.touchpoints t
  left join lateral (
    select l.id, l.action, l.opportunity_id
    from public.touchpoint_demand_links l
    where l.touchpoint_id = t.id
      and not exists (
        select 1 from public.touchpoint_demand_links c where c.supersedes_id = l.id
      )
    limit 1
  ) leaf on true
  where t.id = p_touchpoint_id;
$body$;

comment on function private.touchpoint_effective_opportunity(uuid) is
  'Oportunidade VIGENTE de um touchpoint: o vínculo original quando não há cadeia de correção, a ponta da cadeia quando há, e NULL quando a ponta vigente é unassign.';

-- ---------------------------------------------------------------------
-- private.opportunity_eligible_touchpoints — a população da atribuição
--
-- O mesmo `lead_id` NUNCA é suficiente (contrato §9): a A5 permite um
-- lead com várias oportunidades, e um touchpoint de uma delas não pode
-- contaminar a outra. Elegível para a oportunidade O é apenas o
-- touchpoint cuja oportunidade VIGENTE é O — o que cobre tanto "ligado
-- diretamente a O na origem" quanto "corrigido para O depois".
--
-- `originally_direct` distingue os dois casos, porque a CONVERSÃO exige
-- vínculo original direto (contrato §9), e o primeiro/último toque não.
--
-- Guarda do ganho: numa oportunidade ganha, nenhum touchpoint RECEBIDO
-- depois do ganho recebe crédito, mesmo declarando data anterior — é
-- exatamente o que a data declarada permitiria forjar.
-- ---------------------------------------------------------------------

create function private.opportunity_eligible_touchpoints(p_opportunity_id uuid)
returns table (
  touchpoint_id uuid,
  normalized_occurred_at timestamptz,
  received_at timestamptz,
  originally_direct boolean
)
language sql
stable
set search_path = ''
as $body$
  select
    t.id,
    t.normalized_occurred_at,
    t.received_at,
    t.opportunity_id is not distinct from o.id
  from public.opportunities o
  join public.leads l on l.id = o.lead_id
  -- Candidatos: só os touchpoints do MESMO contato. Não é um atalho de
  -- desempenho — é invariante: correct_touchpoint_demand_link() recusa
  -- vincular um touchpoint a oportunidade de outro contato, então um
  -- touchpoint de fora nunca poderia ser elegível. (Também é o que
  -- permite usar touchpoints_contact_idx em vez de varrer o workspace.)
  join public.touchpoints t
    on t.workspace_id = o.workspace_id and t.contact_id = l.contact_id
  where o.id = p_opportunity_id
    and private.touchpoint_effective_opportunity(t.id) = o.id
    and (
      o.won_at is null
      or (t.received_at <= o.won_at and t.normalized_occurred_at <= o.won_at)
    );
$body$;

comment on function private.opportunity_eligible_touchpoints(uuid) is
  'Touchpoints elegíveis à atribuição de uma oportunidade: os cuja oportunidade vigente é ela. Exclui os recebidos depois do ganho. originally_direct marca vínculo original direto, exigido só pela conversão.';

-- ---------------------------------------------------------------------
-- private.opportunity_attribution — primeiro toque, último toque e
-- conversão de UMA oportunidade, num único lugar.
--
-- Desempate determinístico e documentado:
--   primeiro toque: normalized_occurred_at ASC, received_at ASC, id ASC
--   último toque:   normalized_occurred_at DESC, received_at DESC, id DESC
-- ---------------------------------------------------------------------

create function private.opportunity_attribution(p_opportunity_id uuid)
returns table (
  first_touch_id uuid,
  last_touch_id uuid,
  conversion_id uuid
)
language sql
stable
set search_path = ''
as $body$
  with e as (
    select * from private.opportunity_eligible_touchpoints(p_opportunity_id)
  )
  select
    (select touchpoint_id from e
      order by normalized_occurred_at asc, received_at asc, touchpoint_id asc limit 1),
    (select touchpoint_id from e
      order by normalized_occurred_at desc, received_at desc, touchpoint_id desc limit 1),
    -- Conversão: regra mais restrita, sem opção configurável nesta fase.
    -- Exige vínculo ORIGINAL direto com esta oportunidade; um touchpoint
    -- apenas corrigido para cá participa de primeiro/último toque, nunca
    -- da conversão.
    (select touchpoint_id from e where originally_direct
      order by normalized_occurred_at desc, received_at desc, touchpoint_id desc limit 1);
$body$;

comment on function private.opportunity_attribution(uuid) is
  'Primeiro toque, último toque e conversão de uma oportunidade (A11). Conversão exige vínculo original direto; os outros dois aceitam vínculo vigente corrigido.';

-- ---------------------------------------------------------------------
-- private.touchpoint_source_label — rótulo de origem usado no filtro e
-- nos modelos do painel. Sem origem declarada, nunca inventa: devolve
-- NULL, que a interface mostra como "Não informada".
-- ---------------------------------------------------------------------

create function private.touchpoint_source_label(p_touchpoint_id uuid)
returns text
language sql
stable
set search_path = ''
as $body$
  select nullif(btrim(coalesce(t.source, t.channel)), '')
  from public.touchpoints t
  where t.id = p_touchpoint_id;
$body$;

revoke all on function private.touchpoint_effective_opportunity(uuid) from public;
revoke all on function private.opportunity_eligible_touchpoints(uuid) from public;
revoke all on function private.opportunity_attribution(uuid) from public;
revoke all on function private.touchpoint_source_label(uuid) from public;
