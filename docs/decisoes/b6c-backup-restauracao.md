# B6c — backup lógico criptografado e restauração testável (plano Free, sem custo)

Estado (atualizado em 13/11/2026): **backup criptografado ATIVADO.** O repositório privado de backups existe, os
dois secrets estão cadastrados, o agendamento diário está ligado, o primeiro backup e a **restauração local real**
foram aprovados. **Ainda pendente:** a **primeira execução natural** (disparada pelo próprio agendamento, sem
ninguém clicar) **não foi comprovada** — veja "Registro e pendências" abaixo.

## O que existe e por quê

- O plano **Free** do Supabase **não tem backup automático nem PITR**. Sem isto, perder o banco é perder tudo.
- Solução gratuita: um **backup lógico diário, criptografado**, gerado pelo GitHub Actions de um
  **repositório privado separado** e guardado como artefato por **30 dias**. **RPO máximo ≈ 24 horas.**
- A **restauração é manual** e foi provada por teste (`scripts/backup/check-backup-restore.sh`, rodado no CI
  contra um Postgres local sintético): o banco restaurado tem o mesmo conteúdo, constraints e FKs.

## Formato (`praxis-backup/v2`)

`praxis-crm-backup-<UTC>.tar.gz.age` + `praxis-crm-backup-<UTC>.tar.gz.age.sha256` (SHA-256 do arquivo **já
criptografado**). Dentro do `.tar.gz` (criptografado com `age`, só chave **pública**):
`manifest.json` (data UTC, versão do formato, `"snapshot": "single-repeatable-read"`, versões do PostgreSQL,
hash de cada arquivo, contagens esperadas) e 5 SQL: schema e dados de `auth.users`/`auth.identities` e dos
schemas `public`, `private` e `supabase_migrations`. Gerado com `pg_dump` 17 (sem `set -x`; URL só por variável
de ambiente, desmontada em variáveis `PG*`; nada de URL, senha, SQL ou dado em log; texto claro apagado mesmo se
falhar). A restauração só aceita `v2` com o snapshot declarado.

### Um único instante (snapshot) do banco

Tudo o que entra no pacote — os 4 dumps, as contagens de estrutura (tabelas, constraints, RLS, políticas,
gatilhos, funções) e a conferência de linhas do manifesto — vem do **mesmo snapshot**. Mecanismo: uma sessão
auxiliar abre uma transação `REPEATABLE READ, READ ONLY`, exporta o snapshot (`pg_export_snapshot()`) e **a
mantém aberta**; cada `pg_dump` roda com `--snapshot=<id>` e as consultas de catálogo/contagem rodam dentro dessa
mesma transação. Depois dos dumps, as linhas de cada tabela nos dumps são **conferidas com a contagem tirada
dentro do snapshot** (`snapshot_inconsistente` se divergir). Se a sessão cair, o backup falha fechado
(`snapshot_falhou`). Nenhuma escrita é bloqueada e a produção não é pausada (a transação só lê; o `pg_dump` toma
apenas `ACCESS SHARE`, que não conflita com INSERT/UPDATE/DELETE). Foi provado com escritas confirmadas **entre**
as etapas de um backup real (`scripts/backup/check-backup-snapshot.sh`, rodado no CI): o pacote restaurado é
idêntico ao estado de antes do backup, e a versão anterior (4 `pg_dump` independentes) falhava nesse mesmo teste.

**Não inclui:** objetos do **Supabase Storage** (e a configuração dos buckets) — se forem usados, exigem rotina
própria; sessões/tokens/configuração do Auth além de usuários e identidades; variáveis da Vercel/Inngest.
**O Storage está em uso:** o bucket `proposal-documents` guarda os PDFs das propostas (B1). Os dados da proposta e
os metadados dos documentos voltam com o banco, mas os **arquivos PDF não voltam**; uma proposta já decidida
(aceita ou recusada) nem aceita PDF novo, então o arquivo enviado não pode ser refeito. **Os PDFs não estão
protegidos pelo backup atual. Isso é uma pendência obrigatória antes do uso real com documentos importantes**, não
uma melhoria opcional: será necessária uma **rotina separada e gratuita** para o Storage. Ela **não está
implementada** e não faz parte desta entrega; fica para uma tarefa técnica separada.

## A chave privada (a parte que não pode falhar)

- O par `age` foi gerado por **João**, na máquina dele (`age-keygen`), em 13/11/2026.
- A **chave privada fica só com João, fora do GitHub**: um arquivo protegido no computador dele **e** uma segunda
  cópia guardada fora do computador (confirmada por ele). Nunca vai para repositório, secret, chat ou e-mail.
  Só a **pública** (`age1...`) está no repositório privado de backups.
- **Perdeu a chave privada = todos os backups ficam inutilizáveis.** Não há recuperação.

## Como foi ativado (13/11/2026)

1. Repositório **privado** `johlll/praxis-crm-backups` (privado desde a criação, sem Pages, sem fork, sem
   colaboradores). Recebeu uma cópia exata de `docs/backup/modelo-repositorio-privado/.github/workflows/backup-diario.yml`
   (em `.github/workflows/`) e da pasta `scripts/backup/` (o modelo não roda neste repositório público). Única
   diferença desde então: **um comentário YAML** ao lado do `cron`, sem efeito sobre o comportamento.
   As duas Actions do modelo (`actions/checkout` v5.1.0 e `actions/upload-artifact` v4.6.2) estão **fixadas por
   SHA completo** do commit oficial; atualizar só trocando o SHA e a versão no comentário, com teste.
2. Secrets do repositório privado (só os dois nomes existem): `BACKUP_DATABASE_URL` (conexão **Session pooler**,
   porta 5432, com SSL — o endereço direto do Free é só IPv6; o modo *transaction* (6543) não serve, porque o
   snapshot exportado exige sessões inteiras) e `BACKUP_AGE_PUBLIC_KEY`. Quem cadastrou a URL foi João, pelo
   prompt oculto do `gh secret set`; a senha do banco não foi redefinida nem passou por chat, log ou arquivo.
3. Um backup manual (`workflow_dispatch`) e uma **restauração local real** antes de confiar no agendamento.
4. Agendamento: **todo dia às 07:30 UTC** (04:30 em Brasília), depois do lote de retenção da C3b (06:17 UTC).
   Concorrência 1 (nunca dois ao mesmo tempo), **retenção do artefato: 30 dias**.

## Registro e pendências

| Quando (UTC) | O que | Resultado |
|---|---|---|
| 13/11/2026 01:29 | 1º backup, **manual** (run 43345335631) | sucesso em 78 s; pacote `.tar.gz.age` de 595.550 bytes + checksum; logs sem URL, senha, chave, SQL ou dado pessoal |
| 13/11/2026, logo após o 1º backup | **Restauração local real** desse pacote (PostgreSQL 17 descartável, apagado ao fim) | `restauracao_validada`: 77 tabelas, 221 FKs, 635 constraints; ledger de migrations 117, última `20261113120000`; contagens de linhas por tabela **idênticas** às de Production |
| 13/11/2026 07:30 | **Primeira janela natural** | **não gerou execução** (causa não determinada) |
| 13/11/2026 12:38 | Backup **manual de proteção** (run 43426917896), depois de regravar o workflow com o comentário YAML para registrar de novo o agendamento | sucesso em 153 s; 595.535 bytes; checksum conferido; **não** restaurado |
| 14/11/2026 07:30 | **Próxima janela natural** — é a prova que falta | **aguardando comprovação** |

- A primeira execução natural **ainda não foi comprovada**. Até ser, não se deve tratar o agendamento como
  confiável; o RPO de ~24 h só vale enquanto houver um backup novo por dia.
- Os dois pacotes manuais ficaram guardados criptografados (com o checksum) no computador de João, fora de
  qualquer repositório.
- **Restauração em um projeto Supabase novo** (migrations primeiro, dados do pacote depois) **continua pendente**:
  entra junto da separação do Preview (B6d/C5b), que ainda não começou.
- O que **não** está no backup: Storage do Supabase, incluindo os **PDFs das propostas** (pendência obrigatória,
  ver acima). RPO ≈ **24 horas**: no pior caso, perde-se o que
  foi gravado desde o último backup.

## Restauração manual

Precisa de PostgreSQL **17** local (cliente e servidor), `age` e a chave privada em arquivo local:

```
RESTORE_DATABASE_URL=postgresql://postgres:...@127.0.0.1:5432/postgres \
  bash scripts/backup/restore-db.sh --package praxis-crm-backup-<UTC>.tar.gz.age --identity /caminho/chave-privada-praxis.txt
```

Valida o SHA-256 **antes** de descriptografar; descriptografa só em pasta temporária (apagada ao fim); cria um
banco **novo** `praxis_restore_<UTC>` e restaura; compara estrutura, linhas por tabela e FKs com o manifesto
(`restauracao_validada: ...`). **Recusa** qualquer destino com cara de projeto hospedado/Production (hosts
`*supabase*`, pooler, referência do projeto) e qualquer servidor não local, salvo
`RESTORE_ALLOW_DISPOSABLE_REMOTE=yes` num servidor descartável. A restauração **local** de um backup real foi
aprovada em 13/11/2026; a restauração real num **projeto Supabase novo** (migrations primeiro, dados do pacote
depois) **ainda precisa ser ensaiada** (fica para a separação do Preview) antes de depender dela.

## Verificação periódica obrigatória

Todo mês: baixar o artefato mais recente, restaurar com o script acima e conferir `restauracao_validada`.
Registrar a data. Um backup nunca restaurado não conta como backup. Conferir também que o artefato do dia existe
(falha do workflow aparece no GitHub) e acompanhar o tamanho do pacote e o uso de minutos/armazenamento do plano
gratuito do GitHub (o consumo real **não** foi confirmado por API; a estimativa é de cerca de 2 minutos por dia).

O agendamento do GitHub é de **melhor esforço**: pode atrasar ou descartar execuções sob carga e não avisa quando
isso acontece. Por isso a conferência diária do artefato (ver `docs/operacao/runbook-operacional.md`) é parte do
procedimento, não um extra.
