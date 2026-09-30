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

## 2. Desenho revisado (sete correções sobre a primeira proposta)

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
simultâneas da mesma proposta nunca colidem); a aplicação gera o PDF e
sobe para o Storage (`upsert: false`, nunca sobrescreve um objeto
existente); `finalize_proposal_document` só confirma `status='ready'`
depois de reconferir, lendo `storage.objects` na mesma base Postgres, que
o arquivo existe com o tamanho esperado. Qualquer falha em qualquer passo
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
