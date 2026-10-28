-- B3.2d-2b1 — status `accepted` (docs/decisoes/b3-whatsapp-real.md §21).
--
-- Aceita pelo provedor, ainda sem `sent` (§1.3). Migration própria e mínima
-- pelo mesmo motivo da A7 (20260911140000): "alter type ... add value" não
-- pode ser usado na MESMA transação em que o valor novo é referenciado, e a
-- migration seguinte (modelo do domínio) usa `accepted`.
--
-- Entra ANTES de `sent` na ordem do enum. Nenhuma linha existente muda, e a
-- regra da A7 (apply_message_status_event) continua igual: a seguinte só
-- dá a `accepted` o mesmo nível de `queued` no rank da A7.

alter type public.message_status add value if not exists 'accepted' before 'sent';
