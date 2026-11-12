# B6c — backup lógico criptografado e restauração testável (plano Free, sem custo)

Estado: **scripts, modelo de workflow e runbook prontos neste repositório; nada ativado.** O repositório
privado de backups, os secrets e o primeiro backup real dependem de aprovação (ver "Ativação").

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

## A chave privada (a parte que não pode falhar)

- O par `age` é gerado por **João**, na máquina dele: `age-keygen -o chave-privada-praxis.txt`.
- A **chave privada fica só com João, fora do GitHub** (gerenciador de senhas **e** uma cópia offline). Nunca vai
  para repositório, secret, chat ou e-mail. Só a **pública** (`age1...`) vai para o repositório privado de backups.
- **Perdeu a chave privada = todos os backups ficam inutilizáveis.** Não há recuperação.

## Ativação (somente depois de aprovada)

1. Criar o repositório **privado** de backups; copiar `docs/backup/modelo-repositorio-privado/.github/workflows/backup-diario.yml`
   para `.github/workflows/` e a pasta `scripts/backup/` (o modelo não roda neste repositório público).
   As duas Actions do modelo (`actions/checkout` v5.1.0 e `actions/upload-artifact` v4.6.2) estão **fixadas por
   SHA completo** do commit oficial; atualizar só trocando o SHA e a versão no comentário, com teste.
2. Secrets do repositório privado: `BACKUP_DATABASE_URL` (conexão **Session pooler**, porta 5432, com SSL — o
   endereço direto do Free é só IPv6; o modo *transaction* (6543) não serve, porque o snapshot exportado exige
   sessões inteiras) e `BACKUP_AGE_PUBLIC_KEY`.
3. Rodar uma vez por "Run workflow", baixar o artefato e **restaurar localmente** antes de confiar no agendamento
   (07:30 UTC, depois do lote de retenção da C3b às 06:17 UTC).

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
`RESTORE_ALLOW_DISPOSABLE_REMOTE=yes` num servidor descartável. A restauração real num projeto novo (migrations
primeiro, dados do pacote depois) **ainda precisa ser ensaiada** antes de depender dela.

## Verificação periódica obrigatória

Todo mês: baixar o artefato mais recente, restaurar com o script acima e conferir `restauracao_validada`.
Registrar a data. Um backup nunca restaurado não conta como backup. Conferir também que o artefato do dia existe
(falha do workflow aparece no GitHub) e acompanhar o tamanho do pacote e o uso de minutos/armazenamento do plano
gratuito do GitHub.
