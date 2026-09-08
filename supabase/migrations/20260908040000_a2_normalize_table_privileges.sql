-- Fecha a lacuna que a própria suíte pgTAP nova (04_security_hardening,
-- asserções de table_privs_are) expôs ao rodar pela primeira vez no CI: o
-- Postgres local que `supabase start` sobe tem um baseline de privilégios
-- BEM mais aberto do que o projeto hospedado — não só os quatro
-- (REFERENCES/TRIGGER/TRUNCATE/MAINTAIN) revogados na migration anterior,
-- mas INSERT/UPDATE/DELETE completos para `authenticated` e até
-- SELECT/INSERT/UPDATE/DELETE para `anon`, em toda tabela nova. Nenhum dos
-- dois ambientes tinha esse baseline documentado em lugar nenhum — cada um
-- concede algo diferente por padrão, e nenhum dos dois é confiável como
-- "o que este projeto realmente autoriza".
--
-- Em vez de continuar caçando e revogando privilégio por privilégio
-- (frágil: o próximo ambiente pode ter um default diferente de novo), esta
-- migration RESETA para zero e declara de novo, por completo, o estado
-- pretendido — a mesma foto que 20260908020000_a2_table_grants.sql já
-- declarava, só que agora sem depender de nenhum default de plataforma
-- para chegar lá. Fica seguro reaplicar isto a qualquer momento (revoke +
-- grant é idempotente) e serve de referência única, self-contained, de
-- "o que authenticated/anon realmente têm nestas 5 tabelas" — sem
-- precisar somar mentalmente com o que a plataforma concedeu por conta
-- própria.

revoke all on public.workspaces from anon, authenticated;
revoke all on public.users from anon, authenticated;
revoke all on public.memberships from anon, authenticated;
revoke all on public.workspace_invitations from anon, authenticated;
revoke all on public.audit_logs from anon, authenticated;

-- audit_logs fica de fora do grant de propósito: nenhuma tela desta fase
-- lê a trilha diretamente, e toda escrita passa pelas funções SECURITY
-- DEFINER (create_workspace_with_owner e as demais) — sem grant nenhum,
-- authenticated não tem como fabricar, alterar, apagar OU ler um registro
-- de auditoria por fora delas.
grant select on public.workspaces to authenticated;
grant select on public.users to authenticated;
grant select on public.memberships to authenticated;
grant select on public.workspace_invitations to authenticated;
