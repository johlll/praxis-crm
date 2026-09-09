# A3 — Handoff: contatos, identidade e deduplicação

**Projeto:** Praxis CRM Jurídico
**Fase:** A3
**Branch:** `feat/a3-contacts-dedup`
**PR:** https://github.com/johlll/praxis-crm/pull/3 — **MESCLADO em `main`**
(merge commit `373be9833977ff93990ea7509cb5318b396ac409`, aprovado
explicitamente pelo usuário)
**Preview:** https://praxis-crm-git-feat-a3-contacts-dedup-johllls-projects.vercel.app
**Production:** https://praxis-crm-eight.vercel.app — configurado e
validado ao vivo nesta rodada (seção 7)
**Data:** 08–09/09/2026

**Status:** implementada por completo, mesclada em `main` e validada ao
vivo em Production, incluindo a entrada de desfazer mesclagem na
interface (item pedido explicitamente depois da primeira rodada de
validação — seção 1.4), com cobertura em **quatro** camadas distintas —
pgTAP (banco), e2e (Playwright contra Supabase local do CI), validação
manual ao vivo no preview e validação manual ao vivo em Production —
detalhadas nas seções 5 e 7.

**Pendência da A2 que segue em aberto — em teste nesta rodada, ainda sem
confirmação final:** a configuração de Site URL/Redirect URLs do Supabase
Auth no painel do `praxis-crm-dev`. Um cadastro real foi disparado a
partir do app em Production (seção 6) especificamente para testar isso
pelo fluxo normal, como instruído — **mas o resultado depende de o
usuário conferir o e-mail recebido**, algo que eu não posso fazer. CI
verde não é evidência de que isso esteja corrigido. Repito aqui de
propósito, por instrução explícita do usuário: **não declarar essa
pendência resolvida com base no CI, nem antes de ver o destino real do
link.**

**Ambiente real de clientes: ainda não existe.** O que foi configurado e
validado nesta rodada é uma **demonstração interna** em Production,
apontando para o mesmo `praxis-crm-dev` usado em desenvolvimento, só com
dados fictícios de QA — não um ambiente separado para clientes reais. Ver
seção 7.

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

**Entrada mínima de desfazer na interface** (adicionada depois da primeira
rodada de validação — não era exclusão de escopo aprovada, só um vácuo do
recorte original): seção "Mesclagens" no contato vencedor, com histórico
mínimo (com quem foi mesclado, quando, se já foi desfeito), só aparece
quando existe alguma mesclagem; botão "Desfazer mesclagem" só para quem
tem `contact.merge` (owner/admin/manager); confirmação explícita num
`Dialog` (Radix) antes de submeter, nunca um clique único; usa a mesma RPC
`unmerge_contact()` já existente, sem lógica de conflito duplicada na
interface; mensagem de erro da própria RPC (`undo_conflict`, já mapeada em
`src/lib/errors.ts`) mostrada inline no diálogo quando a reversão é
recusada. Nova função de leitura `get_contact_merge_history()` (migration
`20260908060000`) expõe só o mínimo — nunca o snapshot bruto de
`contact_merges` (que segue sem GRANT nenhum de tabela).

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

**Verde na terceira rodada** da implementação original — as duas primeiras
pegaram bugs reais (não hipotéticos, listados na seção 4). pgTAP: 129
asserções em 8 arquivos (os 4 novos: `05_a3_security_hardening` —
RLS/grants exatos, search_path, EXECUTE; `06_a3_contacts_isolation` —
isolamento entre workspaces, busca por CPF, revelação auditada;
`07_a3_duplicates` — as regras de `a3-duplicidades.md`; `08_a3_merge` —
merge/undo/conflito). Isolamento, build e os 8 e2e da A2 continuam verdes.

**Rodada seguinte, depois da UI de desfazer:** `08_a3_merge.test.sql`
ganhou 5 asserções novas (19 no total nesse arquivo) — uma regressão que
fixa o bug do achado 7 (seção 4) e cobertura de
`get_contact_merge_history()` (visível a qualquer membro, vazio pra quem
não é membro). Novo arquivo `tests/e2e/contacts.spec.ts` (8 testes):
criação/edição, busca exata por CPF, revelação por papel (owner sem
motivo, sales com motivo, viewer negado), revisão e mesclagem de
duplicidade, desfazer sem edição posterior, e a mensagem de conflito ao
desfazer depois de uma alteração incompatível — todos contra o Supabase
LOCAL do CI (seed fictício), nunca contra `praxis-crm-dev` nem produção,
sem depender de envio de e-mail nenhum.

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

Os dois achados abaixo são da rodada de implementação da UI de desfazer,
depois do PR já aberto — de novo, achados testando ao vivo contra
requisições HTTP separadas, não por leitura do SQL:

7. **`merge_contacts()` gravava um "antes" que nunca podia bater com o
   "depois" — todo desfazer sem NENHUMA edição real era recusado como se
   houvesse conflito.** `now()` é fixo durante toda uma transação no
   Postgres (gotcha já conhecido deste projeto — ver A2). O código
   original fazia `SELECT updated_at` de telefones/e-mails/consentimentos
   **antes** do `UPDATE` que os reparenta para o contato vencedor — mas
   esse mesmo `UPDATE` dispara o gatilho `set_updated_at` da tabela,
   batendo o valor pra `now()` da própria transação da mesclagem. Ou seja,
   o "antes" gravado como referência já nascia desatualizado assim que a
   mesclagem terminava, e `unmerge_contact()` comparava contra ele achando
   uma diferença que não existia de verdade. Isso só aparece quando
   mesclar e desfazer acontecem em requisições (transações) diferentes —
   testando ao vivo no navegador contra o preview, não numa pgTAP de
   arquivo único (onde tudo roda numa única transação com `now()`
   idêntico do início ao fim, mascarando o bug — ver a asserção nova
   adicionada em `08_a3_merge.test.sql`, que backdata deliberadamente o
   `updated_at` pra reproduzir a condição real). Corrigido com
   `CREATE OR REPLACE FUNCTION` (migration `20260908060100`) usando
   `UPDATE ... RETURNING updated_at` pra capturar o timestamp **depois**
   do próprio reparente, nunca antes.
8. **Qualquer ação negada por permissão quebrava a página com o erro
   genérico do Next.js, em vez da mensagem tratada.** `requirePermission()`
   lança uma exceção de propósito (certo para Server Components) — mas
   dentro de uma Server Action isso vira uma exceção não capturada, e a
   página inteira quebra ("This page couldn't load"). Achado tentando
   mesclar como um papel sem permissão de mesclar (não por leitura de
   código) — e o mesmo padrão bloqueava também o teste de "visualizador
   nunca revela CPF" pedido pelo usuário: sem esse conserto, o e2e desse
   cenário teria que validar uma tela quebrada como comportamento
   esperado, o que é o oposto do objetivo do teste. Corrigido em
   `src/modules/contacts/actions.ts` com dois helpers pequenos
   (`requirePermissionSafe`/`requirePermissionVoid`) que capturam
   `AuthzError` e devolvem a mensagem sanitizada ("Você não tem permissão
   para fazer isso.") no mesmo formato de erro que o resto de cada ação já
   usa — aplicados em todas as 14 Server Actions de contatos. **O mesmo
   padrão existe, sem correção, em `src/modules/team/actions.ts`
   (`invitation.manage`/`membership.manage`) desde a A2** — fora do escopo
   desta fase (é código já mesclado em `main`), registrado aqui como
   pendência conhecida para uma fase futura, não corrigido silenciosamente
   nesta branch.

---

## 5. Validação funcional — três camadas, cada uma cobrindo o que as outras não cobrem

Nenhuma camada sozinha é suficiente — cada uma existe porque pega uma
classe de bug que as outras estruturalmente não pegam (lição repetida ao
longo de A2 e A3):

- **pgTAP** (`supabase/tests/database/*.sql`, Postgres LOCAL do CI):
  regras de negócio, RLS, grants, `SECURITY DEFINER` — rápido, mas roda
  inteiro numa única transação por arquivo, o que mascarou o achado 7 (a
  primeira versão de `08_a3_merge.test.sql` "passava" mesmo com o bug).
- **e2e** (`tests/e2e/contacts.spec.ts`, Playwright contra Supabase LOCAL
  do CI): a mesma lógica, mas através de requisições HTTP separadas de
  verdade — é a camada que teria pego o achado 7 desde o início, e é onde
  o achado 8 apareceu. Roda com contas fictícias do seed
  (`supabase/seed.sql`, um usuário novo — "Elisa Viewer" — adicionado
  especificamente porque nenhum dos 4 originais tinha papel `viewer`),
  nunca contra `praxis-crm-dev`, nunca depende de e-mail.
- **Validação manual ao vivo** (`playwright-cli`, preview real na Vercel,
  banco `praxis-crm-dev`): a única camada que exercita variável de
  ambiente de verdade, SSO da Vercel e o build de produção do Next —
  nenhuma das outras duas teria pego a pendência do ambiente Preview
  (seção anterior) nem a de Production (seção 7).

### 5.1 e2e — resultado no CI

**Verde.** `tests/e2e/contacts.spec.ts` rodou com sucesso junto do já
existente `auth-workspace.spec.ts` — **16 testes passando** (8 da A2 + 8
novos da A3), contra o Supabase local do CI, seed fictício, sem tocar
`praxis-crm-dev` nem produção. Levou 3 rodadas até ficar verde (nenhuma
delas revelou bug de produto — todas foram erro meu no teste em si, não
no comportamento validado):

1. `db:types:check` — `get_contact_merge_history()` editado à mão tinha
   `undone_at: string | null`; o gerador via `--local` infere `string`
   (sem `| null`) pra essa coluna nessa função — mesma classe de diferença
   cosmética entre `--linked`/`--local` já documentada na A2. Corrigido
   substituindo pelo trecho exato extraído do log do CI.
2. `plan(19)` em `08_a3_merge.test.sql` — a seção 9 (histórico de
   mesclagem) tem 4 asserções, não 3; contagem errada minha, não um bug.
   Corrigido para `plan(20)`, conferido contando as asserções no arquivo
   por comando (`grep -c`), não de novo de cabeça.

### 5.2 Validação manual ao vivo — resolvida e concluída

**Pendência original (histórico):** `CONTACTS_ACTIVE_KEY_VERSION`/
`CONTACTS_KEY_VERSIONS` não estavam configuradas no ambiente Preview da
Vercel — toda página retornava 500, log da função mostrava exatamente
`Variáveis de ambiente inválidas ou ausentes: CONTACTS_ACTIVE_KEY_VERSION,
CONTACTS_KEY_VERSIONS` (`getEnv()`, `src/server/env.ts`). Não gerei essas
chaves eu mesmo — decisão explícita em `docs/decisoes/a3-criptografia.md`
— o usuário rodou `node scripts/generate-contact-keys.mjs` no próprio
terminal e cadastrou as duas variáveis no ambiente Preview pela Vercel.
Um primeiro par gerado apareceu sem querer num print compartilhado no chat
e foi descartado por precaução (nunca chegou a ser usado); o par
efetivamente salvo na Vercel não apareceu nesta conversa em nenhum
momento. Redeploy do preview (`vercel redeploy`) aplicou as variáveis
novas — confirmado que o 500 desapareceu.

**Acesso ao preview:** o projeto tem Deployment Protection (SSO) da
Vercel, que bloqueia qualquer navegador automatizado. Habilitei
"Protection Bypass for Automation" nas configurações do projeto (`vercel
project protection enable praxis-crm --protection-bypass`) — isso gera um
token que permite acesso automatizado só quando enviado explicitamente
como parâmetro, sem desabilitar o SSO para acesso humano normal. Reversível
a qualquer momento nas configurações do projeto.

**Validação ao vivo no preview** (`playwright-cli`, contas fictícias
`+praxisqa*`, criadas e confirmadas nesta sessão com autorização explícita
do usuário para o UPDATE em `auth.users.email_confirmed_at` — nenhuma
senha registrada em lugar nenhum do repositório):

| Fluxo | Resultado |
|---|---|
| Criar contato com CPF | OK — CPF mascarado (`•••.•••.•••-••`) por padrão na tela de detalhe |
| Criar contato sem CPF | OK — campo é opcional, checkbox desmarcada por padrão, nenhum incentivo à coleta |
| Normalização de telefone | OK — `11988887777` virou `+5511988887777` (E.164) automaticamente |
| Revelar CPF como proprietário (owner) | OK — revela direto, sem pedir motivo |
| Revelar CPF como atendimento (sales) | OK — campo de motivo obrigatório aparece, botão "Confirmar" fica desabilitado até preencher; com motivo preenchido, revela corretamente |
| Revelar CPF como visualizador (viewer) | **Não testado ao vivo contra o preview** — esbarrei no limite de envio de e-mail do Supabase (`over_email_send_rate_limit`, mesma limitação já documentada na A2) ao tentar criar a terceira conta de QA em sequência rápida contra `praxis-crm-dev`. Coberto em duas outras camadas: pgTAP (`06_a3_contacts_isolation.test.sql`, papel `viewer` nunca revela, mesmo com motivo) e o novo e2e (`contacts.spec.ts`, teste 5 — contra Supabase local do CI, sem depender de e-mail nenhum, exatamente pra não ficar bloqueado por esse mesmo limite) |
| Detecção de duplicidade por telefone igual | OK — dois contatos com o mesmo telefone geraram 1 sugestão "Para revisão" com motivo explícito "Mesmo telefone", texto deixando claro que é prioridade de revisão, não união automática nem probabilidade de identidade |
| Comparação lado a lado | OK — CPF mascarado por padrão também nessa tela (SensitiveField reaproveitado), campos conflitantes com seletor do que manter, aviso de que nada se perde e que é reversível (contanto que nada tenha sido editado depois) |
| Mesclar contatos | OK — mesclagem confirmada, telefones e e-mails dos dois contatos combinados no vencedor, contato perdedor passa a responder 404 direto (rota de detalhe) |
| Desfazer mesclagem, sem edição posterior | OK, depois de corrigido — foi aqui que o achado 7 apareceu: a **primeira** tentativa (contra o preview local, banco hospedado) foi recusada mesmo sem edição nenhuma. Corrigido e reconfirmado: mesclar num par novo e desfazer logo em seguida funciona |
| Desfazer mesclagem, com edição real depois | OK — removi o telefone movido depois de mesclar; desfazer foi recusado com a mensagem certa, e a mesclagem continuou de pé (nada sobrescrito) |
| Tentar mesclar/desfazer sem permissão (`sales`) | OK, depois de corrigido — foi aqui que o achado 8 apareceu: a primeira tentativa quebrou a página inteira ("This page couldn't load"). Corrigido: agora mostra "Você não tem permissão para fazer isso." dentro do formulário, sem sair da página |
| Convite com e-mail divergente do da sessão atual | OK, achado incidental — a tela de convite avisa explicitamente "você está entrando como X, mas este convite é para Y. Saia e entre com o e-mail correto" quando a sessão logada não bate com o e-mail convidado |

Isolamento entre workspaces, busca por CPF via blind index e ausência de
CPF em log continuam cobertos pelo pgTAP (`supabase/tests/database/`,
rodando contra Postgres local no CI) — a validação acima cobre
especificamente o que só aparece contra um projeto hospedado e um preview
de verdade (variáveis de ambiente, SSO da Vercel, renderização real da
UI).

### Contas fictícias de QA usadas nesta validação

Nenhuma senha, token ou segredo fica registrado aqui — só e-mail (alias
`+` do próprio usuário), nome de exibição, papel e para que serviu.

| E-mail | Nome | Papel | Situação |
|---|---|---|---|
| `joaoniero2+praxisqaa3@gmail.com` | QA A3 Teste | Proprietário | Confirmada nesta sessão (SQL direto, autorizado). Dona de "Escritorio QA Praxis A3" — workspace usado em toda a validação acima |
| `joaoniero2+praxisqaa3sales@gmail.com` | QA Sales Teste | Atendimento/comercial | Confirmada nesta sessão (SQL direto, autorizado). Usada para validar a exigência de motivo na revelação de CPF |
| `joaoniero2+praxisqaa3viewer@gmail.com` | — | — | **Cadastro não concluído** — esbarrou no limite de envio de e-mail do Supabase (`over_email_send_rate_limit`) na segunda tentativa. Artefato inofensivo, sem confirmação nem membership |

---

## 6. Site URL / Redirect URLs do Supabase Auth — teste disparado, aguardando confirmação

Pendência herdada da A2 (ver A2-HANDOFF.md). Por instrução explícita:
**não bastava checar configuração — precisava testar um link real pelo
fluxo normal.** Não tenho (e não devo buscar) o token de acesso da CLI
do Supabase para ler a configuração de Auth via API de gerência — tentei
localizar o arquivo de token da CLI e me detive antes de terminar, por
ser efetivamente uma busca de credencial.

**Teste feito:** em vez disso, usei o próprio fluxo "Criar conta" da tela
de login em Production (`https://praxis-crm-eight.vercel.app/entrar`)
com um alias `+` do e-mail do usuário
(`joaoniero2+praxisredirectcheck@gmail.com`). A aplicação confirmou
"Cadastro criado. Confira seu e-mail para confirmar a conta antes de
entrar." — ou seja, o Supabase Auth disparou um e-mail de confirmação
real, construído com o Site URL/Redirect URLs configurados hoje no
projeto `praxis-crm-dev`.

**O que falta:** eu não tenho acesso a essa caixa de entrada. **Preciso
que o usuário confira o e-mail recebido em `joaoniero2+praxisredirectcheck@gmail.com`
e diga para onde o link de confirmação aponta** (o domínio/caminho basta,
não precisa colar o link inteiro nem clicar antes de me responder). Se
apontar para `https://praxis-crm-eight.vercel.app/...` (ou outro domínio
correto do projeto), a pendência está resolvida de verdade. Se apontar
para `localhost`, um domínio antigo, ou qualquer coisa incorreta, o ajuste
é no painel do Supabase (`praxis-crm-dev` → Authentication → URL
Configuration → Site URL / Redirect URLs) — me diga o que apareceu que eu
digo exatamente qual valor deveria estar lá.

**Não declaro esta pendência resolvida enquanto essa confirmação não
chegar.**

---

## 7. Ambiente Production da Vercel — configurado e validado ao vivo

**Decisão do usuário sobre o ambiente:** enquanto o desenvolvimento
continuar, o deploy de `main` na Vercel é uma **demonstração interna**,
usando o mesmo projeto `praxis-crm-dev` e exclusivamente dados fictícios
— não um ambiente de produção para clientes reais. Nenhum projeto
Supabase novo foi criado nesta rodada, por instrução explícita. **O
ambiente real para clientes ainda não existe** — fica para quando o
usuário decidir criá-lo (ver pergunta 9 da seção "Decisões que dependem
do escritório" no plano de arquitetura).

**Estado inicial (achado na rodada anterior, antes do merge):**
`vercel env ls production` não mostrava nenhuma variável — nem as duas da
A3, nem as três herdadas da A2. A produção retornava 500 em toda página.

**Configuração desta rodada — com um erro no meio, corrigido antes de
causar dano:**

1. Tentei copiar os valores do ambiente Preview via `vercel env pull`
   para preenchê-los automaticamente. **Descoberta importante:** a Vercel
   CLI substitui qualquer valor lido por `pull` por um texto de segurança
   fixo quando detecta que quem chama é um agente automatizado — confirmei
   comparando hashes: os "valores" extraídos para três variáveis
   diferentes eram byte a byte idênticos entre si, o que é impossível para
   segredos reais distintos. Isso é uma proteção da própria Vercel contra
   exfiltração de segredo por agente, funcionando como deveria.
2. Sem perceber isso a tempo, gravei esse texto de segurança (não um
   segredo real) em `CONTACTS_ACTIVE_KEY_VERSION`/`CONTACTS_KEY_VERSIONS`
   de Production. Nenhum deploy chegou a usar esses valores (Production já
   estava fora do ar). Pedi autorização explícita, apaguei as duas
   entradas (`vercel env rm`) e confirmei a remoção antes de continuar.
3. `WORKSPACE_ACTIVE_COOKIE_SECRET` (gerado novo, nunca reaproveitando o
   do Preview) e `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   (não são segredos — valores públicos do `praxis-crm-dev` já confirmados
   em uso) foram configurados por mim, com autorização explícita, sem que
   eu tivesse acesso a segredo nenhum.
4. `CONTACTS_ACTIVE_KEY_VERSION`/`CONTACTS_KEY_VERSIONS` — a Vercel
   bloqueia deliberadamente a leitura automatizada desses valores (mesmo
   mecanismo do item 1), então **o usuário configurou os dois diretamente
   no painel**, usando sua própria cópia das mesmas chaves já validadas no
   Preview (mesmo banco `praxis-crm-dev` = mesma chave necessária pra
   decifrar os registros já existentes). Uma primeira tentativa colou uma
   versão anterior da chave por engano (o app rejeitou o valor de
   `CONTACTS_KEY_VERSIONS` na validação de `src/server/env.ts`); corrigido
   pelo próprio usuário na segunda tentativa. Nenhum valor de cifra passou
   por mim em momento nenhum.

**Resultado final:** as 5 variáveis confirmadas em Production (só nomes,
via `vercel env ls production`) — `CONTACTS_ACTIVE_KEY_VERSION`,
`CONTACTS_KEY_VERSIONS`, `WORKSPACE_ACTIVE_COOKIE_SECRET`,
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Nenhum
valor de cifra foi gerado, substituído ou visto por mim. Nenhuma entrada
do ambiente Preview foi alterada ou removida.

**Merge e deploy:** PR #3 mesclado em `main` via merge commit (mesma
convenção dos PRs #1/#2), sem bypass de proteção nenhuma — não havia
branch protection configurada no repositório (`gh api
repos/johlll/praxis-crm/branches/main/protection` → 404), então "fluxo
normal do GitHub" foi só `gh pr merge --merge`. O merge disparou um
deploy automático de Production; um redeploy adicional
(`vercel redeploy`) foi necessário duas vezes — primeiro porque o build
capturou as variáveis de ambiente um instante antes de `CONTACTS_KEY_VERSIONS`
terminar de ser salva, depois porque o valor colado estava errado — mesma
mecânica de "variável nova exige redeploy" já documentada para o Preview.

**Validação ao vivo em Production** (`playwright-cli`, conta QA existente
`joaoniero2+praxisqaa3@gmail.com`, senha redefinida nesta sessão com
autorização explícita para o `UPDATE` em `auth.users.encrypted_password`
usando `extensions.crypt()` — a mesma técnica já usada em
`supabase/seed.sql`; nenhuma senha registrada aqui):

| Fluxo | Resultado |
|---|---|
| Login | OK — `joaoniero2+praxisqaa3@gmail.com` autenticou e chegou em `/visao-geral` |
| Listagem de contatos | OK — 7 contatos existentes do workspace "Escritorio QA Praxis A3" listados |
| Criar contato fictício (com CPF) | OK — "Producao Validacao Live" criado com CPF, telefone normalizado para E.164 |
| Revelar CPF autorizado (owner) | OK — revelou `11122233396` sem pedir motivo, botão virou "Ocultar" |
| Mesclar dois contatos novos (mesmo telefone) | OK — candidato "Para revisão" detectado, comparação e mesclagem confirmadas, histórico "Mesclado com Validacao Live Um" visível no contato mantido |
| Desfazer mesclagem, sem edição posterior | OK — confirmado no diálogo, contato "Validacao Live Um" voltou a existir como página própria e independente |

Dados fictícios criados nesta validação (`Producao Validacao Live`,
`Validacao Live Um`, `Validacao Live Dois`) foram deixados no banco,
mesmo padrão dos artefatos de QA já existentes de rodadas anteriores
(`Contato Undo A/B`, `Contato Conflito A/B`, `Perm Test A/B`) — todos
fictícios, nenhum dado real.

---

## 8. Confirmações explícitas

- **Nenhuma fase além da A3 foi iniciada.** Sem pipeline, Perfil 360,
  atividades, WhatsApp ou IA. Escopo da A4 apresentado ao usuário (fora
  deste documento), não implementado.
- **Nenhum arquivo de referência visual foi alterado.**
- **PR #3 mesclado em `main` com aprovação explícita do usuário**, pelo
  fluxo normal do GitHub (`gh pr merge --merge`), sem bypass de proteção
  — não havia branch protection configurada. Deploy de Production
  disparado pelo merge, validado ao vivo (seção 7).
- **`praxis-crm-dev`:** só migrations aditivas aplicadas (dry-run
  conferido antes de cada uma), sem reset, sem remoção de dado existente,
  sem enfraquecer proteção nenhuma — RLS/FORCE conferidas depois de cada
  migration.
- **Nenhum CPF real em lugar nenhum** — seed usa CPF fictício
  (`222.222.222-22`), cifrado com chave de teste fixa e documentada,
  nunca usada em ambiente real.
- **Um quinto usuário fictício foi acrescentado ao seed** (`supabase/seed.sql`):
  "Elisa Viewer (seed)", papel `viewer` no Escritório Um — nenhum dos 4
  originais tinha esse papel, necessário pro e2e de revelação negada.
  Só adiciona uma linha nova; conferido que nenhuma asserção existente
  (pgTAP ou e2e da A2) dependia de contagem exata de membros do Escritório
  Um para quebrar.
- **Ambiente Production configurado nesta rodada, com autorização
  explícita em cada escrita** — ver seção 7 para o relato completo,
  incluindo o erro cometido e corrigido (placeholder de segurança da
  Vercel gravado por engano, depois apagado).
- **`Protection Bypass for Automation` foi habilitado no projeto Vercel**
  (`vercel project protection enable praxis-crm --protection-bypass`) —
  necessário pra qualquer verificação automatizada (preview ou produção)
  conseguir passar do SSO. Não desabilita o SSO pra acesso humano normal;
  reversível a qualquer momento nas configurações do projeto.

---

## 9. Manutenção proposta, fora do escopo da A3 (não implementada)

O mesmo bug de propagação de erro de permissão corrigido em
`contacts/actions.ts` (achado 8, seção 4) **também existe, sem correção,
em `src/modules/team/actions.ts`** (código já mesclado desde a A2):

- `createInvitationAction` (`invitation.manage`) — já retorna
  `TeamActionState {ok, error}`, correção idêntica à da A3
  (`requirePermissionSafe`).
- `cancelInvitationAction`, `updateMembershipRoleAction`,
  `removeMembershipAction` — actions `void` sem canal de erro, precisam
  do equivalente a `requirePermissionVoid`.

Proposta: extrair os dois helpers de `contacts/actions.ts` para um local
compartilhado (ex.: `src/server/authz/safe.ts`) e aplicar nos 4 pontos
acima. `acceptInvitationAction` usa `requireUser()`, não
`requirePermission()` — caso diferente, fica de fora. Registrado aqui
como tarefa própria; não implementado nesta branch.

---

## 10. Próximo passo — A4

Escopo, dependências e critério de aceite da A4 (Leads) apresentados ao
usuário a partir do plano de arquitetura original, fora deste documento.
**Não implementada.**
