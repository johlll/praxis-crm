-- A11 — Formulários próprios e atribuição multitoque: novo valor de
-- activity_source.
--
-- Mesma razão da A7 (20260911140000_a7_enum_extensions.sql): "alter type
-- ... add value" não pode ser usado na MESMA transação em que o valor novo
-- é referenciado. Separar num arquivo só com isto garante que a migration
-- seguinte (schema da A11, cujas funções inserem activities com
-- source = 'form_intake') sempre veja o valor já comitado.

alter type public.activity_source add value 'form_intake';

comment on type public.activity_source is
  'Origem da atividade: manual, automática por regra de etapa (A6), pela primeira mensagem de WhatsApp de um contato novo (A7), ou pela captação de um formulário público próprio (A11 — ver webhook_events/form_endpoints).';

-- Finalidade técnica do consentimento do FORMULÁRIO — separada de
-- 'whatsapp_atendimento' (A7). Uma nunca é derivada da outra: receber um
-- formulário não autoriza envio ativo por WhatsApp, e o gate de envio
-- (private.contact_has_active_consent) continua exigindo exatamente
-- 'whatsapp_atendimento', sem enxergar este valor novo.
alter type public.consent_purpose add value 'formulario_contato';

comment on type public.consent_purpose is
  'Finalidade técnica FECHADA do consentimento, usada para decidir acesso (nunca o texto livre de contact_consents.purpose): atendimento e marketing por WhatsApp (A7) e contato a partir de formulário público próprio (A11).';
