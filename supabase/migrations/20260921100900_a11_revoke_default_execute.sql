-- A11 — retira o EXECUTE que o Supabase concede por padrão a anon e
-- authenticated em toda função nova do schema public.
--
-- As migrations anteriores da A11 fizeram `revoke all ... from public` e
-- concederam só ao papel certo, mas `from public` não alcança as
-- concessões diretas a anon/authenticated feitas pelos default privileges
-- do Supabase. Resultado (reproduzido pelo pgTAP 18): authenticated podia
-- chamar a ingestão direto — pulando Turnstile e rate limit —, ler o
-- payload cifrado e acionar fila e retenção; anon podia chamar as funções
-- de configuração e atribuição (que recusam sem sessão, mas não deveriam
-- nem ser executáveis).
--
-- Forward-only: nenhuma migration anterior é editada.

-- Exclusivas do service_role (rota pública de ingestão e jobs).
revoke execute on function public.resolve_form_endpoint(text) from anon, authenticated;
revoke execute on function public.ingest_form_event(uuid, uuid, bytea, text, bytea, bytea, bytea, text, text, jsonb, timestamptz, integer, integer) from anon, authenticated;
revoke execute on function public.claim_outbox_batch(integer, integer) from anon, authenticated;
revoke execute on function public.mark_outbox_published(uuid) from anon, authenticated;
revoke execute on function public.mark_outbox_failed(uuid, text, integer) from anon, authenticated;
revoke execute on function public.process_form_event(uuid, jsonb) from anon, authenticated;
revoke execute on function public.mark_webhook_event_failed(uuid, text) from anon, authenticated;
revoke execute on function public.get_webhook_event_payload(uuid) from anon, authenticated;
revoke execute on function public.purge_expired_webhook_events(integer) from anon, authenticated;
revoke execute on function public.flag_stuck_webhook_events(integer) from anon, authenticated;
revoke execute on function public.flag_expiring_webhook_events(integer, integer) from anon, authenticated;

-- Funções de usuário autenticado: nenhuma é de anon.
revoke execute on function public.create_form_endpoint(uuid, text, uuid, uuid, text, public.activity_type, integer, public.form_capture_mode, text, text[], text, jsonb, integer) from anon;
revoke execute on function public.update_form_endpoint(uuid, text, uuid, uuid, text, public.activity_type, integer, public.form_capture_mode, text, text[], jsonb) from anon;
revoke execute on function public.set_form_endpoint_status(uuid, public.form_endpoint_status) from anon;
revoke execute on function public.rotate_form_endpoint_key(uuid, text) from anon;
revoke execute on function public.list_form_endpoints(uuid) from anon;
revoke execute on function public.correct_touchpoint_demand_link(uuid, uuid, public.touchpoint_link_action, uuid, text) from anon;
revoke execute on function public.get_lead_attribution(uuid) from anon;
revoke execute on function public.get_dashboard_attribution(uuid, integer, text, text, uuid, boolean, text) from anon;
