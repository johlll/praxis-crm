/**
 * @vitest-environment node
 *
 * B6c/C5a.1 — backup criptografado do bucket `proposal-documents` (Supabase Storage).
 *
 * Aqui, as garantias ESTÁTICAS (o comportamento com aws/jq/age reais, contra o Storage do Supabase local e
 * PDFs sintéticos, está em scripts/backup/check-storage-backup.sh, que o CI roda):
 *  - o backup só LÊ do S3 (ListObjectsV2, HeadObject, GetObject) e só aceita o bucket proposal-documents;
 *  - endpoint, chave e segredo só por variável de ambiente, nunca por argumento, e sem xtrace;
 *  - a restauração recusa destino hospedado/Production antes de descriptografar, valida o checksum antes e
 *    exige o bucket vazio;
 *  - o workflow-modelo faz o backup do banco e o do Storage na mesma rodada, falha se um falhar e envia só
 *    os quatro arquivos criptografados;
 *  - nenhuma chave de acesso ou segredo no repositório, e nenhum workflow público usa os secrets do Storage.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const ler = (caminho: string) => readFileSync(join(RAIZ, caminho), "utf8").split("\r").join("");
const MODELO = "docs/backup/modelo-repositorio-privado/.github/workflows/backup-diario.yml";
const LIB = ler("scripts/backup/lib-storage.sh");
const BACKUP = ler("scripts/backup/backup-storage.sh");
const RESTORE = ler("scripts/backup/restore-storage.sh");
const CHECK = ler("scripts/backup/check-storage-backup.sh");
const workflow = ler(MODELO);

/** Operações do aws (`s3api <operação>`) citadas num texto. */
const operacoes = (texto: string) => [...new Set([...texto.matchAll(/s3api ([a-z0-9-]+)/g)].map((m) => m[1]))].sort();

describe("formato praxis-storage-backup/v1", () => {
  it("o formato e o único bucket aceito estão fixos na biblioteca", () => {
    expect(LIB).toContain('PRAXIS_STORAGE_FORMAT="praxis-storage-backup/v1"');
    expect(LIB).toContain('PRAXIS_STORAGE_BUCKET="proposal-documents"');
    expect(LIB).toContain('storage_bucket_ok() { [ "$1" = "$PRAXIS_STORAGE_BUCKET" ]; }');
  });

  it("o manifesto tem versão, data UTC, bucket, quantidade, total de bytes, caminho/tamanho/SHA-256 e ferramentas", () => {
    for (const campo of ["format:", "created_at_utc:", "bucket:", "object_count:", "total_bytes:", "tools:", "aws_cli:", "objects:"]) {
      expect(BACKUP, campo).toContain(campo);
    }
    expect(BACKUP).toContain("{id: $id, key: $key, size: $size, sha256: $sha, content_type: $ct}");
  });

  it("o pacote é manifest.json + objects/<número>, sem recompactar objetos; a saída é só .age e .sha256", () => {
    expect(BACKUP).toContain("tar -C \"$PKG\" -czf \"$WORK/pacote.tar.gz\" manifest.json objects");
    expect(BACKUP).toContain('NAME="praxis-storage-backup-${STAMP}.tar.gz.age"');
    expect(BACKUP).toContain('OUT_FILES=("$OUT/$NAME" "$OUT/$NAME.sha256")');
    expect(BACKUP).not.toMatch(/gzip [^\n]*objects|--gzip|xz|zstd/);
  });
});

describe("backup: só leitura, só o bucket proposal-documents", () => {
  it("usa SÓ ListObjectsV2, HeadObject e GetObject", () => {
    expect([...new Set([...operacoes(BACKUP), ...operacoes(LIB)])]).toEqual(["get-object", "head-object", "list-objects-v2"]);
    expect(BACKUP + LIB).not.toMatch(/put-object|delete-object|delete-objects|copy-object|create-bucket|delete-bucket|multipart|upload-part|\baws s3 (cp|mv|rm|sync)\b/);
  });

  it("recusa bucket diferente antes de qualquer chamada e valida o tamanho da página", () => {
    expect(BACKUP).toContain('storage_bucket_ok "$BUCKET" || die "bucket_recusado" 64');
    expect(BACKUP.indexOf('die "bucket_recusado"')).toBeLessThan(BACKUP.indexOf("s3_prepare_env"));
    expect(BACKUP).toContain('die "tamanho_pagina_invalido" 64');
  });

  it("lista com paginação, baixa cada objeto uma vez e lista de novo no fim (conjunto consistente)", () => {
    expect(LIB).toContain("--continuation-token");
    expect(LIB).toContain("--no-paginate");
    expect(BACKUP.match(/s3api get-object/g)).toHaveLength(1);
    expect(BACKUP.match(/s3_list_all "\$LIST[12]"/g)).toHaveLength(2);
    expect(BACKUP).toContain('cmp -s "$LIST1" "$LIST2" || die "conjunto_alterado" 70');
    expect(BACKUP).toContain('die "objeto_alterado" 70');
    expect(BACKUP).toContain('die "tamanho_divergente" 70');
    expect(BACKUP).toContain('die "hash_divergente" 70');
  });

  it("endpoint, região, chave e segredo só por ambiente; nada vira argumento; originais apagados", () => {
    for (const v of ["BACKUP_STORAGE_S3_ENDPOINT", "BACKUP_STORAGE_S3_REGION", "BACKUP_STORAGE_S3_ACCESS_KEY_ID", "BACKUP_STORAGE_S3_SECRET_ACCESS_KEY"]) {
      expect(BACKUP, v).toContain(`\${${v}:-}`);
    }
    expect(BACKUP).toContain("unset BACKUP_STORAGE_S3_ENDPOINT BACKUP_STORAGE_S3_REGION BACKUP_STORAGE_S3_ACCESS_KEY_ID BACKUP_STORAGE_S3_SECRET_ACCESS_KEY");
    expect(BACKUP + LIB + RESTORE).not.toMatch(/--endpoint-url|--access-key|--secret|--profile/);
    expect(LIB).toContain('export AWS_ENDPOINT_URL="$1"');
    expect(LIB).toContain("AWS_CONFIG_FILE=/dev/null");
  });

  it("nenhum script usa xtrace, nem imprime segredo, endpoint ou a saída das ferramentas", () => {
    for (const [nome, fonte] of [["lib", LIB], ["backup", BACKUP], ["restore", RESTORE], ["check", CHECK]] as const) {
      expect(fonte, nome).not.toMatch(/set\s+-[a-z]*x|xtrace|PS4=/);
    }
    for (const fonte of [LIB, BACKUP, RESTORE]) {
      expect(fonte).not.toMatch(/(echo|printf)[^\n]*(S3_SECRET|SECRET_ACCESS_KEY|ACCESS_KEY_ID|S3_ENDPOINT|AWS_SECRET)/);
      expect(fonte).not.toMatch(/cat "\$ERR"|<"\$ERR"|\$\(cat "\$ERR/);
    }
    expect(BACKUP.match(/2>"\$ERR"/g)!.length).toBeGreaterThanOrEqual(8);
  });

  it("só chave pública no backup; limpeza do texto claro mesmo em falha", () => {
    expect(BACKUP).toContain('--recipient "$RECIPIENT"');
    expect(BACKUP).not.toMatch(/--identity|age -d|--decrypt|AGE-SECRET/);
    expect(BACKUP).toMatch(/\[\[ "\$BACKUP_AGE_PUBLIC_KEY" =~ \^age1/);
    expect(BACKUP).toContain("trap cleanup EXIT");
    expect(BACKUP).toContain('rm -rf "$WORK"');
    expect(BACKUP).toContain('rm -f "${OUT_FILES[@]}"');
    expect(BACKUP).toContain('rm -rf "$PKG" "$WORK/pacote.tar.gz"');
  });

  it("aceita bucket vazio: o pacote nasce com manifesto e a pasta objects/ vazia", () => {
    expect(BACKUP).toContain('mkdir -p "$PKG/objects"');
    expect(BACKUP).toContain("--slurpfile objs");
    expect(BACKUP).toContain("add // 0");
  });
});

describe("restauração: só destino local ou descartável, checksum antes, bucket vazio", () => {
  it("recusa destino hospedado/Production/não local ANTES de baixar, descriptografar ou chamar o S3", () => {
    const decrypt = RESTORE.indexOf("age --decrypt");
    for (const codigo of ["destino_recusado:hospedado", "destino_recusado:production", "destino_recusado:nao_local"]) {
      expect(RESTORE, codigo).toContain(codigo);
      expect(RESTORE.indexOf(codigo), codigo).toBeLessThan(decrypt);
    }
    expect(RESTORE).toMatch(/\*supabase\*\|\*pooler\*/);
    expect(RESTORE).toContain("RESTORE_ALLOW_DISPOSABLE_REMOTE");
    expect(RESTORE.indexOf("destino_recusado:hospedado")).toBeLessThan(RESTORE.indexOf("s3_prepare_env"));
  });

  it("valida o SHA-256 antes de descriptografar; a chave privada vem por caminho local", () => {
    expect(RESTORE.indexOf('die "checksum_invalido" 65')).toBeLessThan(RESTORE.indexOf("age --decrypt"));
    expect(RESTORE).toContain("--identity) IDENTITY=");
    expect(RESTORE).toContain('[ -n "$IDENTITY" ] || die "chave_privada_ausente" 64');
  });

  it("confere lista fechada de itens, formato, bucket, quantidade, bytes e hash de cada objeto antes de escrever", () => {
    expect(RESTORE).toContain("pacote_conteudo_inesperado");
    expect(RESTORE.indexOf("pacote_conteudo_inesperado")).toBeLessThan(RESTORE.indexOf("tar -xzf"));
    for (const codigo of ["manifesto_invalido", "manifesto_tamanho_divergente", "manifesto_hash_divergente"]) {
      expect(RESTORE.indexOf(codigo), codigo).toBeGreaterThan(-1);
      expect(RESTORE.indexOf(codigo), codigo).toBeLessThan(RESTORE.indexOf("put-object"));
    }
  });

  it("exige o bucket de destino vazio antes do primeiro PutObject e confere o destino depois", () => {
    expect(RESTORE.indexOf("bucket_destino_nao_vazio")).toBeLessThan(RESTORE.indexOf("put-object"));
    for (const codigo of ["validacao_quantidade", "validacao_bytes", "validacao_hash"]) expect(RESTORE, codigo).toContain(codigo);
    expect(RESTORE).toContain("storage_restauracao_validada: objetos=%s bytes=%s");
  });

  it("PutObject existe SÓ na restauração; nada de exclusão", () => {
    expect(RESTORE).toContain("put-object");
    expect(BACKUP + LIB).not.toContain("put-object");
    expect(RESTORE + BACKUP + LIB).not.toMatch(/delete-object|delete-bucket|create-bucket/);
    expect(RESTORE).toContain("trap cleanup EXIT");
    expect(RESTORE).toContain('rm -rf "$WORK"');
  });
});

describe("20. workflow-modelo: banco e Storage na mesma rodada, só os quatro arquivos criptografados", () => {
  it("roda os dois backups, o do Storage depois do banco, sem continue-on-error", () => {
    const iDb = workflow.indexOf("run: bash scripts/backup/backup-db.sh");
    const iSt = workflow.indexOf("run: bash scripts/backup/backup-storage.sh");
    expect(iDb).toBeGreaterThan(-1);
    expect(iSt).toBeGreaterThan(iDb);
    expect(workflow).not.toMatch(/continue-on-error|\|\| true|if: always\(\)|if: failure\(\)/);
    expect(workflow.indexOf("uses: actions/upload-artifact@")).toBeGreaterThan(iSt);
  });

  it("confere as duas saídas (2 arquivos cada, checksum válido) antes de enviar", () => {
    expect(workflow.match(/test "\$\(ls -1 \| wc -l\)" -eq 2/g)).toHaveLength(2);
    expect(workflow).toContain("cd storage-out");
    expect(workflow.match(/sha256sum --check --status \.\/\*\.tar\.gz\.age\.sha256/g)).toHaveLength(2);
  });

  it("um único upload com exatamente os quatro padrões criptografados, retenção de 30 dias", () => {
    expect(workflow.match(/upload-artifact/g)).toHaveLength(1);
    const bloco = workflow.slice(workflow.indexOf("uses: actions/upload-artifact@"));
    const caminhos = [...bloco.matchAll(/^\s+((?:backup|storage)-out\/\S+)$/gm)].map((m) => m[1]);
    expect(caminhos).toEqual(["backup-out/*.tar.gz.age", "backup-out/*.tar.gz.age.sha256", "storage-out/*.tar.gz.age", "storage-out/*.tar.gz.age.sha256"]);
    expect(bloco).toContain("retention-days: 30");
    expect(bloco).toContain("if-no-files-found: error");
    expect(bloco).not.toMatch(/\.json|\.sql|\.pdf|\*\*|path: \./);
  });

  it("mantém cron, workflow_dispatch, concorrência 1, timeout, permissões só de leitura e as Actions fixadas", () => {
    expect(workflow).toContain('cron: "30 7 * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toMatch(/concurrency:\n {2}group: praxis-backup\n {2}cancel-in-progress: false/);
    expect(workflow).toContain("timeout-minutes: 30");
    expect(workflow).toMatch(/permissions:\n {2}contents: read\n/);
    expect(workflow).not.toMatch(/: write\b/);
    expect(workflow).toContain("actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0");
    expect(workflow).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2");
    expect(workflow).toContain("if: ${{ github.repository != 'johlll/praxis-crm' }}");
  });

  it("os secrets do Storage entram só no passo do backup do Storage", () => {
    const inicio = workflow.indexOf("name: Gerar o backup criptografado do Storage");
    const fim = workflow.indexOf("name: Conferir a saída do Storage");
    const passo = workflow.slice(inicio, fim);
    for (const v of ["ENDPOINT", "REGION", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"]) expect(passo).toContain(`secrets.BACKUP_STORAGE_S3_${v}`);
    expect(workflow.replace(passo, "")).not.toMatch(/secrets\.BACKUP_STORAGE_S3_/);
  });
});

describe("o teste real roda no CI contra o Supabase LOCAL", () => {
  const ci = ler(".github/workflows/ci.yml");
  it("o passo usa o endpoint S3 e as chaves do `supabase status`, nunca um destino hospedado", () => {
    const i = ci.indexOf("Backup criptografado e restauração do Storage (C5a.1");
    expect(i).toBeGreaterThan(-1);
    const passo = ci.slice(i, ci.indexOf("- name: Atualização a partir da versão anterior (numeração de propostas)"));
    expect(passo).toContain("supabase status -o env");
    expect(passo).toContain("bash scripts/backup/check-storage-backup.sh");
    expect(passo).not.toMatch(/supabase\.co|secrets\.|amazonaws/);
  });

  it("o teste real recusa qualquer endpoint que não seja local e cobre os 18 cenários de comportamento", () => {
    expect(CHECK).toContain('die "teste_so_contra_destino_local" 77');
    for (let n = 1; n <= 17; n++) expect(CHECK, `cenário ${n}`).toMatch(new RegExp(`echo "== ${n}\\.`));
    expect(CHECK).toContain("18. restauração local fiel");
  });
});

describe("21. nenhuma credencial no repositório e nenhum workflow público usa os secrets do Storage", () => {
  const dir = join(RAIZ, ".github/workflows");
  it("workflows públicos não citam os secrets nem o formato de backup", () => {
    for (const nome of readdirSync(dir)) {
      const texto = ler(`.github/workflows/${nome}`);
      expect(texto, nome).not.toMatch(/BACKUP_STORAGE_S3|secrets\.BACKUP/);
      expect(texto, nome).not.toContain("praxis-backup");
    }
  });

  function rastreados(): string[] {
    const saida = execFileSync("git", ["ls-files", "-z"], { cwd: RAIZ, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return saida.split("\0").filter(Boolean);
  }

  it("nenhum arquivo rastreado tem chave de acesso AWS/S3 ou chave privada age", () => {
    const padroes = [new RegExp("AKIA" + "[0-9A-Z]{16}"), new RegExp("AGE-SECRET" + "-KEY-1[0-9A-Z]{58}"), new RegExp("aws_secret_access_key\\s*=\\s*[A-Za-z0-9/+]{30,}", "i")];
    const suspeitos: string[] = [];
    for (const arquivo of rastreados()) {
      const completo = join(RAIZ, arquivo);
      if (!existsSync(completo) || !statSync(completo).isFile() || statSync(completo).size > 2_000_000) continue;
      if (/\.(png|jpe?g|webp|gif|ico|pdf|woff2?|ttf|otf|zip|gz)$/i.test(arquivo)) continue;
      const conteudo = readFileSync(completo, "latin1");
      if (padroes.some((p) => p.test(conteudo))) suspeitos.push(arquivo);
    }
    expect(suspeitos).toEqual([]);
  });

  it("os scripts e o modelo não carregam valores de credencial: só nomes de variáveis", () => {
    for (const fonte of [LIB, BACKUP, RESTORE, workflow]) {
      expect(fonte).not.toMatch(/(SECRET_ACCESS_KEY|ACCESS_KEY_ID)\s*=\s*["']?[A-Za-z0-9/+]{16,}/);
    }
  });
});
