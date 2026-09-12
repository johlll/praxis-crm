-- A8 — Clientes e handoff: schema.
--
-- `clients`/`client_handoffs` já existem desde a A5 (fundação mínima
-- antecipada, só o necessário para win_opportunity() criar/vincular ao
-- ganhar). Esta migration acrescenta só o que falta para a tela de
-- Clientes de verdade: controle de concorrência otimista na mudança de
-- status/responsável, mesmo padrão de opportunities.lock_version.
--
-- Decisão aprovada (item 5 do pedido): "Cliente desde" reaproveita
-- clients.created_at (já é o momento real da conversão, gravado dentro da
-- MESMA transação de win_opportunity() — confirmado lendo
-- 20260909100500_a5_win_requirements.sql) — nenhuma coluna nova
-- (`converted_at` seria duplicar o mesmo instante sem nenhuma semântica
-- adicional).
--
-- Decisão aprovada (item 2): nenhum campo financeiro (valor, modelo de
-- honorários, assinatura) é copiado para `clients` — esses dados
-- continuam existindo só em `opportunities`, por design da A5, mantido
-- sem alteração nesta fase.

alter table public.clients
  add column lock_version bigint not null default 0;

comment on column public.clients.lock_version is
  'Controle de concorrência otimista para update_client_status()/transfer_client_owner() — mesmo padrão de opportunities.lock_version (A5) e activities.lock_version (A6): incrementado atomicamente a cada UPDATE bem-sucedido, comparado no WHERE, nunca lido e regravado às cegas.';
