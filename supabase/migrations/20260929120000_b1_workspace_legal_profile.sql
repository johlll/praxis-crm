-- B1 — Propostas: perfil jurídico do escritório.
--
-- O cabeçalho do PDF de proposta precisa se identificar como documento do
-- escritório (decisão revisada da B1, item 6): razão social, CNPJ, OAB e
-- endereço. Nenhum campo é obrigatório — um escritório que ainda não
-- preencheu OAB/endereço continua gerando PDF normalmente, com as linhas
-- correspondentes simplesmente ausentes do documento. Só `legal_name` é
-- exigido para o ENVIO real por e-mail (checado em
-- queue_proposal_email, não aqui): mandar uma proposta sem nenhuma
-- identificação de quem a envia não é defensável, mesmo que gerar o PDF
-- para conferência interna seja.
--
-- Leitura e escrita reaproveitam as policies de RLS que já existem em
-- workspaces desde a A2 (workspaces_select: qualquer membro ativo;
-- workspaces_update: só owner/admin) — nenhuma função nova é necessária
-- para este dado.

alter table public.workspaces
  add column legal_name text
    check (legal_name is null or char_length(btrim(legal_name)) between 1 and 200),
  add column cnpj text
    check (cnpj is null or cnpj ~ '^[0-9]{14}$'),
  add column oab_uf char(2)
    check (oab_uf is null or oab_uf ~ '^[A-Z]{2}$'),
  add column oab_number text
    check (oab_number is null or char_length(btrim(oab_number)) between 1 and 40),
  add column address_line text
    check (address_line is null or char_length(btrim(address_line)) between 1 and 200),
  add column address_city text
    check (address_city is null or char_length(btrim(address_city)) between 1 and 120),
  add column address_uf char(2)
    check (address_uf is null or address_uf ~ '^[A-Z]{2}$'),
  add column address_zip text
    check (address_zip is null or address_zip ~ '^[0-9]{8}$');

comment on column public.workspaces.legal_name is
  'Razão social exibida no cabeçalho do PDF de proposta (B1). Opcional para geração; obrigatório para envio real por e-mail — ver queue_proposal_email.';

comment on column public.workspaces.cnpj is 'Só dígitos, sem máscara. Opcional, nunca obrigatório no documento.';

comment on column public.workspaces.oab_number is 'Número de inscrição na OAB, formato livre (varia por seccional). Opcional.';
