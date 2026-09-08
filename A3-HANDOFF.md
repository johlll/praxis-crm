# A3 — Handoff: contatos, identidade e deduplicação

**Projeto:** Praxis CRM Jurídico
**Fase:** A3
**Branch:** `feat/a3-contacts-dedup`
**PR:** https://github.com/johlll/praxis-crm/pull/3 — **aberto, CI verde, não mesclado**
**Preview:** https://praxis-crm-git-feat-a3-contacts-dedup-johllls-projects.vercel.app
**Data:** 08/09/2026

**Status:** implementada por completo, **CI totalmente verde** (typecheck,
lint, 105 testes unitários, migrations do zero, tipos gerados batendo,
pgTAP — RLS/grants exatos + isolamento + dedup + merge/undo —, build e os
8 e2e da A2 continuando verdes). **Validação funcional no preview ainda
pendente** — bloqueada por uma variável de ambiente que só o usuário pode
gerar (seção 5).

---

## 1. O que foi implementado

### 1.1 Banco de dados

9 tabelas novas em 8 migrations (`supabase/migrations/2026090805*.sql`):
`contacts`, `contact_phones`, `contact_emails`, `contact_identifiers`,
`contact_sensitive`, `contact_consents`, `duplicate_candidates`,
`contact_merges`, `sensitive_data_access`. RLS habilitada **e forçada** em
todas, policy separada por operação, `contact_sensitive` sem NENHUMA
policy de SELECT (nem para o próprio dono — só via função). GRANT mínimo
por fluxo implementado desde a primeira migration da fase (lição da A2
aplicada desde o início, não depois de um bug — ver seção 4).

14 funções `SECURITY DEFINER`: `create_contact`, `update_contact_basic_fields`,
`add/update/remove_contact_phone`, `add/update/remove_contact_email`,
`set/clear_contact_cpf_cnpj`, `search_contacts_by_cpf_cnpj`,
`contact_has_sensitive`, `reveal_contact_cpf_cnpj`,
`dismiss_duplicate_candidate`, `merge_contacts`, `unmerge_contact`, mais o
helper interno `private.detect_duplicate_candidates_for()`.

### 1.2 Cifra de CPF/CNPJ

AES-256-GCM (IV de 12 bytes, tag de 16, formato `iv‖tag‖ciphertext` numa
`bytea`) + blind index HMAC-SHA256 **contextualizado por workspace**
(`HMAC(chave, workspace_id || ':' || cpf_normalizado)` — sem isso, o mesmo
CPF em dois escritórios teria o mesmo índice, permitindo correlação entre
tenants). As duas chaves vivem só em `src/server/crypto/contact-sensitive.ts`
(Node, nunca SQL/pgcrypto), lidas de `CONTACTS_ACTIVE_KEY_VERSION`/
`CONTACTS_KEY_VERSIONS` (validadas em `src/server/env.ts`). Versionamento
por linha (`key_version`), rotação documentada, script gerador
(`scripts/generate-contact-keys.mjs`) que nunca roda comigo vendo o
resultado. Decisão completa: `docs/decisoes/a3-criptografia.md`.

### 1.3 Deduplicação

Determinística, sem ML: CPF igual → `strong`; telefone ou e-mail igual →
`review`; nome parecido (`pg_trgm`, limiar 0.6) **e** cidade/UF iguais →
`low`; nome parecido sozinho não gera candidato. `priority` só ordena a
fila, nunca é apresentado como probabilidade. Detecção roda no fim de
`create_contact`/`update_contact_basic_fields`/add-remove-update de
telefone-e-mail-CPF (não é trigger — evita rodar em estado parcial).
Decisão completa: `docs/decisoes/a3-duplicidades.md`.

### 1.4 Mesclagem

`merge_contacts()`: sempre humana, nunca automática; nunca entre
workspaces; nunca com contato já mesclado; lock explícito (`for update`)
contra corrida. "Soft" — a linha do contato perdedor nunca é apagada, só
ganha `merged_into_contact_id`; telefones/e-mails/identificadores/
consentimentos são reparentados; `contact_sensitive` só é movido se o
vencedor ainda não tiver CPF. Snapshot mínimo em `contact_merges` (o que
mudou, quais linhas moveram, `updated_at` de cada uma no momento da
mesclagem) — nunca cópia integral de dado pessoal.

`unmerge_contact()`: recusa desfazer (a transação inteira aborta, nada
muda) se qualquer linha movida foi **editada ou apagada** depois da
mesclagem — nunca sobrescreve silenciosamente.

### 1.5 Interface

- `/contatos` — listagem paginada, busca (nome via `ilike`; termo com 11
  ou 14 dígitos vira busca exata por CPF/CNPJ via blind index), link para
  duplicidades com contador.
- `/contatos/novo` — cadastro (tipo, nome, cidade/UF, canal, um telefone,
  um e-mail, CPF opcional com checkbox — nunca incentivado).
- `/contatos/[id]` — edição dos dados básicos, telefones/e-mails (N,
  adicionar/editar/remover), CPF via `SensitiveField`.
- `/contatos/duplicidades` — fila de revisão, motivo por extenso (nunca
  score cru), descartar.
- `/contatos/duplicidades/[id]` — comparação lado a lado, escolha de qual
  contato mantém e resolução por campo conflitante, `SensitiveField` dos
  dois lados, mesclar.

`SensitiveField`: mascarado por padrão, revelação via Server Action própria
(nunca cacheada), motivo obrigatório só para o papel `sales` (checado no
servidor, não só na interface), nunca guarda o valor revelado — só
quem/quando/campo/motivo em `sensitive_data_access`.

"Contatos" foi adicionado à barra lateral (`src/components/app-shell/navigation.ts`)
como ampliação explícita de escopo — não existe no protótipo original,
aprovado pelo usuário para que a A3 seja testável/usável sem depender de
seed.

### 1.6 Permissões

Estendida a matriz de `src/lib/roles.ts`: `contact.view` (todos),
`contact.edit` (todos menos `viewer`), `contact.reveal_sensitive` (todos
menos `viewer`, `sales` com motivo obrigatório — checado na RPC),
`contact.merge` (`owner`/`admin`/`manager`).

---

## 2. Verificação nesta máquina (sem Docker)

| Comando | Resultado |
|---|---|
| `npm run typecheck` | sem erros |
| `npm run lint` | sem erros nem avisos |
| `npm test` | **105 testes**, todos passando (18 novos: normalização de telefone/e-mail, cifra/blind index/isolamento por workspace) |
| `npm run build` | com credenciais placeholder — 25 rotas, as 5 novas de `/contatos` entre elas |

## 3. Verificação no CI (Docker real)

**Verde na terceira rodada** — as duas primeiras pegaram bugs reais (não
hipotéticos, listados na seção 4). pgTAP: 129 asserções em 8 arquivos (os
4 novos: `05_a3_security_hardening` — RLS/grants exatos, search_path,
EXECUTE; `06_a3_contacts_isolation` — isolamento entre workspaces, busca
por CPF, revelação auditada; `07_a3_duplicates` — as regras de
`a3-duplicidades.md`; `08_a3_merge` — merge/undo/conflito). Isolamento,
build e os 8 e2e da A2 continuam verdes.

---

## 4. O que foi encontrado e corrigido

Testei a lógica de negócio (dedup, merge, undo, conflito) diretamente
contra o Postgres hospedado (`praxis-crm-dev`, sem Docker nesta máquina)
**antes** de escrever os arquivos pgTAP finais — não por precaução
genérica, mas porque a A2 já tinha ensinado que "parece certo lendo o SQL"
não é evidência. Achou 3 bugs reais nesta fase, mais 1 na primeira rodada
de CI, mais 1 escrevendo teste unitário:

1. **Parâmetros de função sem `default null` geravam tipo TypeScript
   obrigatório e não-nulável.** `p_city`/`p_uf`/`p_preferred_channel` em
   `create_contact()`/`update_contact_basic_fields()` não tinham
   `default` — o Postgres não expõe nulidade de parâmetro de função do
   jeito que expõe nulidade de coluna, então `supabase gen types` os
   marcava como `string` obrigatório. UF e canal preferido não têm um
   "vazio" válido (CHECK exige 2 letras OU NULL; enum não tem opção
   "nenhum") — corrigido com `CREATE OR REPLACE FUNCTION` adicionando
   `default null` aos três.
2. **Só existia adicionar/remover telefone e e-mail, faltava editar.**
   "Edição dos dados básicos" pedida pelo usuário inclui corrigir um
   telefone digitado errado sem perder `verified_at`/`source` só porque
   removeu e recriou. Adicionadas `update_contact_phone()`/
   `update_contact_email()`.
3. **`unmerge_contact()` não detectava linha movida que foi APAGADA
   depois da mesclagem** (só editada) — o UPDATE de reparentação
   simplesmente não afetava linha nenhuma, "desfazendo" sem avisar que
   aquele telefone/e-mail específico não voltou. Corrigido tratando
   ausência da linha como conflito também, com `CREATE OR REPLACE`.
4. **CI, 1ª rodada:** o mesmo achado 21/22 da A2, mas ao contrário. A2
   só tinha revogado REFERENCES/TRIGGER/TRUNCATE/MAINTAIN do
   `DEFAULT PRIVILEGES` do papel `postgres` — bastava lá porque o
   problema era GRANT faltando no hospedado. O Postgres LOCAL do CI
   concede SELECT/INSERT/UPDATE/DELETE por padrão a `anon`/`authenticated`
   em toda tabela nova, e nenhuma das 9 tabelas desta fase tinha isso
   revogado (a A2 nunca precisou pensar nisso, só em adicionar).
   `authenticated` chegou com INSERT/UPDATE/DELETE de brinde nas 4
   tabelas com SELECT, e CRUD completo nas 5 que não deviam ter grant
   nenhum. Corrigido revogando tudo e regranting só o necessário nas 9
   tabelas, e — mais importante — estendendo o `DEFAULT PRIVILEGES` para
   cobrir os quatro privilégios que faltavam, não só os quatro de antes.
   Toda tabela de fase futura já nasce sem nada, em qualquer ambiente.
5. **CI, 1ª e 2ª rodadas: pontos do próprio teste rodando como
   `authenticated` sem `reset role`.** `memberships`/`audit_logs`/
   `contact_merges`/`sensitive_data_access` não têm GRANT para
   `authenticated` (correto, por design) — várias leituras de
   *verificação* dos testes pgTAP (não o fluxo real da aplicação, que usa
   RPC) tentavam ler essas tabelas direto enquanto o teste já tinha
   trocado para o papel `authenticated`. Corrigido intercalando
   `reset role`/`set local role authenticated` ao redor de cada leitura
   de verificação — mesmo padrão já usado nos testes da A2.
6. **`normalizePhoneBR` colava `+55` num número americano de 11
   dígitos.** Achado escrevendo o teste unitário para `"+1 415 555 0100"`,
   não por inspeção do código: DDI+número americano (11 dígitos) é
   indistinguível de DDD+celular brasileiro (11 dígitos também) só pela
   contagem de dígitos. Corrigido usando o `+` explícito que a pessoa
   digitou como o único sinal confiável de que os dígitos já incluem um
   DDI.

---

## 5. Pendência — bloqueia a validação funcional

**`CONTACTS_ACTIVE_KEY_VERSION`/`CONTACTS_KEY_VERSIONS` não estão
configuradas no ambiente Preview da Vercel.** Confirmado ao abrir o
preview: toda página retorna 500, log da função mostra exatamente
`Variáveis de ambiente inválidas ou ausentes: CONTACTS_ACTIVE_KEY_VERSION,
CONTACTS_KEY_VERSIONS` (`getEnv()`, `src/server/env.ts`).

**Por que não gerei isso eu mesmo:** decisão explícita registrada em
`docs/decisoes/a3-criptografia.md` — as chaves são geradas por
`node scripts/generate-contact-keys.mjs`, rodado só pelo usuário, e nem a
chave nem o valor gerado devem aparecer nesta conversa.

**Ação necessária:**
1. Rodar `node scripts/generate-contact-keys.mjs` localmente.
2. Adicionar as duas variáveis (`CONTACTS_ACTIVE_KEY_VERSION`,
   `CONTACTS_KEY_VERSIONS`) ao ambiente **Preview** do projeto `praxis-crm`
   na Vercel — mesmo lugar/mecanismo de `WORKSPACE_ACTIVE_COOKIE_SECRET`
   na A2.
3. Isso não afeta o `praxis-crm-dev` (banco) nem migration nenhuma — é só
   variável de runtime da aplicação.

Depois disso, retomo a validação funcional pedida: criar contato com/sem
CPF, revelar CPF (com e sem motivo conforme papel), detectar e mesclar
duplicidade, desfazer mesclagem — e fecho este handoff com o resultado.

---

## 6. Confirmações explícitas

- **Nenhuma fase além da A3 foi iniciada.** Sem pipeline, Perfil 360,
  atividades, WhatsApp ou IA.
- **Nenhum arquivo de referência visual foi alterado.**
- **Sem merge em `main`.** Tudo na branch `feat/a3-contacts-dedup`, PR
  aberto, aguardando aprovação explícita para mesclar.
- **`praxis-crm-dev`:** só migrations aditivas aplicadas (dry-run
  conferido antes de cada uma), sem reset, sem remoção de dado existente,
  sem enfraquecer proteção nenhuma — RLS/FORCE conferidas depois de cada
  migration.
- **Nenhum CPF real em lugar nenhum** — seed usa CPF fictício
  (`222.222.222-22`), cifrado com chave de teste fixa e documentada,
  nunca usada em ambiente real.
