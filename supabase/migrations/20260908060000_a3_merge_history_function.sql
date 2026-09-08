-- A3 — função de leitura para a entrada mínima de "desfazer mesclagem" na
-- interface (aprovada explicitamente pelo usuário depois do PR aberto: a
-- ausência dessa tela não tinha sido uma exclusão de escopo aprovada).
--
-- contact_merges não tem GRANT nenhum para authenticated (revogado em
-- 20260908050700, de propósito — é auditoria/histórico, não uma tabela de
-- leitura livre). Esta função expõe só o mínimo necessário para a UI: com
-- quem foi mesclado, quando, e se já foi desfeito — nunca o snapshot bruto
-- (kept_contact_previous_values/moved_rows), que é detalhe interno de
-- unmerge_contact(), não algo pra mostrar na tela.
--
-- Não duplica a lógica de detecção de conflito de unmerge_contact() aqui —
-- a UI sempre oferece o botão "Desfazer" para uma mesclagem ainda não
-- desfeita, e é a própria chamada a unmerge_contact() que decide se há
-- conflito, retornando o erro "undo_conflict" (já mapeado em
-- src/lib/errors.ts) se algo foi alterado depois. Duas fontes de verdade
-- pra a mesma checagem seria o tipo de duplicação que este projeto evita
-- de propósito (ver docs/decisoes/*.md).

create function public.get_contact_merge_history(p_contact_id uuid)
returns table (
  merge_id uuid,
  merged_contact_id uuid,
  merged_contact_name text,
  merged_at timestamptz,
  undone_at timestamptz
)
language sql
security definer
stable
set search_path = ''
as $body$
  select
    cm.id,
    cm.merged_contact_id,
    mc.name,
    cm.merged_at,
    cm.undone_at
  from public.contact_merges cm
  join public.contacts kc on kc.id = cm.kept_contact_id
  join public.contacts mc on mc.id = cm.merged_contact_id
  where cm.kept_contact_id = p_contact_id
    and kc.workspace_id in (select private.auth_workspace_ids())
  order by cm.merged_at desc;
$body$;

revoke all on function public.get_contact_merge_history(uuid) from public;
grant execute on function public.get_contact_merge_history(uuid) to authenticated;
