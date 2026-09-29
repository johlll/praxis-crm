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
