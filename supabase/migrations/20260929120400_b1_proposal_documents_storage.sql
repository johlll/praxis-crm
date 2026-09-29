-- B1 — Propostas: bucket de Storage para os PDFs gerados.
--
-- Privado, sem NENHUMA policy de RLS para authenticated/anon em
-- storage.objects deste bucket — de propósito. O canal sancionado de
-- acesso é inteiramente em Postgres (get_proposal_document_for_download,
-- que decide QUEM pode baixar QUAL versão) mais o cliente service_role
-- isolado (src/server/proposals/admin/storage.ts) para efetivamente criar
-- a URL assinada de curta duração — nunca Storage RLS reimplementando a
-- mesma regra de papel/alcance de lead já resolvida em SQL. Ver
-- docs/decisoes/b1-propostas.md.
--
-- 10 MiB é generoso para uma proposta de honorários em texto; aceita
-- só application/pdf porque é o único tipo que este fluxo gera.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proposal-documents', 'proposal-documents', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;
