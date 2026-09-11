-- A7 — Conversas + simulador de WhatsApp: novo valor de activity_source.
--
-- Migration própria e mínima de propósito: "alter type ... add value" não
-- pode ser usado na MESMA transação em que o valor novo é referenciado
-- (restrição do Postgres, independente da versão) — separar num arquivo
-- só com isto garante que a migration seguinte (schema da A7, que cria
-- activities.source_conversation_message_id e vai querer inserir
-- source = 'whatsapp_inbound' em teste/seed depois) sempre vê o valor já
-- comitado.

alter type public.activity_source add value 'whatsapp_inbound';

comment on type public.activity_source is
  'Origem da atividade: manual, automática por regra de etapa (A6), ou automática pela primeira mensagem de WhatsApp de um contato novo (A7 — ver source_conversation_id).';
