# A3 — Criptografia de dados sensíveis (CPF/CNPJ)

Decisão registrada **antes** de escrever o código de cifra, conforme pedido.
API verificada na documentação oficial do Node.js
(`https://nodejs.org/api/crypto.html#class-cipheriv`) antes de implementar —
não por memória.

## Algoritmos

- **Cifra:** AES-256-GCM (`crypto.createCipheriv('aes-256-gcm', key, iv)`).
  - Chave: 32 bytes (256 bits).
  - IV/nonce: 12 bytes (96 bits), **gerado aleatoriamente a cada operação**
    (`crypto.randomBytes(12)`) — nunca reaproveitado com a mesma chave, que é
    exatamente a forma de comprometer GCM.
  - Tag de autenticação: 16 bytes (padrão), obtida com `cipher.getAuthTag()`
    depois de `cipher.final()`, e verificada com `decipher.setAuthTag()`
    **antes** de `decipher.final()` — se a tag não bater, `final()` lança
    exceção (prova de que o ciphertext não foi adulterado).
  - Formato armazenado: `iv (12B) || authTag (16B) || ciphertext` — tudo em
    uma única coluna `bytea`, sem exigir colunas extras para reconstruir.
- **Blind index:** HMAC-SHA256 (`crypto.createHmac('sha256', key)`), chave
  **distinta** da chave de cifra — nunca a mesma, para que comprometer uma
  não comprometa a outra.

## Isolamento entre workspaces (blind index)

O HMAC do CPF/CNPJ **não é calculado só sobre o valor normalizado** — o
`workspace_id` entra na mensagem: `HMAC(chave, workspace_id || ':' ||
cpf_normalizado)`. Sem isso, o mesmo CPF em dois escritórios diferentes
produziria o mesmo blind index, permitindo a um escritório descobrir que um
CPF existe no outro (correlação entre tenants) só comparando índices — o
próprio objetivo de isolar dados por workspace seria furado por uma
coluna aparentemente "só um índice". Com o `workspace_id` na mensagem, o
mesmo CPF em workspaces diferentes gera blind indexes diferentes, sem
correlação possível.

## Versionamento e rotação

**Um único `key_version` por linha** (`contact_sensitive.key_version`),
amarrando o par cifra+HMAC usado naquela linha — não dois números
independentes. Motivo: o par nasce e é rotacionado junto; separar os dois
números só adicionaria um jeito extra de errar sem ganho real.

### Variáveis de ambiente (só servidor, nunca `NEXT_PUBLIC`)

```
CONTACTS_ACTIVE_KEY_VERSION=2
CONTACTS_KEY_VERSIONS={"1":{"cipher":"<base64 32B>","hmac":"<base64 32B>"},"2":{"cipher":"<base64 32B>","hmac":"<base64 32B>"}}
```

- `CONTACTS_ACTIVE_KEY_VERSION` — versão usada em **toda gravação nova**
  (cifrar, calcular blind index).
- `CONTACTS_KEY_VERSIONS` — mapa de todas as versões que o servidor ainda
  precisa **ler**. Uma versão só sai do mapa depois que nenhuma linha do
  banco referenciar mais `key_version` = essa versão (conferido antes de
  remover — ver rotação abaixo).
- Lidas e validadas uma vez em `src/server/env.ts` (mesmo padrão de
  `WORKSPACE_ACTIVE_COOKIE_SECRET`); nunca logadas, nunca em mensagem de
  erro.

### Geração dos segredos

`scripts/generate-contact-keys.mjs` — gera um par novo (`crypto.randomBytes(32)`
para cada chave, saída em base64) e imprime só no terminal de quem rodar,
para colar manualmente nas variáveis de ambiente do provedor (Vercel). Este
script **nunca é executado por mim** com uma chave real — nem a chave nem o
valor gerado aparecem nesta conversa. Rodar:

```bash
node scripts/generate-contact-keys.mjs
```

**Se as chaves forem perdidas, os dados cifrados ficam permanentemente
irrecuperáveis** — não há backdoor, não há chave mestra de recuperação. Um
backup separado e criptografado das variáveis de ambiente (fora do
repositório, fora da Vercel) é responsabilidade operacional de quem
administra o projeto — está fora do escopo de código desta fase.

### Procedimento de rotação

1. Rodar `scripts/generate-contact-keys.mjs` para gerar o par da nova versão
   (ex.: versão `2`).
2. Adicionar a nova versão ao `CONTACTS_KEY_VERSIONS` em todos os ambientes
   (Preview e Produção na Vercel) — **sem remover a versão anterior**, que
   continua necessária para ler linhas antigas.
3. Atualizar `CONTACTS_ACTIVE_KEY_VERSION` para a nova versão. Depois do
   deploy, toda gravação nova (contato novo ou CPF editado) já usa a versão
   nova.
4. **Reindexação** (as linhas antigas não mudam sozinhas): rodar
   `scripts/reindex-contact-sensitive.mjs --workspace-ref <ref-do-projeto>`
   — script administrativo, **não roda em CI, não roda automaticamente**.
   Para cada linha `contact_sensitive` com `key_version` menor que a ativa,
   decifra com a chave da versão antiga, recifra com a chave ativa e
   recalcula o blind index (com o `workspace_id` daquela linha), grava a
   nova `key_version`. Processa por lotes, com log de progresso (sem nunca
   logar o CPF em claro).
5. Depois que a reindexação confirmar zero linhas na versão antiga (`select
   count(*) from contact_sensitive where key_version = '<antiga>'` = 0),
   a entrada antiga pode ser removida de `CONTACTS_KEY_VERSIONS` com
   segurança.

Nenhuma infraestrutura externa de gestão de chaves (KMS, Vault) nesta fase —
combinado explicitamente. Se o volume de dados um dia justificar automação
da rotação, isso é decisão de fase futura, não desta.

## Chaves de teste (CI e seed local)

O Postgres local do CI (`supabase start`) roda `supabase/seed.sql`, que
inclui contatos fictícios com CPF **já cifrado** (não em claro) — cifrado
com uma chave de teste fixa, gerada uma vez com o mesmo script acima,
**exclusiva para teste, documentada como tal, nunca usada em nenhum
ambiente real**. Essa chave de teste é declarada em texto puro dentro de
`.github/workflows/ci.yml` (variável `CONTACTS_KEY_VERSIONS`/
`CONTACTS_ACTIVE_KEY_VERSION` do step que escreve `.env.local`) — não é
segredo de verdade, é dado fictício, do mesmo jeito que a senha
`praxis-seed-nao-e-senha-real` do seed de usuários já é. O projeto hospedado
`praxis-crm-dev` **não recebe seed** (mesma decisão já tomada na A2) — só
migrations —, então nunca vê essa chave de teste; tem a sua própria, gerada
à parte pelo usuário, nunca compartilhada comigo.

## O que NÃO fica no `contact_sensitive`

Só `cpf_cnpj_ciphertext` (bytea), `cpf_cnpj_blind_index` (bytea, resultado
do HMAC) e `key_version`. Nunca o CPF em claro em nenhuma outra coluna,
tabela, log, mensagem de erro ou evento de auditoria — auditoria de
revelação (`sensitive_data_access`) registra quem/quando/por quê, nunca o
valor revelado.
