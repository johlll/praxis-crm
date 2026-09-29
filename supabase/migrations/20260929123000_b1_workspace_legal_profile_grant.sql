-- B1 — Correção pós-validação hospedada: `updateWorkspaceLegalProfileAction`
-- (tela Configurações → Escritório) chama `.from("workspaces").update(...)`
-- sob a sessão do usuário, contando com a policy `workspaces_update` (A2,
-- `supabase/migrations/20260907120200_a2_rls.sql`) para restringir a
-- owner/admin. Essa policy sempre existiu, mas NUNCA foi acompanhada do
-- GRANT de tabela correspondente — `authenticated` só tinha SELECT em
-- `public.workspaces` (`20260908040000_a2_normalize_table_privileges.sql`).
-- RLS decide QUAIS LINHAS uma escrita permitida enxerga; sem o GRANT, a
-- escrita nunca chega a ser avaliada e falha com "permission denied for
-- table workspaces" — reproduzido de fato contra o banco hospedado
-- (praxis-crm-dev) antes desta migration existir.
--
-- Correção: GRANT apenas nas 8 colunas do perfil jurídico — nunca a
-- tabela inteira. `name`, `slug` e `created_by` continuam sem qualquer
-- caminho de escrita direta para `authenticated` (renomear workspace
-- seguirá exigindo uma função própria, como todo o resto desta base).

grant update (legal_name, cnpj, oab_uf, oab_number, address_line, address_city, address_uf, address_zip)
  on public.workspaces to authenticated;
