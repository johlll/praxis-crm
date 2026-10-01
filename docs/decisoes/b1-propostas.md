# B1 — Propostas: geração de PDF, versionamento e envio real por e-mail: decisões

## 1. Escopo do plano e o que a A9 já tinha reservado

O plano (§12, marco B, item B1) descreve: "Geração de PDF, versionamento,
envio, status, vínculo com a timeline." A A9 já havia construído todo o
ciclo de vida (`proposals`, `create_proposal`/`send_proposal`/
`decide_proposal`, timeline) e deixado o comentário explícito no schema:
"Sem PDF/`document_path`: geração de documento é exclusiva da fase B1."

Decisões posteriores respeitadas: PDF em B1, Google Agenda em B2, WhatsApp
real em B3 — nenhuma delas foi tocada aqui. Assinatura eletrônica (§16,
item 6 do plano) fica fora, como pergunta em aberto própria.

## 2. Desenho revisado (sete correções sobre a primeira proposta, mais uma oitava vinda de defeito real)

### 2.1 Versão enviada ≠ versão mais recente

`proposal_documents` é append-only e imutável depois de `status='ready'`.
`proposal_email_sends.document_id` é uma FK fixa a uma versão exata — nunca
recomputada. Regenerar depois de um envio (v2 enviada, v3 gerada por
correção) nunca altera o que já foi mandado: o registro histórico do envio
continua apontando para v2, mesmo com v3 já existindo.

### 2.2 Mudanças permitidas antes/depois do envio

Antes do primeiro envio (`rascunho`): regenerar é livre. Depois de
`enviada`: regenerar continua livre (cria nova versão), reenviar é livre
(nova linha em `proposal_email_sends`, sempre contra a versão escolhida no
momento do clique). Depois de decidida (`aceita`/`recusada`):
`begin_proposal_document` recusa com `proposal_decided_no_new_document` —
versões já existentes continuam listadas e baixáveis, só não nasce
nenhuma versão nova. **Revisão comercial é proposta NOVA** (`create_proposal`,
já suportado desde a A9 — um lead tem várias propostas), nunca uma
reescrita de uma proposta já fechada.

### 2.3 Sequência banco → geração → Storage → registro

Duas fases: `begin_proposal_document` reserva a versão com `status='pending'`
(lock de linha na proposta serializa concorrência — duas gerações
simultâneas da mesma proposta nunca colidem); a aplicação gera o PDF,
**confere que ele abre e contém o número da proposta**
(`assertValidProposalPdf`, correção 8 — acrescentada depois do caso do
§10) e só então sobe para o Storage (`upsert: false`, nunca sobrescreve
um objeto existente); `finalize_proposal_document` confirma
`status='ready'` depois de reconferir, lendo `storage.objects` na mesma
base Postgres, que o arquivo existe com o tamanho esperado.

As duas checagens respondem perguntas diferentes, e a distinção importa:
`finalize` prova **"o que gravamos é o que está lá"** (integridade de
bytes); `assertValidProposalPdf` prova **"o que gravamos é um PDF que
abre e diz o que deveria dizer"** (validade do documento). Os 16 arquivos
quebrados do §10 passavam na primeira — tamanho e checksum coerentes — e
teriam sido recusados pela segunda. Qualquer falha em qualquer passo
chama `fail_proposal_document` — nunca fica uma linha `ready` sem arquivo,
nunca uma segunda finalização sobrescreve checksum/tamanho de uma linha já
pronta. Sem cron de retomada: uma linha `pending` mais velha que alguns
minutos é tratada como falha na própria leitura (computado, não
armazenado) — se isso se provar insuficiente em operação real, dá para
reaproveitar o padrão de reconciliação por cron já usado na A11.

### 2.4 Autorização por papel

| Ação | owner/admin/manager/lawyer | sales | viewer |
|---|---|---|---|
| Criar/editar proposta (A9, inalterado) | sim | sim | não |
| Gerar PDF | sim | não | não |
| Ver que existe documento (sem link) | sim | sim | sim |
| Baixar PDF | sim | não (404, não 403) | não (404) |
| Enviar por e-mail real | sim | não | não |
| Registrar envio manual (A9, inalterado) | sim | sim | não |

O PDF carrega o valor exato por definição — por isso é mais restrito que
`proposal.edit` (que inclui `sales`, que só enxerga a faixa). Nova
permissão `proposal_document.manage` (`src/lib/roles.ts`), mesma faixa de
`conflict_check.edit`. Gate real é o `GRANT` das funções em SQL, não a
checagem em TypeScript (defesa em profundidade, não o mecanismo).

**Limite conhecido, não "resolvido":** uma URL assinada do Storage, uma
vez emitida, funciona para quem a tiver, até expirar — propriedade
inerente ao mecanismo. Mitigado por TTL curto (60s, gerada por clique) e
pelo fato de o e-mail ao cliente levar o PDF **anexado**, nunca um link do
Storage — o destinatário externo nunca recebe uma URL assinada.

### 2.5 Estados e idempotência do envio por e-mail

`proposal_email_sends.status`: `queued` → `accepted` | `failed`. Nunca
"sent"/"delivered": `accepted` prova só que o Resend ACEITOU a mensagem,
não que a caixa do cliente recebeu — confirmação de entrega exigiria
processar webhook do provedor, fora do escopo desta fase.

Idempotência: `idempotency_key` é gerada no CLIENTE, uma vez por abertura
do diálogo de envio (mesmo truque de remount-por-`key` já usado em
`CreateProposalDialog`), reenviada sem mudar em qualquer retry do MESMO
clique. `queue_proposal_email` faz `insert ... on conflict` efetivo via
checagem de unicidade: só quem CRIA a linha (`is_new=true`) segue para
chamar o Resend; uma segunda chamada com a mesma chave nunca dispara um
segundo envio. A mesma chave também vai no cabeçalho `Idempotency-Key` da
API do Resend, que a documentação do provedor honra por 24h — segunda
camada, não a única. Um NOVO envio deliberado (reabrir o diálogo, ou
clicar "tentar novamente" depois de uma falha) sempre gera uma chave nova.

`mark_proposal_email_sent`/`mark_proposal_email_failed` têm `GRANT`
restrito a `service_role` — nenhum usuário autenticado tem `EXECUTE`
nelas, então uma chamada `supabase.rpc('mark_proposal_email_sent', …)`
feita do navegador falha na própria permissão do Postgres, antes de
entrar no corpo da função. Nunca chamamos `mark_failed` depois que o
Resend já confirmou aceite — isso mentiria sobre o que aconteceu.

### 2.6 Timeline sem duplicar o mesmo fato

O braço `proposta` da A9 já reagia a `coalesce(decided_at, sent_at,
created_at)` — o PRIMEIRO envio bem-sucedido (manual, A9, ou real por
e-mail, B1) já aparece por essa linha mudar de timestamp/status.
`mark_proposal_email_sent` só dispara a transição `rascunho→enviada` na
PRIMEIRA vez (`caused_status_transition=true`); reenvios subsequentes
marcam `caused_status_transition=false` e não tocam `proposals`. A
timeline ganhou um braço novo, filtrado por `status='accepted' and not
caused_status_transition` — captura exatamente os reenvios, que de outra
forma ficariam invisíveis, sem duplicar o primeiro envio, que já tinha
representação.

### 2.7 Dados obrigatórios — nenhum, exceto um mínimo para envio real

Nenhum campo do escritório (razão social, CNPJ, OAB, endereço — novo em
`workspaces`, todos `nullable`) nem do cliente (CPF/CNPJ, 1:1 opcional
desde a A3) bloqueia a GERAÇÃO do PDF: ausente, a linha correspondente
some do documento. Para o ENVIO REAL, dois mínimos, checados em
`queue_proposal_email`: `workspaces.legal_name` precisa existir (mandar
uma proposta sem nenhuma identificação de quem envia não é defensável) e o
destinatário precisa ser um e-mail JÁ conhecido do contato
(`contact_emails`) — nunca texto livre digitado na hora.

### 2.8 Correção 8 — o PDF precisa abrir (acrescentada em 30/09/2026)

As sete correções acima são do desenho original. Esta é a oitava, e
nasceu de um defeito real: um envio de verdade chegou com o anexo em
branco. As sete primeiras tratavam de **qual** documento é enviado, de
**quem** pode enviar e de **o que** o registro afirma; nenhuma tratava de
**se o arquivo abre**. `finalize_proposal_document` confere tamanho e
checksum contra o que a própria aplicação calculou — então bytes já
corrompidos antes do hash passavam, com todos os registros coerentes.

Agora `assertValidProposalPdf` (`src/server/proposals/pdf-validate.ts`)
roda antes de qualquer upload e, de novo, antes de anexar ao e-mail:
descomprime cada fluxo, recusa `/Length` que não bate com os bytes
presentes e exige o número da proposta no texto desenhado. Detalhe do
caso, da causa e das provas em §10 e §11.

## 3. Infra de e-mail — reaproveitada, não recriada

`docs/decisoes/estabilizacao-pos-a9.md` §7.2 já registra Resend com
domínio `mail.collios.cloud` verificado (DKIM/SPF/DMARC), usado hoje só
como SMTP do mailer do Supabase Auth. Esta fase reaproveita a MESMA conta
e domínio — nenhuma conta nem domínio novo — mas precisa de uma API key
própria da aplicação (não a credencial SMTP do Auth) e de um remetente
distinto de `nao-responda@` (correspondência de negócio, pode receber
resposta). `getResendConfig()` (`src/server/proposals/env.ts`) é
OPCIONAL: sem `RESEND_API_KEY`/`RESEND_FROM_EMAIL`, o app inteiro continua
funcionando normalmente, só o botão de envio real fica desabilitado.
Nenhuma das duas variáveis foi configurada em nenhum ambiente por esta
entrega — habilitar envio de verdade, mesmo só para QA com destinatário
fictício, é decisão e execução à parte.

## 4. Fora do escopo desta fase

- **Confirmação de entrega** (webhook do Resend para `delivered`/`bounced`)
  — exigiria um novo endpoint público com verificação de assinatura,
  categoria de escopo própria, não pedida aqui.
- **Upload de documentos arbitrários** (B4) — o PDF de proposta é gerado
  pelo próprio sistema, nunca um upload de terceiro; ADR-005 já distinguia
  os dois casos.
- **Assinatura eletrônica** — pergunta em aberto do plano (§16, item 6),
  decisão própria.
- **Template customizável por escritório** — fixo no código nesta fase, um
  único cliente.

## 5. Correção pós-validação hospedada: GRANT do perfil do escritório

A validação hospedada contra `praxis-crm-dev` (dados fictícios de QA, sem
tocar o Resend) encontrou um defeito real antes do merge: a policy
`workspaces_update` (A2, `20260907120200_a2_rls.sql`) restringe a
owner/admin, mas nunca teve o GRANT de tabela que a torna utilizável —
`authenticated` só tinha `SELECT` em `workspaces`
(`20260908040000_a2_normalize_table_privileges.sql`). RLS decide **quais
linhas** uma escrita permitida enxerga; sem o GRANT, a escrita nunca chega
a ser avaliada. `updateWorkspaceLegalProfileAction` (Configurações →
Escritório) falhava com "permission denied for table workspaces" em
qualquer ambiente real — RLS e CI estavam verdes porque nenhum teste
(pgTAP ou E2E) jamais exercitou uma escrita `authenticated` real contra
`workspaces`.

**Correção** (`20260929123000_b1_workspace_legal_profile_grant.sql`):
GRANT de `UPDATE` só nas 8 colunas do perfil jurídico —
`legal_name, cnpj, oab_uf, oab_number, address_line, address_city,
address_uf, address_zip` — nunca a tabela inteira. `name`, `slug` e
`created_by` continuam sem nenhum caminho de escrita direta para
`authenticated`.

**Cobertura adicionada** em `19_b1_propostas_documentos.test.sql` (10
asserções novas, plan 41→51): owner salva e lê de volta os 8 campos;
lawyer/lawyer2/sales/viewer bloqueados (RLS filtra a linha, 0 linhas
afetadas, sem exceção); isolamento entre workspaces (ser owner de um
segundo workspace não dá poder sobre o primeiro); `name`/`slug`/
`created_by` continuam bloqueados mesmo para o owner (GRANT é só de
coluna).

**Validação hospedada, rodada após o fix** (dados fictícios da workspace
QA "Escritorio QA Praxis A3", código real de `src/server/proposals/*`
contra `praxis-crm-dev`, sem configurar nem chamar o Resend): perfil do
escritório salvo via RLS real; duas versões de PDF geradas e finalizadas
(Storage real); v1 permanece `ready` e com os mesmos bytes depois de v2
existir; `list_proposal_documents`/`get_proposal_document_for_download`
corretos por papel (owner/lawyer baixam, sales/viewer bloqueados,
nenhuma chave vaza `storagePath`); download devolve exatamente os bytes
da versão pedida; isolamento entre workspaces confirmado para listagem e
download; fila de e-mail (`queue_proposal_email`) criada e permanece
vinculada ao `document_id` exato, idempotência confirmada, ator sem papel
autorizado bloqueado; `authenticated` confirmado sem EXECUTE em nenhuma
das 6 funções de escrita, mesmo sendo owner. Nenhum e-mail foi enviado
(fila fica em `queued`).

> **CORREÇÃO (30/09/2026), comprovada byte a byte — ver §10.** Onde este
> parágrafo diz "duas versões de PDF geradas e finalizadas (Storage
> real)", leia-se: **geradas, finalizadas e com bytes conferidos — mas o
> conteúdo nunca foi aberto nem renderizado nesta rodada**. Todos os PDFs
> produzidos por esta validação (v1 a v16 de `PROP-2026-0003`) são
> **arquivos inválidos**: o fluxo de conteúdo não descomprime e a página
> renderiza em branco. As asserções acima continuam todas verdadeiras —
> elas comparavam tamanho, checksum e igualdade de bytes entre o que foi
> renderizado e o que foi armazenado, nunca se o PDF abria. A geração
> dentro da aplicação (Vercel) está correta: v17 e v18, geradas pela
> interface real, são íntegras e legíveis (§7 permanece válido).

## 6. Segundo defeito real, encontrado validando o Preview pela interface

A validação hospedada (§5) rodou o código de `src/server/proposals/admin/**`
direto pelo Node/Vitest, nunca através do bundle real do Next.js. Ao
clicar "Gerar PDF" pela primeira vez pela interface do Preview, a ação
falhou com a mensagem genérica de erro (`GENERIC_MESSAGE` de
`src/lib/errors.ts`), nunca vista antes.

**Causa:** `adminBeginProposalDocument` (e todo o resto do módulo)
reaproveitava `createAdminSupabaseClient()` de
`src/server/supabase/admin.ts` — o cliente `service_role` da A11. A
config desse cliente (`getIngestConfig()`) valida, **na mesma chamada
Zod**, `SUPABASE_SECRET_KEY` **junto com** `TURNSTILE_SECRET_KEY`,
`UPSTASH_REDIS_REST_URL/TOKEN`, `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY`,
`CRON_SECRET` e as chaves de cifra de payload da A11 — nenhuma delas
relacionada a propostas. Faltando qualquer uma, a validação inteira falha
e `begin_proposal_document` nunca chega a ser chamado. Esse acoplamento
não tinha como aparecer nem em CI (que configura o ambiente A11 completo)
nem na validação hospedada direta (que chama o RPC pelo `service_role`
puro, sem passar por `getIngestConfig()`).

**Correção** (sem migration): novo `src/server/proposals/admin/supabase.ts`
com um cliente `service_role` próprio, validado só com
`SUPABASE_SECRET_KEY` + `NEXT_PUBLIC_SUPABASE_URL`. `documents.ts` e
`email.ts` passam a importar dali, não mais de
`src/server/supabase/admin.ts`. `eslint.config.mjs` ajustado: a exceção
de lint para service_role fora de webhook/job passa a valer só para este
arquivo novo (não a pasta `admin/**` inteira) — nenhum outro arquivo
constrói um cliente cru.

**Segunda causa, de infraestrutura, descoberta em seguida:** mesmo com o
código corrigido, a geração continuou falhando — `SUPABASE_SECRET_KEY`
simplesmente não existia no escopo Preview do Vercel para nenhum branch
(nem genérico, nem específico). Adicionada, com autorização, só para
`feat/b1-proposals-pdf` (`vercel env add ... preview feat/b1-proposals-pdf`,
mesmo valor já usado em produção/local — nenhuma rotação, nenhuma conta
nova), seguida de um redeploy do mesmo commit para captar a variável.
Depois dos dois fixes juntos, a geração funcionou pela interface real
(v17 e v18 desta rodada).

## 7. Validação pela interface (Preview, commit `1551ca4`, dados fictícios)

- **Perfil do escritório:** editado pela tela de Configurações → Escritório
  (razão social alterada para incluir "(validado via UI)"), recarregada a
  página, valor persistido idêntico.
- **Duas versões novas geradas pela UI** (v17, v18) — PDFs abertos e
  conferidos visualmente: cabeçalho do escritório completo (razão social,
  CNPJ, OAB, endereço, CEP), número da proposta, cliente, objeto,
  honorários com valor formatado, rodapé — uma única página, sem corte,
  totalmente legível.
- **Histórico de versões** na aba Propostas: lista completa (v1 a v18,
  incluindo a v14 travada em "Gerando…" desde uma rodada anterior — nunca
  virou `ready` sem o arquivo, confirmando de novo a garantia de
  integridade).
- **Timeline (aba Histórico):** um único evento para PROP-2026-0003,
  refletindo o estado real (`rascunho`) — nada fabricado, nenhuma
  duplicação.
- **Bloqueio de download para sales e viewer:** logados pela tela normal
  (senha de QA definida via API administrativa, só para teste), a aba
  Propostas não mostra os botões "Gerar PDF"/"Enviar por e-mail" nem o
  link "Baixar" para nenhuma versão; acesso direto à rota
  `/api/proposals/documents/[id]/download` devolve **404** para os dois
  papéis — nunca 403, como desenhado.

## 8. Envio real por e-mail — levantamento antes de configurar (nada enviado)

Nenhuma chamada ao Resend foi feita nesta rodada. Levantamento:

- **Exigido pelo código:** `RESEND_API_KEY` e `RESEND_FROM_EMAIL`
  (`src/server/proposals/env.ts`, `getResendConfig()`) — ausentes em todo
  ambiente hoje (nem `.env.local`, nem nenhum escopo do Vercel).
- **Conta/domínio já existentes** (`docs/decisoes/estabilizacao-pos-a9.md`
  §7.2): Resend, domínio `mail.collios.cloud` (plano gratuito, região São
  Paulo), DKIM/SPF/MX/DMARC já verificados por consulta DNS externa.
  Hoje usado exclusivamente como SMTP do Supabase Auth
  (`nao-responda@mail.collios.cloud`) — nenhuma API key de aplicação
  existe ainda; a senha SMTP do Auth não deve ser reaproveitada aqui (é
  outro uso, outro remetente).
- **Pendente, fora do meu acesso nesta sessão:** eu não tenho login no
  painel do Resend — não consegui listar as API keys nem os remetentes já
  cadastrados na conta. Quem tiver acesso ao painel confirma diretamente.
- **Procedimento proposto para um único envio controlado:**
  1. No painel do Resend, criar uma **API key nova**, de aplicação (não a
     senha SMTP do Auth), com o menor escopo necessário (só envio, restrita
     ao domínio se a interface permitir). Não recria conta nem domínio —
     usa o `mail.collios.cloud` já verificado.
  2. Escolher um remetente distinto de `nao-responda@` no mesmo domínio já
     verificado (ex.: `propostas@mail.collios.cloud`) — nenhum registro de
     DNS novo é necessário, a verificação já é por domínio inteiro.
  3. Configurar `RESEND_API_KEY`/`RESEND_FROM_EMAIL` **só no Preview desta
     branch** (mesmo padrão usado para `SUPABASE_SECRET_KEY` acima),
     redeploy para captar.
  4. Usar a proposta fictícia já existente (`PROP-2026-0003`) e uma versão
     de PDF já gerada e identificada nesta rodada (ex.: v18,
     `e48c78fd-7a48-4c71-8836-2cf525e0abb6`) — nunca gerar uma versão nova
     só para o teste de envio, para que o e-mail carregue exatamente o
     conteúdo já conferido visualmente em §7.
  5. Cadastrar o endereço de destino (a ser confirmado por quem pedir o
     teste) em `contact_emails` do contato fictício, exatamente como o
     fluxo real exige (correção 6 — nunca texto livre).
  6. Clicar "Enviar por e-mail" pela interface, uma única vez, com essa
     versão e esse destinatário.
  7. **Distinguir os dois resultados, explicitamente:**
     - **Aceito pelo Resend:** `queue_proposal_email`/`mark_proposal_email_sent`
       confirmam `status = accepted` com um `provider_message_id` real —
       visível na aba Propostas e na tabela `proposal_email_sends`. Prova
       só que o Resend recebeu e aceitou a mensagem.
     - **Recebido de fato na caixa de entrada:** só quem controla esse
       endereço pode confirmar (inclusive checando spam) — não há webhook
       de entrega implementado (fora do escopo da B1, `docs/decisoes/
       b1-propostas.md §4`). As duas confirmações são independentes; uma
       não implica a outra.

## 9. Envio único controlado — executado (30/09/2026)

Procedimento do §8 executado ponta a ponta, com autorização explícita para
este envio específico. Nenhuma conta, domínio ou chave existente foi
alterada; nenhum outro e-mail foi enviado.

- **API key criada:** `praxis-crm-b1-propostas`, permissão **Sending
  access** (não Full access), restrita ao domínio `mail.collios.cloud` —
  distinta da `praxis-crm-smtp` usada pelo Auth (intocada).
- **Remetente escolhido:** `propostas@mail.collios.cloud` (mesmo domínio
  já verificado, sem alteração de DNS).
- **Variáveis configuradas:** `RESEND_API_KEY` e `RESEND_FROM_EMAIL`, só
  no Preview do branch `feat/b1-proposals-pdf` (mesmo padrão do
  `SUPABASE_SECRET_KEY` em §6), seguido de redeploy do deployment vigente
  para captar as duas.
- **Achado ao localizar a proposta:** a proposta fictícia `PROP-2026-0003`
  pertence ao lead **"Cliente A9 Revalidação (fictício)"** (não ao lead
  esperado inicialmente) — confirmado navegando pela interface antes de
  qualquer envio. O mesmo contato já tinha **6 tentativas anteriores**
  registradas como "em andamento" (nunca `aceito` nem `falhou`) para
  `cliente.b1.qa@example.com`, de testes de UI anteriores à correção do
  cliente admin (§6) — ficaram nesse estado porque a falha ocorria antes
  de `adminDispatchProposalEmail` ser chamado (download do PDF ou RPC de
  sessão), então `mark_proposal_email_failed` nunca rodava. Não são
  reprocessadas automaticamente (não há reconciliação para este caso);
  ficaram como está, sem tentar corrigir por não ser o escopo desta
  rodada — registrado aqui como pendência menor, não bloqueante.
- **Pré-envio, conferido pela interface:** proposta fictícia
  (`PROP-2026-0003`, R$ 1.234,00, rascunho); destinatário cadastrado em
  `contact_emails` do contato fictício (`joaoniero2@gmail.com`, o
  endereço confirmado por quem pediu o teste); documento anexado é a v18
  já gerada e conferida visualmente em §7 (nenhuma versão nova gerada
  para o teste).
- **Envio disparado uma única vez** pela interface oficial ("Enviar por
  e-mail" → selecionar destinatário → "Enviar"). Diálogo de confirmação
  já deixa o texto "O CRM só registra 'aceito pelo provedor' — não
  confirma que a caixa do cliente recebeu" antes do clique.
- **Aceito pelo provedor:** confirmado em dois lugares independentes —
  - Timeline do CRM: "Aceito pelo provedor de e-mail para
    joaoniero2@gmail.com em 30/09/2026, 08:34".
  - Painel do Resend (`/emails/01a0f217-dba7-717a-8589-6133ae4b77a9`):
    From `propostas@mail.collios.cloud`, To `joaoniero2@gmail.com`,
    Subject "Proposta de honorários PROP-2026-0003", anexo
    `PROP-2026-0003.pdf`, eventos `sent` e **`delivered`** (aceite pelo
    servidor de destino), ambos às 08:34.
- **Recebido de fato na caixa de entrada:** **ainda não confirmado** —
  pendente de quem controla `joaoniero2@gmail.com` verificar a chegada
  (inclusive pasta de spam) e abrir o anexo. `delivered` no Resend
  significa que o servidor de destino aceitou a mensagem; não é o mesmo
  que "chegou na caixa de entrada e foi aberta" — essa confirmação
  continua sendo a etapa separada e pendente.

> **O e-mail chegou, e o anexo abriu em branco.** O que isso revelou está
> em §10. O registro de "aceito pelo provedor" acima continua correto; o
> que estava errado era *qual arquivo* foi anexado, e o próprio arquivo.

## 10. Anexo em branco — dois defeitos, comprovados byte a byte

O destinatário confirmou o recebimento e o anexo abriu **em branco**.
Investigação feita sobre os bytes, sem gerar versão nova e sem reenviar.
Arquivos preservados como evidência em
`C:\Users\niero\Desktop\Projetos\praxis-crm-evidencias-b1\` (fora do
repositório, nunca commitados).

### 10.1 Defeito A — o e-mail anexou a v1, não a v18

Comparação direta:

| | Anexo recebido | v18 no Storage |
|---|---|---|
| Tamanho | 2.735 bytes | 2.774 bytes |
| SHA-256 | `e992ffe8701f3970…b699e51` | `306c4261376aa95f…0ba404d` |
| `CreationDate` | `D:20260929200839Z` | `D:20260930025041Z` |
| Fluxo de conteúdo | **não descomprime** | descomprime (7.658 bytes) |
| Texto extraível | **nenhum** | 26 trechos, completos |

O anexo é **byte a byte idêntico à v1** (mesmo SHA-256, mesmo tamanho,
mesma data de criação). O próprio banco confirma: o registro em
`proposal_email_sends` gravou
`documentId = 44156d85-cd7b-43cb-9ee8-6570d87148a3`, que é a **v1**. O
transporte foi fiel — o Resend entregou exatamente os bytes que a
aplicação mandou.

**Causa, no código** — `src/components/leads/proposals-section.tsx:509`:

```js
const readyDocument = [...documents].reverse().find((d) => d.status === "ready" && d.canDownload);
```

`list_proposal_documents` já devolve `order by d.version desc`
(`20260929120200_b1_proposal_documents_functions.sql`). O `.reverse()`
inverte para **ascendente**, e o `.find()` passa a devolver a versão
pronta **mais antiga** — a v1 — em vez da mais recente. A lista exibida
na tela usa o array original (descendente) e mostra v18 no topo, o que
esconde a divergência: a tela mostra v18, o formulário envia v1.

Isto é exatamente o que a **correção 1** da B1 existe para impedir
("envio associado ao `document_id` exato, nunca recomputado"). A
proteção do servidor está correta — o `document_id` trafega e é
respeitado de ponta a ponta; quem escolheu o documento errado foi a tela.

### 10.2 Defeito B — v1 a v16 são PDFs inválidos no próprio Storage

Mesmo que a v18 tivesse sido anexada, a v1 continuaria quebrada. Teste de
integridade de todas as versões armazenadas:

| Versões | Criadas em | `/Length` vs. bytes reais | Descomprime | Bytes `0xFD` |
|---|---|---|---|---|
| v1–v16 | 29/09 20:08–20:19 UTC | 1199/1204 declarados vs. ~1150 reais | **falha** | ~510 cada |
| v17, v18 | 30/09 02:50 UTC | 1189 vs. 1189 | OK | 7 (normal) |

Os ~510 bytes `0xFD` por arquivo são a assinatura de bytes binários que
passaram por uma decodificação de texto: `U+FFFD` (caractere de
substituição) reduzido a um byte. A estrutura ASCII do PDF sobrevive
intacta (por isso o arquivo "abre"), mas o fluxo comprimido é destruído —
daí a página em branco.

**O divisor é o runtime, não o código.** v1–v16 foram geradas pelo script
de validação hospedada (§5), rodando em **Vitest/Node no Windows local**;
v17 e v18 foram geradas pela **interface real no Vercel**. O próprio
script afirmava `buf.equals(doc1.bytes)` — bytes baixados do Storage
idênticos aos renderizados em memória — e essa asserção **passou**. Logo
o upload foi fiel, e a corrupção já estava no `Buffer` devolvido por
`renderProposalPdf` naquele ambiente local. A geração dentro da
aplicação está correta.

### 10.3 O que a validação anterior realmente conferiu

A §7 declarou v17 e v18 legíveis. **Isso estava certo** e foi
reconfirmado agora por caminho independente: a captura preservada
(`v18.png`) mostra o visualizador aberto em `v18.pdf` com todo o
conteúdo, a `CreationDate` da v18 (`20260930025041Z` = 29/09 23:50:41
BRT) bate com o horário do arquivo de captura (23:51), e o fluxo de
conteúdo descomprime com os 26 trechos de texto esperados ("Escritório
Modelo QA B1 Ltda. (validado via UI)", "PROP-2026-0003", "R$ 1.234,00",
rodapé). O que a validação **não** conferiu — e passou a conferir só
agora — foram as 16 versões anteriores, geradas pelo script.

### 10.4 Limitação de desenho que isto expôs

`finalize_proposal_document` (correção 5) reconfere existência e
**tamanho** no Storage contra o que a própria aplicação hasheou. Isso
garante "o que gravamos é o que está lá" — e essa garantia funcionou,
inclusive para os arquivos quebrados. O que ela **não** garante é que os
bytes sejam um PDF válido: `ready` nunca significou "renderiza". Nenhuma
camada da B1 valida o PDF produzido. Candidato a correção, não feito
nesta investigação.

## 11. Correção dos dois bloqueadores do §10

### 11.1 Defeito A — versão enviada

**Reproduzido antes de corrigir.** `tests/unit/b1-proposal-send-version.test.tsx`
monta a seção de propostas com três versões prontas entregues na **ordem
real da RPC** (`version desc`: v18, v17, v1) e lê o `documentId` do
formulário que de fato seria submetido — não o que a tela exibe. Contra o
código antigo o teste falha com a mensagem exata do caso real:

```
expected '44156d85-…' (v1) to be 'e48c78fd-…' (v18)
```

**Correção** (`src/components/leads/proposals-section.tsx`): a seleção
deixou de depender de posição na lista. Em vez de `[...documents].reverse().find(...)`,
agora filtra as prontas e escolhe pela **maior `version`**. Ordenação da
RPC pode mudar sem reintroduzir o defeito — dois dos testes provam isso
entregando a lista em ordens opostas e exigindo o mesmo resultado.

**Visibilidade:** o botão passou a declarar "Enviará a v18" ao lado, e o
diálogo repete "Vai anexada a versão v18, a mais recente já gerada".
Antes, tela e formulário podiam divergir sem nada denunciar.

**Vínculo imutável preservado:** nada mudou no servidor. O `document_id`
continua viajando no formulário, sendo validado por Zod, gravado por
`queue_proposal_email` e usado por `get_proposal_document_for_download`
para buscar os bytes daquela versão exata. A correção é só de escolha —
a garantia de que o registro de envio aponta para o documento escolhido
nunca dependeu da tela.

### 11.2 Defeito B — PDF inválido

**Operação exata, comprovada.** Não é "diferença entre runtimes". O
mesmo arquivo (`pdfkit.node.mjs`) corrompe sob `jsdom` e funciona sob
`node`, e o mecanismo é este, em `_write`:

```js
_write(data) {
  if (!(data instanceof Uint8Array)) data = fromBinaryString(data + '\n');
  ...
}
```

Sob `environment: "jsdom"`, `globalThis.Uint8Array` é o construtor do
realm do jsdom, então o `Buffer` devolvido por `zlib.deflateSync` **falha
no `instanceof`** (medido: `false` sob jsdom, `true` sob node). O código
cai no desvio e faz `data + '\n'`, que invoca `Buffer.prototype.toString()`
— decodificação **UTF-8** de bytes binários. Todo byte >= 0x80 que não
forma sequência válida vira `U+FFFD`; `fromBinaryString` então aplica
`& 0xff` e grava **0xFD**. Sequências multibyte colapsam, então o fluxo
também encolhe — e o `/Length` já tinha sido escrito com o tamanho de
antes.

Reprodução isolada, com os bytes reais do início do fluxo da v18:

| | bytes |
|---|---|
| antes | `78 9c 65 8d bd 0e c2 40` |
| depois | `78 fd 65 fd fd 0e fd 40` |

Idêntico ao que está gravado nas 16 versões quebradas. ASCII intacto,
todo byte alto virando `0xFD`.

**Validação antes de `ready`** (`src/server/proposals/pdf-validate.ts`,
correção 8): `assertValidProposalPdf` roda **antes de qualquer upload**.
Confere cabeçalho e `%%EOF`, exige pelo menos uma página, e então —
o que cabeçalho/tamanho/checksum não fazem — **descomprime cada fluxo
`FlateDecode`**, recusa quando o `/Length` declarado não bate com os
bytes presentes (`pdf_fluxo_truncado`, a assinatura exata deste defeito),
extrai o texto desenhado pelos operadores `Tj`/`TJ` e exige que o
**número da proposta** esteja lá (`pdf_conteudo_essencial_ausente`). Só
`node:zlib` — nenhuma dependência nova em produção, nenhum serviço novo.

Falhou, a versão vira `failed` com o código do motivo (via
`fail_proposal_document`) em vez de ficar presa em `pending`, e **nada
sobe para o Storage**.

**Leitor independente nos testes:** `pdfjs-dist` (Mozilla, devDependency)
extrai o texto nos testes, para que a verificação não seja o nosso
parser confirmando a si mesmo. Os testes conferem o PDF gerado agora **e**
o PDF gerado pelo **build real de produção** (a v18, incluída como
fixture): ambos trazem escritório, cliente, número e valor. No arquivo
corrompido o leitor independente não acha texto nenhum.

**Ambiente dos testes de PDF:** passaram a declarar
`@vitest-environment node` — é onde a produção roda (Node, na Vercel).
Rodar no `jsdom` padrão era o que fabricava PDFs quebrados em silêncio.
Além disso, `tests/unit/b1-proposal-pdf-validate-jsdom.test.ts` roda de
propósito no jsdom e garante a invariante que interessa: **não existe PDF
ilegível e aceito** — se o ambiente corromper, o validador recusa.

**Conferência visual:** PDF gerado após a correção aberto em navegador e
conferido — cabeçalho do escritório, número, cliente, objeto, honorários
e rodapé, uma página, legível
(`praxis-crm-evidencias-b1/visual-pos-correcao.png`). O par com o anexo
corrompido (`visual-anexo-corrompido.png`, página vazia) ficou lado a
lado como evidência.

### 11.3 Versões históricas inválidas

As 16 versões quebradas **continuam no Storage e no banco, intactas**,
com os registros de envio anteriores — são a evidência do caso.

O que as torna inelegíveis para envio novo é uma revalidação no despacho:
`dispatchProposalEmailAction` roda `assertValidProposalPdf` nos bytes
baixados **antes** de chamar o provedor. PDF que não abre não é enviado,
e a linha de envio é marcada como falha (`adminFailProposalEmail`) em vez
de ficar presa em `queued` — o estado ambíguo encontrado na investigação.
Coberto por `tests/unit/b1-proposal-send-blocks-invalid-pdf.test.ts`, que
usa os bytes reais da v1 corrompida e da v18 íntegra.

**Nenhuma migration foi criada nem aplicada, e nenhum registro hospedado
foi alterado.** Essa escolha é deliberada: a revalidação no envio resolve
o risco sem tocar em dado histórico.

**Proposta, para decisão à parte** (não executada): marcar as 16 versões
como inválidas no banco faria a UI parar de oferecê-las para download e
deixaria o motivo explícito no histórico, em vez de só recusar no envio.
Exigiria uma migration nova com uma coluna de motivo em
`proposal_documents` e um `UPDATE` pontual nessas 16 linhas de
`PROP-2026-0003` na workspace de QA. Antes de qualquer execução: project
ref, `--dry-run`, lista exata de migrations e confirmação explícita,
como no `20260929123000`.

## 12. Envio validado com a versão correta (30/09/2026, 23:42)

Executado depois do CI verde no HEAD `17c1f35`, com autorização para um
único envio. Procedimento do §11 seguido na ordem, pela interface do
Preview correspondente a esse commit.

1. **Indicação na tela, antes de qualquer coisa:** a aba Propostas
   mostrava "Enviará a v18" — a versão mais recente pronta. Antes da
   correção, a tela exibia v18 no topo e o formulário levava a v1 sem
   nada denunciar.
2. **Uma única versão nova gerada** pela interface: **v19**,
   `15fd3d02-9ac8-46b4-9b25-1978d65feabd`. Virou `ready`, o que só
   acontece agora se passar por `assertValidProposalPdf`.
3. **Baixada e conferida:** 2.774 bytes, `/Length` declarado 1189 com
   1190 bytes presentes, fluxo descomprime, 7 bytes `0xFD` (ruído normal
   de binário, contra os ~510 dos arquivos quebrados), 26 trechos de
   texto. Aberta em navegador: página única, legível, sem corte, todos os
   campos corretos (`praxis-crm-evidencias-b1/visual-v19.png`).
4. **Diálogo de envio conferido antes do clique:** "Vai anexada a versão
   v19", campo oculto `documentId = 15fd3d02-…`, destinatário
   `joaoniero2@gmail.com`.
5. **Enviado uma única vez.**
6. **Registro no banco:** `proposal_email_sends` gravou
   `documentId = 15fd3d02-…` (v19), `status = accepted` — exatamente a
   versão gerada no passo 2.
7. **Painel do Resend** (`/emails/01a0f557-b872-72ac-abce-ae1d026cd6fd`):
   From `propostas@mail.collios.cloud`, To `joaoniero2@gmail.com`,
   Subject "Proposta de honorários PROP-2026-0003", anexo
   `PROP-2026-0003.pdf`, eventos `sent` e `delivered`.
8. **Anexo conferido nos bytes, não por suposição** — esta é a checagem
   que faltou no envio anterior, quando "anexo íntegro" foi afirmado só
   porque o painel listava um arquivo com o nome certo. O anexo
   armazenado no Resend tem SHA-256
   `79f4ed8470bb1806250eb02c914b61bd74419eae10b145c95d8ab7e3cf2c8a8b`,
   **idêntico** ao da v19 no Storage, e descomprime.

**Aceito pelo provedor e entregue ao servidor de destino: sim.**
**Recebido na caixa de entrada e anexo aberto: confirmado por quem
controla o endereço** (João Niero, que enviou a imagem do PDF aberto
como prova, em 01/10/2026, antes da aprovação visual do redesign). Os
dois estados seguem registrados separadamente: o primeiro vem do Resend
(`sent`/`delivered`), o segundo é declaração humana, com evidência.

Preservado como evidência: as 16 versões quebradas, a v17/v18, os
registros de envio anteriores (inclusive os cinco presos em `queued`) e o
envio em branco da v1. Nenhuma migration criada ou aplicada, nenhum
registro hospedado alterado, Production intocada.

## 13. Redesign do PDF, aprovação visual e fechamento pré-merge (01/10/2026)

### 13.1 Template final

O template de `src/server/proposals/pdf-template.tsx` foi redesenhado com
a identidade da Vizentini Advocacia e **aprovado visualmente** (amostra
longa, `PROP-2026-0102`) em 01/10/2026. Passa a ser o template final da
B1: logo oficial (`logo-vizentini-verde.png`, proporção 3,55:1 preservada),
Manrope 400/600 embutida, verde `#082B24`, bronze `#A47C56` e marfim
`#FAF9F6` — valores do código real do site, não aproximados. Marca fixa em
`pdf-theme.ts` (dívida registrada: vira dado do workspace quando houver o
segundo escritório).

- O tamanho acompanha o conteúdo: proposta curta = 1 página; objeto longo
  flui para a seguinte, sem espaço artificial e sem partir o bloco de
  honorários. Coberto por `b1-proposal-pdf-layout.test.ts`.
- Só dados existentes no CRM: nenhuma cláusula, prazo, condição de
  pagamento, contato ou assinatura.
- Rodapé informa "Documento com N páginas" (quando N > 1), aprovado
  assim. Limitação **reproduzida nesta implementação** (não uma
  conclusão geral sobre o react-pdf): com `@react-pdf/renderer` 4.9.0 e
  este template, a prop `render` não pintou nada nos testes feitos
  (string e JSX, fluxo normal e `fixed`, em `Text` e em `View`). Não se
  investigou outra versão nem outra forma de numerar; reabrir só se a
  numeração "1/N" for exigida.
- Assets embutidos em base64 (`assets-embutidos.ts`, gerado por
  `scripts/gerar-assets-proposta.mjs`): `readFileSync` com caminho
  montado em runtime não é rastreado pelo bundler e quebraria na Vercel.
- O validador (`pdf-validate.ts`) passou a ler o texto pelo `/ToUnicode`
  (`pdf-text.ts`), pois com fonte embutida os códigos do fluxo são
  índices de glifo. Continua rejeitando o PDF corrompido da v1 e exigindo
  o número da proposta; todas as correções de integridade, seleção de
  versão, permissões, armazenamento e envio seguem intactas.
- Nenhum PDF histórico foi regenerado ou sobrescrito: o redesign vale
  para versões **novas**.

Amostras aprovadas (fictícias, fora do repositório):
`praxis-crm-evidencias-b1/amostras/`.

### 13.2 Envios antigos em `queued` — análise concluída

Na proposta `PROP-2026-0003` (workspace de QA) há **cinco** envios para
`cliente.b1.qa@example.com` em `queued` ("em andamento…" na tela).

- **Origem:** a validação da fila (`queue_proposal_email`) feita com o
  Resend deliberadamente não configurado (§ "Nenhum e-mail foi enviado
  (fila fica em `queued`)"). Registrar a intenção sem despachar é o
  desenho: o status só sai de `queued` por `mark_proposal_email_accepted`
  ou `mark_proposal_email_failed`, chamados pelo despacho.
- **Sem indício de despacho (não é prova isolada):** a evidência é
  convergente — o Resend não estava configurado quando foram criados, e
  o painel do Resend (últimos 15 dias, que
  cobre todo o período da B1) não tem nenhum e-mail para esse endereço;
  os únicos para a proposta são os dois enviados a
  `joaoniero2@gmail.com`. O domínio `example.com` é reservado e não
  recebe correio.
- **Não podem ser despachados por engano:** a chave de idempotência é um
  UUID gerado a cada submissão do formulário, e nenhuma rotina, cron ou
  retry varre `queued`. Uma nova tentativa cria uma linha nova; não
  "ressuscita" as antigas. Mesmo que fossem reaproveitadas, o despacho
  revalida o PDF antes de chamar o provedor (§11.3).
- **Efeito no produto:** são ruído de histórico, sem risco. A tela mostra
  "em andamento…" para algo que nunca andou — inconsistência cosmética
  de dados de QA.
- **Decisão:** mantidas como evidência, **sem alteração**. Se quiserem
  limpar, a via é `mark_proposal_email_failed` com um código como
  `qa_abandonado` por RPC, com dry-run e confirmação — não feito aqui.
- **Item correlato:** a v14 da mesma proposta ficou em `pending`
  ("Gerando…") por uma geração interrompida antes de existir a rotina de
  falha. Não é elegível para envio (só `ready` é) e permanece preservada.

### 13.3 Resíduos conhecidos e limitação operacional

**Resíduos de QA, preservados de propósito** (nada foi alterado):

- cinco envios em `queued` para `cliente.b1.qa@example.com` (§13.2);
- a v14 de `PROP-2026-0003` em `pending` ("Gerando…");
- as 16 versões históricas inválidas (v1–v16, §11.3).

Nenhum dos três afeta o uso: só versão `ready` é oferecida ao envio, e
`queued` não é retomado por ninguém.

**Limitação operacional (vale para Production também).** Uma interrupção
real — função serverless morta por timeout, queda de rede, deploy no meio
da requisição — pode deixar:

1. **geração em `pending`**: a linha existe, o PDF talvez nem tenha subido
   ao Storage. Não bloqueia nada. Como investigar: ver o status e
   `created_at` da linha em `proposal_documents` e se há objeto no
   Storage no `storage_path`. Remédio: **gerar uma versão nova**; a
   pendente fica como histórico (marcá-la como falha exige RPC com
   confirmação, não é necessário).
2. **envio em `queued`**: este é o caso delicado, porque a linha é criada
   **antes** de chamar o Resend. `queued` significa "não sei", não
   "não enviou": se a função morreu depois de o provedor aceitar e antes
   de gravar `accepted`, **o e-mail pode ter saído**. Nunca reenviar às
   cegas. Investigar nesta ordem:
   1. ler a linha (`to_email`, `document_id`, `created_at`,
      `idempotency_key`) pela timeline/lista do envio;
   2. procurar no painel do Resend, pelo destinatário e pela janela de
      horário, um e-mail com o assunto da proposta; conferir se o anexo
      é o `document_id` da linha (SHA-256, como no §12);
   3. **achou, com evidência de que é este envio** (destinatário,
      assunto, horário compatível e anexo com o SHA-256 do `document_id`
      da linha): o envio aconteceu; registrar como aceito com o id do
      provedor (`mark_proposal_email_accepted`, por RPC, com confirmação)
      e **não reenviar**;
   4. **não achou: isso, sozinho, não prova que falhou.** O painel tem
      janela de retenção e filtros, o evento pode demorar a aparecer, a
      busca pode estar no ambiente/chave errados, e uma chamada que
      morreu no meio é exatamente o caso em que o provedor aceitou e nós
      não registramos. Só vale como "não enviado" com **evidência
      positiva** — por exemplo, o log da execução mostrando que a função
      terminou antes de chamar o provedor, ou o provedor confirmando por
      outro canal que não há mensagem com aquela `Idempotency-Key`.
      **Sem evidência suficiente, o resultado permanece
      indeterminado**: a linha continua `queued`, nada é marcado como
      falha e **não há reenvio automático** — qualquer novo envio é uma
      decisão humana explícita, assumindo o risco de duplicidade.
   Defesas existentes: a `idempotency_key` também vai ao Resend, que a
   honra por 24 h, e a mesma submissão repetida não chama o provedor duas
   vezes. Não existe cron de reconciliação nesta fase — é uma lacuna
   conhecida e aceita para o piloto, não um defeito escondido.

### 13.4 Banco: Preview e Production no mesmo Supabase

Preview e Production usam, temporariamente, o mesmo projeto
`praxis-crm-dev` (ref `rgoeppjwnltcbeqipovh`). As oito migrations B1 já
estão nele. Conferido em 01/10/2026 **somente por leitura**
(`supabase migration list --linked`): todas as migrations locais
aparecem também no remoto, incluindo `20260929115900`, `…120000`,
`…120100`, `…120200`, `…120300`, `…120400`, `…120500` e `…123000`.
**Não há migration pendente.** Nenhum `db push` foi executado.

Consequência a ter em mente: um envio ou uma geração feita em Production
grava no mesmo banco que o QA. Isso muda quando Production ganhar projeto
próprio — nesse momento as oito migrations precisarão ser aplicadas lá
(com ref, `--dry-run` e confirmação).

### 13.5 Template final validado no Preview do HEAD atual

Até aqui o template com logo e fontes só tinha sido validado localmente
(a v19 é do template antigo). O Preview do HEAD `fbe965e` (deploy
`Preview`, `sha` conferido) gerou, pela interface, **uma única versão
de QA: v20**, `ebb8a95a-ae92-437a-ade1-a4f57d59c995`, `ready`.

- baixada pelo endpoint do app: 21.167 bytes, `application/pdf`, SHA-256
  `5c2d2ee499bc6966226e5ea6b7fef4fa23f0e78bfc1a6efa2d2a7ddde3831956`;
- leitor independente (pdfjs): 1 página, 1 imagem (o logo), texto
  completo e acentuado, fontes embutidas `Manrope-Regular` e
  `Manrope-SemiBold`;
- aberta no navegador e comparada com a amostra curta aprovada: logo,
  tipografia, cores, margens, bloco de honorários e rodapé idênticos;
- **nenhum e-mail enviado**, nenhuma versão antiga tocada.

Evidência: `praxis-crm-evidencias-b1/v20-redesign-preview.pdf` e
`v20-preview-pagina1.png`. É uma proposta de uma página; a quebra em
duas páginas é coberta pela amostra longa aprovada e por
`b1-proposal-pdf-layout.test.ts`, e não foi repetida no hospedado.

### 13.6 Production: configuração do Resend (EXECUTADA em 01/10/2026)

Autorizada pelo João Niero. Até então Production não tinha
`RESEND_API_KEY` nem `RESEND_FROM_EMAIL` (conferido pelos nomes; valores
nunca lidos). **Criado:** a chave `praxis-crm-production` no Resend (só
envio, restrita a `mail.collios.cloud`) e as duas variáveis **somente no
ambiente Production** da Vercel. **Sem redeploy de Production, sem
e-mail enviado, sem merge:** as variáveis só valem no próximo deploy.

O remetente `propostas@mail.collios.cloud` está confirmado
**temporariamente, para testes controlados**. O remetente definitivo
para clientes será definido com a Vizentini antes do uso real, e dados
reais do escritório não foram preenchidos.

O texto abaixo é o plano que foi autorizado e executado.

**O que foi criado, exatamente:**

| Onde | O quê | Detalhe |
|---|---|---|
| Resend | 1 API key nova `praxis-crm-production` | permissão **só envio**, restrita ao domínio `mail.collios.cloud` |
| Vercel (`praxis-crm`) | `RESEND_API_KEY` no ambiente **Production** | tipo sensível; valor vai da área de transferência ao `vercel env add`, nunca impresso nem gravado |
| Vercel (`praxis-crm`) | `RESEND_FROM_EMAIL` no ambiente **Production** | `propostas@mail.collios.cloud` (mesmo remetente do Preview) |

**Como o que existe é preservado:**

- **SMTP do Auth:** não é tocado. A chave e a configuração SMTP do
  Supabase Auth ficam como estão; a chave nova é outra credencial, criada
  só para a aplicação. Nada se edita no painel de Auth do Supabase.
- **Preview:** as variáveis do Preview são escopadas à branch
  `feat/b1-proposals-pdf`. Adicionar variáveis ao ambiente Production não
  as altera. Conferência: `vercel env ls` antes e depois, comparando os
  nomes e escopos do Preview.
- **Chave do Preview:** não é rotacionada nem reutilizada em Production,
  para poder revogar uma sem afetar a outra.
- Nenhuma conta nova no Resend, nenhuma alteração de DNS.

**Ordem e efeito:** variáveis de ambiente só valem para deploys
posteriores. Production só ganha o código da B1 no deploy do merge; ele
já sairá com as variáveis. Configurar antes do merge não afeta o
Production atual (o código da `main` não as usa).

**Antes de usar de verdade (não é configuração, é decisão):**
`legal_name` e demais dados do escritório preenchidos no workspace real
(`queue_proposal_email` exige `legal_name`); e confirmar que os e-mails
às clientes devem sair de `propostas@mail.collios.cloud` (domínio da
Colli OS) — mudar de remetente é só trocar `RESEND_FROM_EMAIL`, mas o
domínio precisa estar verificado no Resend. Smoke test pós-merge: um
único envio a endereço controlado, repetindo as conferências do §12.

Fora de escopo, sem mudança: B2, merge, DNS, rotação de chaves.
