-- A11 — estado terminal `resolved` para outbox órfã (achado real: uma
-- outbox cujo webhook_event já chegou a um status terminal por OUTRO
-- caminho — processado, expirado sem processamento, ou purgado — nunca
-- convergia. `claim_outbox_batch` recusa (corretamente) reivindicar essas
-- linhas, mas nada nunca as tirava de `pending`/`failed`/`publishing`:
-- ficavam paradas para sempre, sem serem republicadas e sem serem
-- marcadas como concluídas.
--
-- Forward-only: nenhuma migration anterior é editada. As duas outboxes
-- órfãs já existentes no banco hospedado (evidência preservada de um
-- teste controlado anterior) só mudam de estado pelo caminho normal do
-- reconciliador (migration seguinte), nunca por UPDATE manual aqui.

alter type public.outbox_state add value if not exists 'resolved';
