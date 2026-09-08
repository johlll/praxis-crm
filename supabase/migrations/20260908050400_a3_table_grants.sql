-- A3 — GRANTs de tabela mínimos, aplicando desde o início a lição da A2
-- (achados 21/22, docs/arquitetura.md): RLS e GRANT são camadas
-- independentes, e projeto hospedado sem "Automatically expose new
-- tables" não concede nada sozinho. Desta vez o grant certo entra já na
-- primeira migration da fase, não depois de um bug em produção.
--
-- Só SELECT, só onde a interface desta fase realmente lê por acesso direto
-- à tabela (fora de RPC):
--   * contacts             — listagem/busca (modules/contacts/queries.ts)
--   * contact_phones       — embed na listagem e no detalhe
--   * contact_emails       — embed na listagem e no detalhe
--   * duplicate_candidates — fila de revisão de duplicidades
--
-- Fora da lista, de propósito — nenhum fluxo desta fase lê por fora de
-- RPC:
--   * contact_identifiers   — schema pronto, sem consumidor nesta fase
--   * contact_sensitive     — NUNCA GRANT nenhum, nem SELECT; toda leitura
--     (existência, busca, revelação) passa por função SECURITY DEFINER
--     (contact_has_sensitive, search_contacts_by_cpf_cnpj,
--     reveal_contact_cpf_cnpj)
--   * contact_consents      — schema e contrato de acesso só; sem tela
--   * contact_merges        — histórico de mesclagem, sem tela de listagem
--     nesta fase (auditoria geral fica para fase futura)
--   * sensitive_data_access — trilha de revelação, mesmo motivo
--
-- `anon` não recebe grant nenhum em tabela nenhuma desta fase.
--
-- Sobre REFERENCES/TRIGGER/TRUNCATE/MAINTAIN concedidos por padrão pela
-- plataforma: a migration 20260908030000_a2_revoke_default_table_privileges.sql
-- já alterou o DEFAULT PRIVILEGES do papel `postgres` em `public` para não
-- conceder mais isso a `anon`/`authenticated` em NENHUMA tabela futura —
-- as 9 tabelas desta fase já nascem sem eles, sem precisar repetir a
-- correção aqui. Verificado por asserção pgTAP dedicada (não por suposição
-- — a A2 já ensinou a não confiar nisso de olho).

grant select on public.contacts to authenticated;
grant select on public.contact_phones to authenticated;
grant select on public.contact_emails to authenticated;
grant select on public.duplicate_candidates to authenticated;
