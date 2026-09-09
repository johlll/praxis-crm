-- A4 — Leads: RLS.
--
-- Diferente de `contacts` (que permite SELECT direto via RLS), `leads`
-- fica TOTALMENTE trancado por policy — mesmo padrão de `contact_sensitive`
-- na A3, aplicado aqui a uma tabela inteira, não só a um recorte sensível.
-- Motivo: a regra "advogado só vê os leads dele + sem responsável" é um
-- filtro de LINHA que depende do papel de aplicação (memberships.role),
-- que RLS não consegue expressar de forma que sobreviva a uma função
-- SECURITY DEFINER chamando a tabela por fora (SECURITY DEFINER roda como
-- o dono da função, que ignora RLS) — então o filtro reforça primeiro
-- dentro de list_leads()/get_lead(), e a policy aqui garante que NENHUMA
-- outra via (Data API direta, outra função, um relatório futuro) possa
-- ler a tabela ignorando esse filtro, porque não há SELECT nenhum sem
-- passar por uma função que o aplique.

alter table public.leads enable row level security;
alter table public.leads force row level security;

create policy leads_select_deny on public.leads
  for select
  to authenticated
  using (false);

create policy leads_insert_deny on public.leads
  for insert
  to authenticated
  with check (false);

create policy leads_update_deny on public.leads
  for update
  to authenticated
  using (false);

create policy leads_delete_deny on public.leads
  for delete
  to authenticated
  using (false);

alter table public.lead_values enable row level security;
alter table public.lead_values force row level security;

create policy lead_values_select_deny on public.lead_values
  for select
  to authenticated
  using (false);

create policy lead_values_insert_deny on public.lead_values
  for insert
  to authenticated
  with check (false);

create policy lead_values_update_deny on public.lead_values
  for update
  to authenticated
  using (false);

create policy lead_values_delete_deny on public.lead_values
  for delete
  to authenticated
  using (false);
