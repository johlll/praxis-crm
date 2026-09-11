-- A7 — GRANT de tabela. Mesmo achado já documentado desde a A3
-- (20260908050700): toda tabela nova nasce sem NENHUM privilégio padrão
-- para anon/authenticated — a policy de SELECT sozinha não basta.
--
-- whatsapp_channels — config, SELECT direto (mesma categoria de
-- stage_auto_activity_rules).
--
-- contact_consents — a A3 já tinha a policy de SELECT (20260908050100) mas
-- nunca o GRANT (revogado de propósito em 20260908050700, "sem tela
-- própria ainda"). A7 é a primeira fase que realmente lê consentimento na
-- tela (painel de consentimento na conversa) — o GRANT entra aqui.
--
-- conversations/messages/message_status_events não entram aqui: são
-- deny-all (mesma categoria de activities/opportunities), acessadas só por
-- função SECURITY DEFINER.

grant select on public.whatsapp_channels to authenticated;
grant select on public.contact_consents to authenticated;
