#!/usr/bin/env bash
# Documentos por caso sob concorrência REAL (sessões Postgres simultâneas). O pgTAP 61 prova as regras numa
# sessão só; aqui se prova que pedidos AO MESMO TEMPO não duplicam nada nem sobrescrevem em silêncio:
#
#   1. Mesma chave de envio, três sessões juntas (clique duplo / resposta perdida): um documento só; as outras
#      duas terminam sem erro, como repetição.
#   2. Duas conferências AO MESMO TEMPO com a mesma versão: uma grava, a outra recebe
#      case_document_review_conflict; nenhuma sobrescreve a outra em silêncio.
#   3. Duas finalizações simultâneas do mesmo envio: uma grava, a outra é repetição; uma auditoria só.
#   4. Remoção e conferência ao mesmo tempo: o resultado é sempre coerente (a conferência entra antes da
#      remoção ou é recusada depois dela); nunca uma conferência num documento já em remoção.
#   5. Duas conclusões de remoção simultâneas: o registro sai uma vez, com uma auditoria só.
#   6. A anonimização segura a trava do caso e grava a marca: o envio que chega no meio ESPERA, relê e é
#      recusado (contact_anonymized) — nada novo entra no caso anonimizado.
#   7. Finalização e cancelamento disputando o MESMO envio, finalização primeiro na fila da trava: o documento
#      fica pronto e o cancelamento é recusado (document_not_pending) — nada a apagar.
#   8. A mesma disputa com o cancelamento primeiro: o envio fica reservado para cancelamento e a finalização é
#      recusada — nunca um documento pronto que o cancelamento vá apagar.
#   9. Disputa solta (as duas sessões liberadas juntas), repetida: sempre exatamente UM vencedor.
#  10. Repetição do begin (link novo) e cancelamento ao mesmo tempo: ou a repetição é recusada (sem link novo),
#      ou a janela estendida por ela entra na reserva — o caminho fica vigiado pelo link mais recente.
#
# Workspace próprio (criado aqui), usuárias fictícias do seed, Postgres LOCAL. O portão de recebimento é aberto
# só durante o teste (com referência de teste) e fechado de novo ao sair, mesmo em falha. Nada hospedado.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
CARLA="20000000-0000-0000-0000-000000000003"
DANIEL="20000000-0000-0000-0000-000000000004"
HOLD=2
PORTAO=6106001
FAILS=0
SHA="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

psql_as() { # $1 = application_name; resto = argumentos do psql
  local app="$1"; shift
  docker exec -i -e PGAPPNAME="$app" "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

fail() { echo "FALHOU: $*" >&2; exit 1; }
bad() { echo "   FALHOU: $*" >&2; FAILS=$((FAILS + 1)); }

fechar_portao() {
  psql_as doc_main -c "update public.case_document_upload_gate set enabled = false, backup_activation_ref = null, changed_at = now()" >/dev/null 2>&1 || true
}
trap fechar_portao EXIT

wait_sleeping() {
  for _ in $(seq 1 100); do
    if [ "$(psql_as doc_main -c "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

wait_lock_waiters() {
  for _ in $(seq 1 100); do
    if [ "$(psql_as doc_main -c "select count(*) from pg_stat_activity where application_name like '$2%' and wait_event_type = 'Lock'")" = "$1" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

as_user() { # $1 = usuária
  printf '%s\n' "begin;" "set local role authenticated;" \
    "select set_config('request.jwt.claims', json_build_object('sub', '$1', 'role', 'authenticated')::text, true);"
}
as_service() { printf '%s\n' "begin;" "set local role service_role;"; }

run_as() { { as_user "$1"; echo "$2"; echo "commit;"; } | psql_as doc_setup | tail -1; }
run_service() { { as_service; echo "$1"; echo "commit;"; } | psql_as doc_setup | tail -1; }
count() { psql_as doc_main -c "$1"; }
subir() { psql_as doc_setup -c "insert into storage.objects (bucket_id, name, metadata) select 'case-documents', storage_path, jsonb_build_object('size', $2) from public.case_documents where id = '$1'" >/dev/null; }

open_gate() {
  psql_as doc_porteiro >/dev/null 2>&1 <<SQL &
select pg_advisory_lock($PORTAO);
select pg_sleep(60);
SQL
  PID_G=$!
  wait_sleeping doc_porteiro
}
release_gate() {
  wait_lock_waiters "$1" "$2" || fail "as sessões $2 não chegaram ao portão"
  psql_as doc_main -c "select pg_cancel_backend(pid) from pg_stat_activity where application_name = 'doc_porteiro'" >/dev/null
  wait "$PID_G" || true
}

echo "== preparo (workspace próprio, advogada e gerente como integrantes, contato, lead sem responsável, caso aberto)"
psql_as doc_main -c "update public.case_document_upload_gate set enabled = true, backup_activation_ref = 'teste local de concorrência — sem backup real', changed_at = now()" >/dev/null
SLUG="conc-doc-$(date +%s%N | cut -c10-17)"
WS="$(run_as "$ANA" "select (public.create_workspace_with_owner('Concorrência documentos', '$SLUG')).id;")"
[ -n "$WS" ] || fail "não criou o workspace"
psql_as doc_setup -c "insert into public.memberships (workspace_id, user_id, role, status) values ('$WS', '$CARLA', 'lawyer', 'active'), ('$WS', '$DANIEL', 'manager', 'active');" >/dev/null
CONTATO="$(run_as "$ANA" "select (public.create_contact('$WS'::uuid, 'pf', 'Contato concorrência documentos', null, null, null)).id;")"
LEAD="$(run_as "$ANA" "select public.create_lead('$WS'::uuid, '$CONTATO'::uuid, 'Imobiliário', null, '{}'::text[], 'media', null);")"
OPP="$(run_as "$ANA" "select public.create_opportunity('$LEAD'::uuid);")"
[ -n "$OPP" ] || fail "não criou o caso"
# Outro contato e caso para as disputas de cancelamento (7–10): o cenário 6 anonimiza o primeiro contato.
CONTATO2="$(run_as "$ANA" "select (public.create_contact('$WS'::uuid, 'pf', 'Contato concorrência cancelamento', null, null, null)).id;")"
LEAD2="$(run_as "$ANA" "select public.create_lead('$WS'::uuid, '$CONTATO2'::uuid, 'Imobiliário', null, '{}'::text[], 'media', null);")"
OPP2="$(run_as "$ANA" "select public.create_opportunity('$LEAD2'::uuid);")"
[ -n "$OPP2" ] || fail "não criou o segundo caso"

# Segura a trava da linha do documento (como uma finalização ou um cancelamento em curso) até release_row.
hold_row() {
  psql_as doc_trava >/dev/null 2>&1 <<SQL &
begin;
select 1 from public.case_documents where id = '$1' for update;
select pg_sleep(60);
SQL
  PID_H=$!
  wait_sleeping doc_trava
}
release_row() {
  psql_as doc_main -c "select pg_cancel_backend(pid) from pg_stat_activity where application_name = 'doc_trava'" >/dev/null
  wait "$PID_H" || true
}
novo_envio() { # $1 = nome; devolve o id de um envio pendente com o objeto já no Storage
  local id
  id="$(run_service "select public.begin_case_document('$OPP2'::uuid, '$ANA'::uuid, '$1', 'application/pdf', 1000, gen_random_uuid()) ->> 'document_id';")"
  subir "$id" 1000
  echo "$id"
}
FIN_SQL() { echo "select public.finalize_case_document('$1'::uuid, '$ANA'::uuid, 'application/pdf', 1000, '$SHA') ->> 'replayed';"; }
ABN_SQL() { echo "select public.begin_case_document_abandon('$1'::uuid, '$ANA'::uuid, 'upload_interrupted') ->> 'status';"; }

echo "== 1. mesma chave de envio, três sessões juntas"
CHAVE="e0000000-0000-4000-8000-$(date +%s%N | cut -c7-18)"
open_gate
PIDS=(); OUTS=()
for n in 1 2 3; do
  OUT="$(mktemp)"; OUTS+=("$OUT")
  psql_as "doc_k_$n" > "$OUT" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_service)
select public.begin_case_document('$OPP'::uuid, '$ANA'::uuid, 'contrato.pdf', 'application/pdf', 1000, '$CHAVE'::uuid) ->> 'replayed';
commit;
SQL
  PIDS+=($!)
done
release_gate 3 doc_k_
REPETIDOS=0
for i in 0 1 2; do
  rc=0; wait "${PIDS[$i]}" || rc=$?
  [ "$rc" -eq 0 ] || bad "o pedido $((i + 1)) falhou: $(cat "${OUTS[$i]}")"
  grep -qx "true" "${OUTS[$i]}" && REPETIDOS=$((REPETIDOS + 1))
done
[ "$REPETIDOS" = "2" ] || bad "dois dos três deveriam ser repetição, foram $REPETIDOS"
[ "$(count "select count(*) from public.case_documents where idempotency_key = '$CHAVE'")" = "1" ] || bad "a chave deveria ter um único documento"
DOC="$(count "select id from public.case_documents where idempotency_key = '$CHAVE'")"
[ "$FAILS" -eq 0 ] && echo "   ok: um documento, duas repetições sem erro"

echo "== 3. duas finalizações simultâneas do mesmo envio"
ANTES="$FAILS"
subir "$DOC" 1000
open_gate
PIDS=(); OUTS=()
for n in 1 2; do
  OUT="$(mktemp)"; OUTS+=("$OUT")
  psql_as "doc_f_$n" > "$OUT" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_service)
select public.finalize_case_document('$DOC'::uuid, '$ANA'::uuid, 'application/pdf', 1000, '$SHA') ->> 'replayed';
commit;
SQL
  PIDS+=($!)
done
release_gate 2 doc_f_
REP=0
for i in 0 1; do
  rc=0; wait "${PIDS[$i]}" || rc=$?
  [ "$rc" -eq 0 ] || bad "a finalização $((i + 1)) falhou: $(cat "${OUTS[$i]}")"
  grep -qx "true" "${OUTS[$i]}" && REP=$((REP + 1))
done
[ "$REP" = "1" ] || bad "uma das duas deveria ser repetição, foram $REP"
[ "$(count "select count(*) from public.audit_logs where action = 'case_document.uploaded' and metadata ->> 'document_id' = '$DOC'")" = "1" ] || bad "deveria haver uma auditoria de envio só"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: pronto uma vez, uma repetição, uma auditoria"

echo "== 2. duas conferências ao mesmo tempo, com a mesma versão"
ANTES="$FAILS"
open_gate
OUT_A="$(mktemp)"; OUT_B="$(mktemp)"
psql_as doc_r_1 > "$OUT_A" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_user "$ANA")
select public.set_case_document_review('$DOC'::uuid, 'conferido', '', 0) ->> 'review_status';
commit;
SQL
PID_A=$!
psql_as doc_r_2 > "$OUT_B" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_user "$DANIEL")
select public.set_case_document_review('$DOC'::uuid, 'com_pendencia', 'Falta a página 2', 0) ->> 'review_status';
commit;
SQL
PID_B=$!
release_gate 2 doc_r_
RC_A=0; wait "$PID_A" || RC_A=$?
RC_B=0; wait "$PID_B" || RC_B=$?
OK=0; CONF=0
for pair in "$RC_A:$OUT_A" "$RC_B:$OUT_B"; do
  rc="${pair%%:*}"; out="${pair#*:}"
  if [ "$rc" -eq 0 ]; then OK=$((OK + 1));
  elif grep -q "case_document_review_conflict" "$out"; then CONF=$((CONF + 1));
  else bad "erro inesperado: $(cat "$out")"; fi
done
[ "$OK" = "1" ] && [ "$CONF" = "1" ] || bad "esperado 1 gravação e 1 conflito, houve $OK e $CONF"
[ "$(count "select review_version from public.case_documents where id = '$DOC'")" = "1" ] || bad "a versão deveria ser 1 (uma conferência só)"
[ "$(count "select count(*) from public.audit_logs where action = 'case_document.reviewed' and metadata ->> 'document_id' = '$DOC'")" = "1" ] || bad "uma auditoria de conferência só"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: uma conferência gravada, a outra recebeu conflito; versão 1"

echo "== 4. remoção e conferência ao mesmo tempo"
ANTES="$FAILS"
V="$(count "select review_version from public.case_documents where id = '$DOC'")"
open_gate
OUT_R="$(mktemp)"; OUT_C="$(mktemp)"
psql_as doc_x_1 > "$OUT_R" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_service)
select public.begin_case_document_removal('$DOC'::uuid, '$ANA'::uuid, 'duplicado') ->> 'replayed';
commit;
SQL
PID_R=$!
psql_as doc_x_2 > "$OUT_C" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_user "$CARLA")
select public.set_case_document_review('$DOC'::uuid, 'recebido', '', $V) ->> 'review_status';
commit;
SQL
PID_C=$!
release_gate 2 doc_x_
RC_R=0; wait "$PID_R" || RC_R=$?
RC_C=0; wait "$PID_C" || RC_C=$?
[ "$RC_R" -eq 0 ] || bad "a remoção falhou: $(cat "$OUT_R")"
if [ "$RC_C" -ne 0 ]; then
  grep -q "document_not_found" "$OUT_C" || bad "a conferência falhou com erro inesperado: $(cat "$OUT_C")"
fi
[ "$(count "select status from public.case_documents where id = '$DOC'")" = "removing" ] || bad "o documento deveria estar em remoção"
# Coerência: se a conferência entrou, entrou ANTES do pedido de remoção (nunca num documento já em remoção).
[ "$(count "select count(*) from public.case_documents where id = '$DOC' and reviewed_at is not null and reviewed_at > removal_requested_at")" = "0" ] \
  || bad "houve conferência depois do pedido de remoção"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: remoção iniciada; a conferência entrou antes ou foi recusada depois (rc=$RC_C)"

echo "== 5. duas conclusões de remoção simultâneas"
ANTES="$FAILS"
# Simula a remoção pela API do Storage (o Supabase real recusa DELETE direto sem esta configuração da sessão).
psql_as doc_setup >/dev/null <<SQL
begin;
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'case-documents' and name = (select storage_path from public.case_documents where id = '$DOC');
commit;
SQL
open_gate
PIDS=(); OUTS=()
for n in 1 2; do
  OUT="$(mktemp)"; OUTS+=("$OUT")
  psql_as "doc_z_$n" > "$OUT" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_service)
select public.finalize_case_document_removal('$DOC'::uuid, '$ANA'::uuid);
commit;
SQL
  PIDS+=($!)
done
release_gate 2 doc_z_
TRUES=0
for i in 0 1; do
  rc=0; wait "${PIDS[$i]}" || rc=$?
  [ "$rc" -eq 0 ] || bad "a conclusão $((i + 1)) falhou: $(cat "${OUTS[$i]}")"
  grep -qx "t" "${OUTS[$i]}" && TRUES=$((TRUES + 1))
done
[ "$TRUES" = "1" ] || bad "só uma conclusão deveria apagar o registro, foram $TRUES"
[ "$(count "select count(*) from public.case_documents where id = '$DOC'")" = "0" ] || bad "o registro deveria ter saído"
[ "$(count "select count(*) from public.audit_logs where action = 'case_document.removed' and metadata ->> 'document_id' = '$DOC'")" = "1" ] || bad "uma auditoria de remoção só"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: o registro saiu uma vez, uma auditoria"

disputa_ordenada() { # $1 = id; $2 = primeiro (fin|abn); preenche RC_FIN/RC_ABN e OUT_FIN/OUT_ABN
  local primeiro="$2"
  hold_row "$1"
  OUT_FIN="$(mktemp)"; OUT_ABN="$(mktemp)"
  if [ "$primeiro" = "fin" ]; then
    { as_service; FIN_SQL "$1"; echo "commit;"; } | psql_as doc_o_fin > "$OUT_FIN" 2>&1 & PID_FIN=$!
    wait_lock_waiters 1 doc_o_ || fail "a finalização não chegou à trava"
    { as_service; ABN_SQL "$1"; echo "commit;"; } | psql_as doc_o_abn > "$OUT_ABN" 2>&1 & PID_ABN=$!
  else
    { as_service; ABN_SQL "$1"; echo "commit;"; } | psql_as doc_o_abn > "$OUT_ABN" 2>&1 & PID_ABN=$!
    wait_lock_waiters 1 doc_o_ || fail "o cancelamento não chegou à trava"
    { as_service; FIN_SQL "$1"; echo "commit;"; } | psql_as doc_o_fin > "$OUT_FIN" 2>&1 & PID_FIN=$!
  fi
  wait_lock_waiters 2 doc_o_ || fail "as duas sessões não chegaram à trava"
  release_row
  RC_FIN=0; wait "$PID_FIN" || RC_FIN=$?
  RC_ABN=0; wait "$PID_ABN" || RC_ABN=$?
}

echo "== 7. finalização e cancelamento do mesmo envio — finalização primeiro"
ANTES="$FAILS"
D7="$(novo_envio sete.pdf)"
disputa_ordenada "$D7" fin
[ "$RC_FIN" -eq 0 ] || bad "a finalização deveria vencer: $(cat "$OUT_FIN")"
[ "$RC_ABN" -ne 0 ] && grep -q "document_not_pending" "$OUT_ABN" || bad "o cancelamento deveria ser recusado com document_not_pending: $(cat "$OUT_ABN")"
[ "$(count "select status from public.case_documents where id = '$D7'")" = "ready" ] || bad "o documento deveria estar pronto"
[ "$(count "select count(*) from storage.objects o join public.case_documents d on d.storage_path = o.name where d.id = '$D7' and o.bucket_id = 'case-documents'")" = "1" ] \
  || bad "o documento pronto precisa do objeto"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: pronto, com o objeto; cancelamento recusado"

echo "== 8. finalização e cancelamento do mesmo envio — cancelamento primeiro"
ANTES="$FAILS"
D8="$(novo_envio oito.pdf)"
disputa_ordenada "$D8" abn
[ "$RC_ABN" -eq 0 ] && grep -qx "abandoning" "$OUT_ABN" || bad "o cancelamento deveria reservar: $(cat "$OUT_ABN")"
[ "$RC_FIN" -ne 0 ] && grep -q "document_not_pending" "$OUT_FIN" || bad "a finalização deveria ser recusada com document_not_pending: $(cat "$OUT_FIN")"
[ "$(count "select status from public.case_documents where id = '$D8'")" = "abandoning" ] || bad "o envio deveria ficar reservado para cancelamento"
[ "$(count "select count(*) from public.audit_logs where action = 'case_document.uploaded' and metadata ->> 'document_id' = '$D8'")" = "0" ] || bad "não pode haver auditoria de envio concluído"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: reservado para cancelamento; finalização recusada"

echo "== 9. disputa solta, repetida: sempre um vencedor só"
ANTES="$FAILS"
for r in 1 2 3 4 5; do
  D9="$(novo_envio "nove-$r.pdf")"
  open_gate
  OUT_F="$(mktemp)"; OUT_A="$(mktemp)"
  { echo "select pg_advisory_lock_shared($PORTAO);"; as_service; FIN_SQL "$D9"; echo "commit;"; } | psql_as doc_s_fin > "$OUT_F" 2>&1 & PF=$!
  { echo "select pg_advisory_lock_shared($PORTAO);"; as_service; ABN_SQL "$D9"; echo "commit;"; } | psql_as doc_s_abn > "$OUT_A" 2>&1 & PA=$!
  release_gate 2 doc_s_
  RF=0; wait "$PF" || RF=$?
  RA=0; wait "$PA" || RA=$?
  ST="$(count "select status from public.case_documents where id = '$D9'")"
  if [ "$RF" -eq 0 ] && [ "$RA" -ne 0 ] && [ "$ST" = "ready" ] && grep -q "document_not_pending" "$OUT_A"; then :
  elif [ "$RA" -eq 0 ] && [ "$RF" -ne 0 ] && [ "$ST" = "abandoning" ] && grep -q "document_not_pending" "$OUT_F"; then :
  else bad "rodada $r: resultado ambíguo (fin rc=$RF, cancel rc=$RA, status=$ST): $(cat "$OUT_F") / $(cat "$OUT_A")"; fi
done
[ "$(count "select count(*) from public.case_documents d where d.opportunity_id = '$OPP2' and d.status = 'ready'
  and not exists (select 1 from storage.objects o where o.bucket_id = 'case-documents' and o.name = d.storage_path)")" = "0" ] || bad "documento pronto sem objeto"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: 5 rodadas, um vencedor em cada"

echo "== 10. repetição do begin (link novo) e cancelamento ao mesmo tempo"
ANTES="$FAILS"
CH10="e1000000-0000-4000-8000-$(date +%s%N | cut -c7-18)"
D10="$(run_service "select public.begin_case_document('$OPP2'::uuid, '$ANA'::uuid, 'dez.pdf', 'application/pdf', 1000, '$CH10'::uuid) ->> 'document_id';")"
# O primeiro link foi emitido "há muito tempo": a janela gravada já está quase no fim.
psql_as doc_setup >/dev/null <<SQL
begin;
alter table public.case_documents disable trigger case_documents_guard;
update public.case_documents set upload_window_until = clock_timestamp() + interval '1 minute' where id = '$D10';
alter table public.case_documents enable trigger case_documents_guard;
commit;
SQL
open_gate
OUT_B="$(mktemp)"; OUT_A="$(mktemp)"
{ echo "select pg_advisory_lock_shared($PORTAO);"; as_service; echo "select public.begin_case_document('$OPP2'::uuid, '$ANA'::uuid, 'dez.pdf', 'application/pdf', 1000, '$CH10'::uuid) ->> 'status';"; echo "commit;"; } | psql_as doc_t_beg > "$OUT_B" 2>&1 & PB=$!
{ echo "select pg_advisory_lock_shared($PORTAO);"; as_service; ABN_SQL "$D10"; echo "commit;"; } | psql_as doc_t_abn > "$OUT_A" 2>&1 & PA=$!
release_gate 2 doc_t_
RB=0; wait "$PB" || RB=$?
RA=0; wait "$PA" || RA=$?
[ "$RA" -eq 0 ] || bad "o cancelamento deveria reservar: $(cat "$OUT_A")"
if [ "$RB" -eq 0 ]; then
  # A repetição entrou antes: a reserva carrega a janela do link NOVO.
  [ "$(count "select count(*) from public.case_documents where id = '$D10' and status = 'abandoning' and upload_window_until > clock_timestamp() + interval '2 hours 50 minutes'")" = "1" ] \
    || bad "a reserva deveria carregar a janela do link emitido pela repetição"
  echo "   (a repetição entrou antes do cancelamento)"
else
  grep -q "document_not_pending" "$OUT_B" || bad "a repetição deveria ser recusada com document_not_pending: $(cat "$OUT_B")"
  echo "   (o cancelamento entrou antes: repetição recusada, sem link novo)"
fi
# Ao concluir o cancelamento (objeto nunca chegou), o caminho fica vigiado até o fim da janela gravada.
run_service "select public.finalize_case_document_abandon('$D10'::uuid, '$ANA'::uuid);" >/dev/null
[ "$(count "select count(*) from public.case_document_storage_cleanup where document_id = '$D10' and watch_until = (select max(watch_until) from public.case_document_storage_cleanup where document_id = '$D10') and watch_until > clock_timestamp()")" = "1" ] \
  || bad "o caminho deveria ficar vigiado na fila até o fim da janela"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: sem link novo depois da reserva; janela do link mais recente preservada na fila"

echo "== 6. a anonimização segura o caso; o envio que chega no meio espera e é recusado"
ANTES="$FAILS"
OUT_A="$(mktemp)"
psql_as doc_anon > "$OUT_A" 2>&1 <<SQL &
begin;
select 1 from public.opportunities where id = '$OPP' for update;
update public.contacts set anonymized_at = now() where id = '$CONTATO';
select pg_sleep($HOLD);
commit;
SQL
PID_A=$!
wait_sleeping doc_anon
OUT_U="$(mktemp)"
rc=0
{ as_service; echo "select public.begin_case_document('$OPP'::uuid, '$ANA'::uuid, 'depois.pdf', 'application/pdf', 10, gen_random_uuid());"; echo "commit;"; } \
  | psql_as doc_envio > "$OUT_U" 2>&1 || rc=$?
wait "$PID_A" || bad "a sessão da anonimização falhou: $(cat "$OUT_A")"
[ "$rc" -ne 0 ] && grep -q "contact_anonymized" "$OUT_U" || bad "o envio deveria ser recusado com contact_anonymized: $(cat "$OUT_U")"
[ "$(count "select count(*) from public.case_documents where opportunity_id = '$OPP'")" = "0" ] || bad "nada deveria ter entrado no caso anonimizado"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: o envio esperou a anonimização, releu e foi recusado"

fechar_portao
[ "$(count "select enabled from public.case_document_upload_gate")" = "f" ] || bad "o portão deveria voltar fechado"

if [ "$FAILS" -gt 0 ]; then
  fail "$FAILS verificação(ões) falharam — documentos inconsistentes sob concorrência"
fi
echo "== documentos por caso sob concorrência real: OK"
