-- B1 — pré-requisito para a FK composta de proposal_documents/
-- proposal_email_sends: `proposal_id` (workspace_id, proposal_id) só pode
-- referenciar `proposals (workspace_id, id)` se existir um constraint
-- único batendo exatamente essas duas colunas — `id` sozinho (PK) não
-- basta para o Postgres aceitar a FK composta (SQLSTATE 42830, exatamente
-- o motivo que fez `clients_workspace_id_id_key` já existir desde a A8
-- para o mesmo propósito, com `client_handoffs`).
--
-- Redundante com a PK (todo id já é globalmente único, `workspace_id` não
-- adiciona nenhuma restrição de fato) — existe só para o Postgres aceitar
-- a FK composta, mesmo padrão já usado em clients/leads/opportunities.

alter table public.proposals
  add constraint proposals_workspace_id_id_key unique (workspace_id, id);
