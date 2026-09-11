-- A6 — correção: excluir uma regra automática já utilizada falhava.
--
-- Achado real (revisão pré-merge do PR #6, reproduzido antes de corrigir,
-- em DUAS camadas — a segunda só apareceu depois de corrigir a primeira):
--
-- 1ª causa raiz: activities_source_rule_same_workspace_fkey usa
-- "on delete set null" (documentado desde a criação — comentário da
-- própria delete_stage_auto_activity_rule() já dizia "nenhuma atividade
-- já criada é afetada, ela só perde a referência da regra"), mas a CHECK
-- activities_source_consistency EXIGIA source_rule_id IS NOT NULL sempre
-- que source = 'stage_rule'. Excluir a regra faz o Postgres tentar
-- zerar source_rule_id nas atividades que a referenciam (ação da FK) —
-- e essa mesma UPDATE interna era IMEDIATAMENTE barrada pela CHECK.
--
-- 2ª causa raiz (só descoberta testando a correção da 1ª ao vivo contra
-- praxis-crm-dev, com uma regra e atividade REAIS geradas na validação
-- da Fase C): "on delete set null" numa FK COMPOSTA, sem lista de
-- colunas, zera TODAS as colunas da chave referenciadora — não só
-- source_rule_id, mas TAMBÉM workspace_id, porque a FK é
-- "foreign key (workspace_id, source_rule_id) references ...". Isso
-- violava a NOT NULL de activities.workspace_id (erro real observado:
-- "null value in column workspace_id ... violates not-null
-- constraint"), um bug ainda mais sério que o da CHECK — teria apagado
-- o próprio vínculo de workspace da atividade, não só a origem.
--
-- As duas causas juntas explicam por que a exclusão de uma regra já
-- usada nunca funcionou de verdade, apesar do comentário da função
-- sempre ter descrito o comportamento pretendido corretamente.
--
-- O mesmo defeito também é alcançável por um caminho da A5 sem relação
-- direta com "excluir regra": delete_pipeline_stage() só bloqueia se a
-- etapa tiver oportunidades atualmente nela (stage_occupied) — não checa
-- histórico. Uma etapa esvaziada que já teve uma regra com atividades
-- geradas também cascateava (pipeline_stages -> stage_auto_activity_rules
-- "on delete cascade") pro mesmo conflito. A correção abaixo resolve os
-- dois caminhos de uma vez, sem precisar tocar em delete_pipeline_stage()
-- nem em delete_stage_auto_activity_rule(), que já faziam exatamente o
-- que deveriam.
--
-- Correção (duas partes):
-- 1. A CHECK passa a aceitar source_rule_id nulo também para
--    source = 'stage_rule' — a atividade continua marcada como
--    automática (source), continua rastreável por QUAL transição a
--    gerou (source_stage_transition_id, nunca apagado), só perde o
--    vínculo com uma regra que não existe mais.
-- 2. A FK passa a usar "on delete set null (source_rule_id)" — sintaxe
--    de lista de colunas (Postgres 15+; confirmado 17.6 em
--    praxis-crm-dev) que restringe a ação a SÓ essa coluna, nunca
--    workspace_id.
--
-- Nenhuma atividade é apagada; workspace_id nunca muda; nenhuma outra
-- coluna é tocada.
--
-- Migration nova (não edita 20260911120000_a6_schema.sql, já aplicada em
-- praxis-crm-dev) — aplicável tanto a bancos que já rodaram a versão
-- original quanto a um banco novo aplicando tudo do zero (a CHECK só
-- fica mais permissiva e a FK só fica mais restrita na coluna que zera;
-- nenhum dado existente pode violar a versão nova).

alter table public.activities
  drop constraint activities_source_consistency;

alter table public.activities
  add constraint activities_source_consistency check (
    (source = 'manual' and source_stage_transition_id is null and source_rule_id is null) or
    (source = 'stage_rule' and source_stage_transition_id is not null)
  );

comment on constraint activities_source_consistency on public.activities is
  'source=stage_rule exige source_stage_transition_id (rastreabilidade de QUAL transição gerou a atividade, imutável) mas NÃO exige source_rule_id — a regra pode ser excluída depois (FK composta com ON DELETE SET NULL restrito à coluna source_rule_id) sem que isso apague ou invalide a atividade já gerada.';

alter table public.activities
  drop constraint activities_source_rule_same_workspace_fkey;

alter table public.activities
  add constraint activities_source_rule_same_workspace_fkey
  foreign key (workspace_id, source_rule_id)
  references public.stage_auto_activity_rules (workspace_id, id)
  on delete set null (source_rule_id);

comment on constraint activities_source_rule_same_workspace_fkey on public.activities is
  'ON DELETE SET NULL restrito à coluna source_rule_id (sintaxe de lista de colunas, Postgres 15+) — sem a lista, "on delete set null" numa FK composta zeraria TODAS as colunas da chave, incluindo workspace_id (NOT NULL), quebrando a atividade em vez de só desvincular a regra excluída.';
