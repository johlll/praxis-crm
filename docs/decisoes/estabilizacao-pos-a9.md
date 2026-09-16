# Estabilização pós-A9 — inventário de defeitos conhecidos

Rodada pedida antes do merge do PR #13: encerrar os defeitos conhecidos das
funcionalidades já implementadas (A1–A9), sem iniciar a A10 e sem antecipar
funcionalidades de fases futuras.

**Fonte do inventário:** seções de riscos/limitações/pendências de
`A1-HANDOFF.md` a `A9-HANDOFF.md` e `docs/decisoes/*.md`, conferidas uma a
uma contra o código da branch `feat/a9-perfil-360` no commit `2a7e5bd`.
Na conferência apareceram ocorrências do mesmo defeito que nenhum handoff
registrava — entram aqui também (seção 1), porque são o mesmo defeito em
funcionalidade já entregue.

**Método por defeito:** teste que falha antes da correção → correção da
causa → revisão dos demais consumidores → teste passando → revisão do diff.
As evidências de cada defeito estão na seção 7.

## 0. Itens dos handoffs que NÃO são defeitos (ficam no cronograma)

Conferidos e mantidos fora desta rodada, por serem escopo planejado ou
decisão registrada — não comportamento incorreto do que foi entregue:

| Origem | Item | Por que não é defeito |
|---|---|---|
| A1 §7 | TypeScript 6, `next-env.d.ts` reescrito pelo build, fontes via `next/font` | Riscos de manutenção, sem comportamento incorreto |
| A1 §7.3 | Fidelidade visual só a 1440×900 | Verificação visual de breakpoints, não falha funcional |
| A2 §7.2/7.3 | Sem reset de senha; `workspaces.rename` sem tela | Funcionalidades não pedidas |
| A2 §7.4 | `retries: 0` no Playwright | Decisão deliberada |
| A3 dup. | Detecção varre o workspace a cada escrita | Limite de volume aceito; job assíncrono é fase futura |
| A5 §4 | Sem tela de configuração completa, destaque "parada há N dias", paginação horizontal do kanban | Funcionalidades do protótipo ainda não construídas |
| A6 §9 | Sem navegação de semana, seletor sem busca, tipos fixos, Google/WhatsApp real | Escopo de fases futuras |
| A7 §9 | Busca livre de contato, candidatos de oportunidade não persistidos, `purpose_code` só WhatsApp, sem mídia | Escopo de fases futuras / decisão registrada |
| A8 §8 | "Cliente desde", origem pelo primeiro handoff, atribuição (A11), `win_opportunity` reaproveitando cliente encerrado | Semântica documentada e aceita; atribuição é A11 |

## 1. Falha operacional de consulta vira "vazio", "não encontrado" ou "sem acesso"

**Comportamento incorreto (comum a todos os itens abaixo):** a função lê
`{ data, error }` do Supabase e, se `error` vier preenchido (rede, timeout,
Postgres indisponível, erro inesperado da RPC), devolve `null`/`[]`/contagem
zero ou simplesmente ignora `error`. A tela então mostra "não encontrado"
(404), "nenhum item", pipeline vazio, paginação encerrada ou "sem acesso",
em vez de um erro com opção de tentar novamente.

**Cenário que reproduz (comum):** a RPC/consulta responde com erro
operacional (simulado em teste unitário pelo cliente Supabase devolvendo
`{ data: null, error: { message: "..." } }`).

**Teste e critério de conclusão (comum):** para cada função, um teste
unitário com erro operacional simulado que falha hoje (a função devolve
vazio/nulo) e passa depois (a função lança erro de carregamento). Para as
funções com "não encontrado" legítimo, um segundo teste garante que os
códigos da própria RPC (`*_not_found`, `insufficient_permission`) continuam
virando `null`. Consumidores revisados: páginas, `generateMetadata`,
componentes e Server Actions — Server Actions devolvem erro sanitizado ao
cliente; páginas caem no `error.tsx` com "Tentar novamente".

| # | Função | Retorno atual na falha | Telas/consumidores afetados | Origem |
|---|---|---|---|---|
| 1.1 | `getOpportunity` | `null` → 404 | `/oportunidades/[id]` (página + metadados), Perfil 360 (painel da oportunidade) | A9 §8 |
| 1.2 | `listActivities` | lista vazia, total 0 | `/atividades` (Central), `/oportunidades/[id]`, Perfil 360 (pendentes da oportunidade) | A9 §8 |
| 1.3 | `getStageRequirementsStatus` | `[]` = "nenhum requisito pendente" → avanço direto sem o diálogo | `checkStageRequirementsAction` → kanban e `StageMoveControl` | pedido §2 |
| 1.4 | `getWinRequirementsStatus` | `[]` = "nenhum requisito pendente" | `getWinRequirementsAction` → `WonDialog` | pedido §2 |
| 1.5 | `getActivityCounts` | contagens zero | badge de atrasadas da sidebar (`(app)/layout.tsx`) | inventário |
| 1.6 | `getActivity` | `null` | sem consumidor hoje | inventário |
| 1.7 | `getPipelineBoard` | `[]` → kanban vazio | `/pipeline` | inventário |
| 1.8 | `listOpportunities` | lista vazia | `/pipeline` (tabela), Perfil 360, `/conversas/[id]` | inventário |
| 1.9 | `getDefaultPipeline`, `listPipelines`, `listPipelineStages`, `listPipelineStagesWithDetails`, `listLostReasons` | `null`/`[]` (erro ignorado) | `/pipeline`, `/configuracoes/pipelines`, Perfil 360, `LostDialog` (`listLostReasonsAction`) | inventário |
| 1.10 | `getLeadDetail` | `null` → 404 | `/leads/[id]` (página + metadados) | inventário |
| 1.11 | `listLeads`, `listContactOptions` | lista vazia | `/leads`, `/leads/novo`, `/atividades`, `/agenda` | inventário |
| 1.12 | `getConversation`, `listWhatsAppChannels`, `listContactConsents` | `null` → 404 / `[]` (consentimento "ausente") | `/conversas/[id]`, `/configuracoes/simulador-whatsapp` | inventário |
| 1.13 | `listContacts`, `getContactDetail`, `getDuplicateCandidateDetail`, `listContactMergeHistory`, `listPendingDuplicateCandidates`, `searchContactsByCpfCnpj` | vazio/`null` → 404 | `/contatos`, `/contatos/[id]`, `/contatos/duplicidades`, `/contatos/duplicidades/[id]`, `SensitiveField` | inventário |
| 1.14 | `listTeamMembers`, `listPendingInvitations` | lista vazia | `/configuracoes/equipe` e seletores de responsável em 8 telas | inventário |
| 1.15 | `listMyWorkspaces`, `getActiveWorkspaceId`, `switchActiveWorkspace`, `requireMembership` | "sem workspace"/"não é membro" → onboarding ou acesso negado | login, onboarding, troca de workspace, toda Server Action com permissão | inventário |
| 1.16 | `getShellContext` (perfil do usuário) | erro ignorado → nome "Usuário" | topbar de todas as telas autenticadas | inventário |
| 1.17 | `requireUser`, `requireUserOrRedirect`, `requireMembershipOrRedirect`, `signInAction`, `createWorkspaceAction`, `acceptInvitationAction`, `switchWorkspaceAction` | falha de rede do Auth ou da consulta de membership → redireciona para `/entrar` ou `/onboarding` | todas as páginas autenticadas, login, onboarding, convite, troca de workspace | inventário |
| 1.18 | `requirePermissionSafe` (9 cópias divergentes, uma por módulo de actions) | só trata `AuthzError`; com 1.15 corrigido, falha de membership viraria exceção sem tratamento nas actions chamadas por componentes | todas as Server Actions com estado | A3-HANDOFF §9 (helper compartilhado proposto e nunca extraído) |
| 1.19 | `signInAction` (erro de `signInWithPassword`) | qualquer erro do Auth (rede, 5xx, resposta ilegível, limite de tentativas, e-mail não confirmado) vira "E-mail ou senha incorretos" — a pessoa redigita a senha certa enquanto o serviço está fora | `/entrar`, `/convite/[token]` (login antes do aceite) | revisão final da estabilização |

### 1b. Primeira página tratada como lista completa

**Comportamento incorreto:** a tela busca só a primeira página (20 itens,
ou o teto de 1.000 linhas do PostgREST) e usa o resultado como se fosse a
lista inteira, sem paginação nem aviso. Acima do limite, itens reais
somem da tela.

**Cenário:** workspace/lead com mais itens que o limite da consulta.

**Teste e critério:** teste unitário com a RPC devolvendo total maior que
a página — a função de "todos" busca as páginas seguintes até o total, e
lança erro se uma página falhar ou vier incompleta (mesma regra de
`listAllActivities`). Tabela do pipeline com paginação navegável.

| # | Onde | Limite | Efeito acima do limite | Origem |
|---|---|---|---|---|
| 1b.1 | Seletor de lead do "Nova atividade" em `/atividades` e `/agenda` (`listLeads` página 1) | 20 leads ativos | Não dá para criar atividade para o 21º lead em diante | inventário |
| 1b.2 | `/pipeline?view=tabela` (`listOpportunities` página 1, sem paginação) | 20 oportunidades | Tabela para na 20ª; subtítulo chama de "abertas" um total que inclui ganhas/perdidas | inventário |
| 1b.3 | Perfil 360 (`listOpportunities(leadId)` página 1) | 20 oportunidades do lead | Oportunidade ativa, "Ver cliente" e a lista de oportunidades ignoram as demais | inventário |
| 1b.4 | `/conversas/[id]` (oportunidades abertas do lead, página 1) | 20 | Resolução de vínculo não oferece as demais | inventário |
| 1b.5 | `/leads/novo` (`listContactOptions`, sem paginação) | 1.000 contatos (`max_rows` do PostgREST) | Contatos além do milésimo não aparecem no seletor | inventário |
| 1b.6 | `/oportunidades/[id]` (atividades pendentes, `listActivities` página 1, seção sem paginação) | 20 pendentes | Pendentes além da 20ª não aparecem no painel da oportunidade | inventário |

**Fora deste defeito (já corretos, só adaptados ao contrato comum):**
`listAllActivities`, `listActivitiesPageOrThrow`, `getLastCompletedMeeting`,
`listClients`, `getClient`, `getConflictCheck`, `listConversations`,
`listConversationMessages`, `listProposalsForLead`, `getLeadTimelinePage`.

## 2. "Tentar novamente" não refaz a busca

**Comportamento incorreto:** os seis `error.tsx` existentes (`agenda`,
`clientes`, `clientes/[id]`, `conversas`, `conversas/[id]`, `leads`) chamam
`reset()`. No Next.js 16.3 (`node_modules/next/dist/docs/.../error.md`),
`reset()` limpa o estado e re-renderiza **sem buscar de novo** no servidor;
quem refaz a busca é `retry()`. Depois de uma falha transitória, o botão
não recupera a tela.

**Funções/telas:** todos os `error.tsx` acima. Além disso, não existe
`error.tsx` para `/atividades`, `/pipeline`, `/oportunidades/[id]`,
`/contatos/**`, `/configuracoes/**`, `/visao-geral` nem para falhas no
`(app)/layout.tsx` — com o item 1 corrigido, uma falha nessas rotas cairia
na tela genérica do Next.js, sem "Tentar novamente".

**Cenário:** falha operacional numa página com `error.tsx` → clicar em
"Tentar novamente" com o banco já recuperado.

**Teste e critério:** teste de componente garantindo que o botão chama
`retry` (não `reset`) em todos os `error.tsx`; cobertura de limite de erro
para todas as rotas autenticadas e para o layout.

## 3. Ações sem canal de erro falham em silêncio

**Comportamento incorreto:** actions "void" descartam o `error` do RPC e
não têm canal de retorno — uma recusa real (ex.: rebaixar ou remover o
último owner, telefone inválido, remover o único e-mail) ou uma falha
operacional não mostra nada, e a tela parece ter aceitado.

| # | Actions | Tela | Origem |
|---|---|---|---|
| 3.1 | `cancelInvitationAction`, `updateMembershipRoleAction`, `removeMembershipAction` (permissão negada ainda lança exceção crua); `createInvitationAction` (exceção crua sem permissão) | `/configuracoes/equipe` (`member-row.tsx`, `pending-invitation-row.tsx`) | A3-HANDOFF §9 (registrado, nunca corrigido) |
| 3.2 | `addPhoneAction`, `updatePhoneAction`, `removePhoneAction`, `addEmailAction`, `updateEmailAction`, `removeEmailAction`, `clearCpfCnpjAction`, `dismissDuplicateCandidateAction` | `/contatos/[id]`, `/contatos/duplicidades` | inventário (A3 corrigiu só a propagação de permissão, não o erro do RPC) |

**Cenário:** RPC `remove_membership`/`update_membership_role`/
`cancel_workspace_invitation` responde erro.

**Teste e critério:** teste unitário da action com RPC em erro → devolve
`{ ok: false, error }` sanitizado; permissão negada → `{ ok: false }`, não
exceção; componente exibe o erro.

## 4. Numeração de proposta não é segura para concorrência

**Comportamento incorreto:** `create_proposal()` calcula o número com
`count(*) + 1` sobre as propostas do workspace no ano. Duas chamadas
simultâneas leem a mesma contagem, montam o mesmo número e a segunda falha
com violação de `proposals_workspace_id_number_key` — o usuário recebe erro
numa criação legítima.

**Função/tela:** `public.create_proposal` (migration `20260913100100`);
aba Propostas do Perfil 360.

**Origem:** A9-HANDOFF §8.

**Cenário:** N chamadas `create_proposal` simultâneas, em conexões
independentes, para o mesmo workspace; em paralelo, chamadas para outro
workspace.

**Teste e critério:** script de concorrência real no CI (clientes Supabase
independentes, `Promise.all`), que falha antes da correção (colisão) e
passa depois: todas as chamadas legítimas criam propostas com números
distintos, cada workspace com sua própria série, números já emitidos
preservados, unicidade mantida. Lacunas permitidas.

## 5. Validação de papéis no ambiente hospedado

**Pendência:** A9-HANDOFF §7 — a máscara da nota de conflito para
atendimento/visualizador e as projeções financeiras não foram conferidas em
`praxis-crm-dev` com contas desses papéis, nem pela resposta de rede.

**Critério:** owner, atendimento e visualizador em `praxis-crm-dev`, com
dados fictícios; nota de conflito e valores conferidos na resposta real
recebida pelo navegador e na tela. Sem conta de QA para algum papel, a
pendência fica aberta com o acesso exato necessário.

## 5b. Formulário de edição volta a mostrar o valor anterior depois de salvar

**Origem:** risco registrado em A4-HANDOFF §5.6 (e repetido em A5/A6) para
o `AssignLeadForm`, marcado como "não falhou". **Reproduzido nesta rodada
no ambiente hospedado:** atribuir responsável num lead fictício salvou no
banco, mas o seletor voltou a "Sem responsável" até recarregar a página. O
mesmo sintoma já tinha aparecido no `ConflictCheckPanel` durante a
validação da A9 (status salvo "Sem conflito", seletor em "Não verificado").

**Comportamento incorreto:** `<form action>` faz o React 19 chamar
`form.reset()` ao fim do envio. Campos não controlados voltam aos valores da
montagem, e `<select>` controlado também volta (o React não restaura porque
o estado não mudou — por isso o `LeadBasicFieldsForm`, corrigido na A4 com
campos controlados, ainda perdia a prioridade). A tela passa a mostrar um
dado que não é o salvo.

**Funções/telas:** `AssignLeadForm` e `LeadBasicFieldsForm` (prioridade) (`/leads/[id]`), `ConflictCheckPanel`
(`/leads/[id]`), `ClientStatusForm` e `TransferClientOwnerForm`
(`/clientes/[id]`), `ContactBasicFieldsForm` (`/contatos/[id]`). Diálogos
que remontam a cada abertura e formulários de criação não são afetados.

**Teste e critério:** teste de componente que escolhe um valor novo, envia
com sucesso e confere que o campo continua com o valor salvo — falha antes
nos seis. Correção: formulários de edição enviados por `onSubmit` numa
transição (`EditForm`), sem o reset automático, com campos controlados.

## 5c. Edição durante a hidratação corrompe o dado

**Origem:** achado ao investigar a falha de CI de §7.3, que eu havia
registrado como "corrida do teste, sem perda de dado". Estava errado —
reproduzido no ambiente hospedado com uma digitação real.

**Comportamento incorreto:** enquanto a página não hidrata, o campo é HTML
do servidor. Se alguém digita nesse intervalo (conexão ruim, aparelho
lento), o texto digitado fica **concatenado** ao valor que veio do
servidor. Não é só exibição.

**Reprodução (preview, scripts presos e liberados no meio da digitação):**

| Onde | Valor |
|---|---|
| Pretendido | `QA digitado durante a hidratacao` |
| Na tela | `QA pre-hidratacaoQA digitado durante a hidratacao` |
| Payload do Server Action (campo `summary`) | o mesmo texto concatenado |
| Gravado em `leads.summary` | o mesmo texto concatenado |

**Funções/telas:** `EditForm` e seus seis consumidores — `AssignLeadForm`,
`LeadBasicFieldsForm`, `ConflictCheckPanel` (`/leads/[id]`),
`ClientStatusForm`, `TransferClientOwnerForm` (`/clientes/[id]`),
`ContactBasicFieldsForm` (`/contatos/[id]`).

**Correção:** o `EditForm` envolve os campos num `<fieldset disabled>` que
já vem assim no HTML do servidor e só é liberado depois que o componente
monta no navegador (`useSyncExternalStore`, sem efeito nem atraso fixo, sem
depender de detalhe interno do React). Antes da hidratação não há nada
nosso rodando no navegador, então a proteção precisa vir do próprio HTML.
`display: contents` preserva o layout; o botão de enviar também fica
desabilitado, o que é correto — este formulário envia por JavaScript.

**Teste e critério:** `stabilization-pre-hidratacao.test.tsx` — o HTML
renderizado no servidor já contém `<fieldset disabled>` (2 de 4 casos
falhavam antes), e depois de montado a edição é liberada com o valor do
servidor preservado. E2e `leads.spec.ts` "2b": os scripts ficam presos, a
digitação nessa janela é recusada, o campo mantém o valor do servidor e,
liberada a hidratação, o texto digitado é salvo sem concatenação.

## 6. Pendências externas conhecidas (fora do código)

| Origem | Item | Situação |
|---|---|---|
| A2 §7.5 | Site URL / Redirect URLs do Auth em `praxis-crm-dev` apontando para `localhost:3000` | **Resolvida — a configuração já tinha sido corrigida; nenhum ajuste manual necessário.** Ver §6.1 e §7.2 |
| A2 §7 | Provedor de e-mail padrão do Supabase (limite de envio, modelos bloqueados) | **Resolvida nesta rodada, com autorização:** SMTP próprio no Resend (`mail.collios.cloud`), limite de 2 → 30 e-mails/h, modelo de confirmação personalizado. Detalhes e evidências em §7.2 |

### 6.1 Confirmação de e-mail do cadastro não funcionava com o link real

**Comportamento incorreto:** o cliente do servidor usa o fluxo PKCE do
`@supabase/ssr` (o cadastro grava o cookie `code-verifier`). Com o modelo de
e-mail padrão do Supabase — o que está em uso no `praxis-crm-dev` — o link
passa por `/auth/v1/verify` e volta para `/auth/confirm?code=…`. A rota só
tratava `?token_hash=&type=` e mandava todo o resto para
`/entrar?erro=confirmacao_invalida`; a tela de login ignorava esse
parâmetro. Resultado: o e-mail ficava confirmado, mas a pessoa caía no
login sem sessão e sem nenhum aviso. Nunca apareceu antes porque as contas
de QA das fases anteriores foram confirmadas por SQL.

**Funções/telas:** `src/app/auth/confirm/route.ts`, `src/app/entrar/page.tsx`.

**Teste e critério:** `stabilization-auth-confirm.test.tsx` — `?code=` troca
o código pela sessão e segue para o onboarding; código recusado volta ao
login com o erro; `token_hash` continua funcionando; `/entrar` mostra o
aviso. No hospedado: cadastro pelo app, link real do e-mail aberto no mesmo
navegador, destino e sessão acompanhados.

### 6.2 Confirmação de e-mail dependia do prazo curto do fluxo PKCE — RESOLVIDA

**Comportamento incorreto (execução hospedada):** mesmo com §6.1 corrigido,
o link do modelo de e-mail padrão passava por `/auth/v1/verify` e voltava
como `/auth/confirm?code=`, dependendo do registro PKCE criado no cadastro
e do cookie gravado naquele navegador.

**Dois prazos distintos, que não podem ser confundidos:**
- **validade do link/token do e-mail** — `mailer_otp_exp` = 3600 s (lido na
  configuração hospedada). Foi o que expirou nos dois primeiros links de QA,
  com `otp_expired` devolvido pelo próprio Auth. Evidência direta;
- **validade do código PKCE** — prazo próprio do registro de fluxo. O
  código-fonte do Supabase Auth (`internal/models/flow_state.go`,
  `IsExpired`, com `defaultFlowStateExpiryDuration = 300 s`) conta a partir
  da criação para `email/signup`. É a **explicação mais provável** da falha
  do visualizador aos 13 minutos (atendimento, aos 4 minutos, funcionou),
  **não confirmada**: não foi isolada da hipótese de o verificador do
  navegador não bater.

**Correção aplicada (fora do código):** SMTP próprio (Resend) e modelo de
confirmação apontando direto para a rota, com `token_hash` — sem PKCE, valendo
o prazo do token e em qualquer navegador. Ver §7.2. O destino usa
`{{ if .RedirectTo }}…{{ else }}{{ .SiteURL }}/auth/confirm{{ end }}`, para o
cadastro feito no preview confirmar no preview, e não em produção.

### 6.3 Falha do link tratada como "conta não confirmada"

**Comportamento incorreto:** `/auth/confirm` mandava todo insucesso para a
mesma mensagem, que pedia cadastro novo. São três coisas diferentes:
- **falha do link** (`?error=`, ou `verifyOtp` recusado): aquele link não
  vale mais — expirou, já foi usado, ou foi consumido por outra aba. **Não
  demonstra** que a conta esteja sem confirmação: um link já usado de conta
  confirmada dá exatamente o mesmo erro;
- **estado da conta**: só o login (ou o banco) responde isso;
- **abertura da sessão**: quando o `verify` já confirmou o e-mail e só o
  código não virou sessão, a conta **está** confirmada e basta entrar.

**Correção:** destinos separados (`erro=link_invalido` e
`erro=sessao_nao_criada`) com textos próprios. O caminho oferecido é o que
existe na interface — o formulário "Criar conta" com o mesmo e-mail reenvia
a confirmação, mantém a conta e preserva a senha (comprovado no hospedado:
o cadastro repetido de `+praxisqaatend0915` disparou e-mail novo, manteve
`created_at` e **não** trocou a senha). Nenhuma mensagem promete ação que
não exista na tela.

**Teste:** `stabilization-auth-confirm.test.tsx` — 9 casos cobrindo os três
desfechos, os dois formatos de link e o texto dos avisos.

## 7. Evidências

Três tipos de evidência, nunca somados: **leitura de código** (análise sem
execução — aparece como tal, ex.: §1b), **teste automatizado** (local ou
CI) e **execução hospedada** (preview + `praxis-crm-dev`, com o que foi
observado). Legenda de onde cada verificação rodou: **local** = `npm test`/`typecheck`/
`lint`/`build` nesta máquina; **CI** = GitHub Actions com Supabase local
efêmero (pgTAP, isolamento, concorrência, e2e, atualização); **rede** =
resposta real recebida pelo navegador (payload RSC); **hospedado** =
`praxis-crm-dev` pelo preview da Vercel ou consulta somente leitura ao banco.

| Defeito | Teste que falhava antes | Correção (commit) | Depois |
|---|---|---|---|
| §1 falha de consulta vira vazio/nulo (1.1–1.16) | `stabilization-query-errors.test.ts`: **36 de 45 falhavam** (local), incluindo as consultas secundárias de etapas/contato | `1eaf2c7` | 45/45 local; CI verde a partir do `d49fcd1` (o run de `8c0cae4`, enviado junto, falhou no pgTAP por outro motivo — ver §4) |
| §1.3/1.4/1.9 requisitos e motivos de perda como "nenhum pendente" | `stabilization-requirement-actions.test.ts`: **12 de 12 falhavam** (local) | `1eaf2c7` | 12/12 local. Hospedado: diálogo de ganho carrega o requisito obrigatório pendente e bloqueia o registro; diálogo de perda carrega os 5 motivos |
| §1.17 falha de rede/membership → login ou onboarding; §1.18 helper de permissão divergente; §3 actions sem canal de erro | `stabilization-actions.test.ts`: **18 de 23 falhavam** (local) — as 5 que já passavam cobrem comportamento legítimo preservado (sessão ausente → login, sem membership → onboarding, permissão negada) | `1eaf2c7` | 23/23 local. Hospedado: telefone inválido num contato fictício mostra "Telefone inválido." e nada é salvo (antes: nenhuma resposta) |
| §1b listas incompletas | Consultas "todos" (`listAllLeads`, `listAllOpportunities`, `listContactOptions` em blocos) testadas com 250/130/1.234 itens e página intermediária falhando. **Ressalva:** esses testes foram escritos junto com as funções novas, então não houve execução falhando antes; o defeito foi comprovado pela leitura das telas (página 1 usada como lista inteira) | `1eaf2c7` | `stabilization-volume-and-retry.test.tsx` 15/15 local. Hospedado: tabela do pipeline com subtítulo correto ("12 oportunidades"); seletor da Central com os 16 leads ativos (volume abaixo do limite, só confirma o fluxo) |
| §2 "Tentar novamente" não refazia a busca; rotas sem limite de erro | Mesmo arquivo: **8 de 13 falhavam** (local) — `reset` em 6 arquivos, sem `(app)/error.tsx` e `error.tsx` raiz | `1eaf2c7` | 15/15 local. Falha operacional não foi induzida no hospedado (exigiria derrubar o banco compartilhado) |
| §4 colisão de numeração e truncamento acima de 9999 | **CI vermelho** no `dcccb1a` (run 34926781096): 3 de 12 e 2 de 6 criações simultâneas falharam com `duplicate key ... proposals_workspace_id_number_key` | `8c0cae4`, `d49fcd1` (contador em `public` com RLS forçada, exigido por `04_security_hardening`) | CI verde (run 34943271823 e seguintes): 12+6 simultâneas sem erro e sem repetição; pgTAP `15_proposal_number_counter` 7/7 (contador atrasado, 10000/10001, séries por workspace, sem privilégio); atualização a partir da versão anterior com dados (`check-upgrade-proposal-counter.sh`) OK. **Hospedado:** migration aplicada após dry-run (só ela); backfill iniciou o contador em 2 (= maior emitido); proposta criada no preview recebeu `PROP-2026-0003`; `0001`/`0002` intactos, nenhum repetido |
| §1.19 login transforma falha do serviço em "senha incorreta" | `stabilization-sign-in-errors.test.ts`: **7 de 9 falhavam** (local) — as 2 que passavam cobrem o que deve ser preservado (login certo redireciona; nenhuma mensagem revela conta) | `bd3adb5` (decisão por `AuthApiError.code`/`AuthRetryableFetchError`, nunca pelo texto) | 9/9 local; CI verde (run 35007839495). **Hospedado:** conta inexistente → "E-mail ou senha incorretos."; conta não confirmada com senha errada → a mesma mensagem; com a senha certa → "Confirme seu e-mail…" (o Auth só devolve `email_not_confirmed` depois de aceitar a senha, então nada revela a existência da conta). Falha do serviço não foi induzida no hospedado (coberta pelos testes com 503, rede e resposta ilegível) |
| §6.1 confirmação de e-mail com link PKCE | `stabilization-auth-confirm.test.tsx`: **2 de 6 falhavam** (local) — `?code=` e o aviso em `/entrar` | `057fcf9` | 6/6 local; CI verde (run 35008591726). **Hospedado:** ver §7.2 |
| §6.3 falha do link tratada como "conta não confirmada" | `stabilization-auth-confirm.test.tsx` reescrito: **6 de 9 falhavam** (local), depois mais 1 ao apertar o texto do aviso | `e23a500`, `914a1c9`, `f9f8ae2` | 9/9 local. **Hospedado:** link reutilizado devolve o aviso de link inválido enquanto a conta **está** confirmada — exatamente o caso que a mensagem antiga descrevia errado |
| §5c edição durante a hidratação concatena o valor do servidor | Reproduzido no **hospedado** (tela, payload e banco com o texto concatenado) e no unitário: `stabilization-pre-hidratacao.test.tsx` **2 de 4 falhavam** | (commit abaixo) | 4/4 local + e2e "2b" no CI |
| §5b formulário de edição volta ao valor anterior | **Hospedado antes:** atribuição salva no banco, seletor voltava a "Sem responsável". `stabilization-form-reset.test.tsx`: **6 de 6 falhavam** (local), inclusive o `LeadBasicFieldsForm` já corrigido na A4 | `5e5ec72` | 6/6 local; CI verde (run 34971207110). **Hospedado depois:** seletor de responsável e status do conflito mostram o valor salvo logo após o envio |

**Gates desta rodada (CI, run 34971207110 no `5e5ec72`):** typecheck, lint,
unitários, `db:types:check`, pgTAP 515 em 15 arquivos, isolamento 26,
concorrência A7, concorrência da numeração, build, e2e 54, atualização a
partir da versão anterior. **Local:** typecheck, lint, 266 testes
unitários e `npm run build` limpos.

### 7.1 Validação de papéis no ambiente hospedado (§5)

- **Owner (feito):** tela e **resposta de rede** do Perfil 360 conferidas.
  A nota de conflito chega no payload (esperado para quem pode escrever a
  verificação) e os valores das propostas chegam exatos (`value_cents`
  123400 e 300000), sem faixa.
**Contas (autorizadas pelo usuário nesta rodada):** duas contas novas e
exclusivamente fictícias, criadas pelo cadastro do próprio app no preview
e vinculadas ao "Escritorio QA Praxis A3" por convite do owner (fluxo
oficial, sem seed, sem API administrativa, sem SQL):
`joaoniero2+praxisqaatend0915@gmail.com` (Atendimento/comercial) e
`joaoniero2+praxisqavisual0915@gmail.com` (Visualizador). Senhas únicas,
guardadas só em arquivo local fora do repositório. As senhas iniciais
chegaram a aparecer no chat; foram trocadas pela própria sessão da conta
(`updateUser`) e o login com a senha nova foi conferido. Refazer o cadastro
de uma conta não confirmada **não** troca a senha — conferido. Os convites
cujo token apareceu em log foram cancelados e recriados.

**Revalidado no preview do `f9f8ae2`** (última versão desta rodada), com os
mesmos resultados da primeira execução.

**Método:** script Playwright com a sessão de cada papel no preview
(`feat/a9-perfil-360`, deploy do `057fcf9`), lendo a tela e o corpo real de
cada documento e resposta RSC de: Perfil 360 do lead fictício "Cliente A9
Revalidação (fictício)", `/oportunidades/[id]`, `/pipeline` (kanban e
tabela) e `/clientes`. O owner roda o mesmo roteiro como controle — o
detector acha a nota e os valores exatos no payload dele, então um "não
encontrado" nos papéis restritos não é detector cego. Operações proibidas:
o owner dispara quatro Server Actions reais (verificação de conflito,
anotação, proposta, convite) e o script as **aborta antes de sair do
navegador**; o pedido capturado é reenviado ao servidor com a sessão do
papel restrito. Depois, o mesmo pedido direto ao banco (RPC com a sessão
do papel). Consulta somente leitura ao final confirma que nada foi gravado.

| Verificação | Owner (controle) | Atendimento | Visualizador |
|---|---|---|---|
| Nota de conflito no payload do Perfil 360 | presente (esperado) | **ausente**; `get_conflict_check` devolve `note: null` | **ausente**; `get_conflict_check` devolve `note: null` |
| Nota de conflito na tela / formulário de verificação | visível / presente | **ausente / ausente** | **ausente / ausente** (sem composer de anotação) |
| Campo de valor exato (`valueCents`, `value_cents`, `valueSumCents`) no payload | presente (Perfil 360) | **ausente** em todas as telas | **ausente** em todas as telas |
| Valores em reais no HTML | R$ 1.234,00 e R$ 3.000,00 (propostas); R$ 900,00, R$ 7.500,00 etc. (tabela) | **nenhum** | **nenhum** |
| Faixa | — | **só faixa**: propostas "R$ 2.000–5.000" e "Até R$ 2.000"; tabela "Até R$ 2.000", "R$ 5.000–10.000", "Não informado" | **nenhuma** — sem campo de faixa; coluna Valor da tabela mostra "—"; aba Propostas sem valor nem botão "Nova proposta" |
| Server Action `upsertConflictCheck` reenviada | — | **recusada** ("Você não tem permissão para fazer isso.") | **recusada** ("Você não tem permissão para fazer isso.") |
| Server Action `createInvitation` reenviada | — | **recusada** (mesma mensagem) | **recusada** (mesma mensagem) |
| Server Actions `createLeadNote`, `createProposal` reenviadas | — | permitidas ao papel pela matriz, não reenviadas | **recusadas** as duas (mesma mensagem) |
| RPC direto `upsert_conflict_check` | — | **`insufficient_permission`** | **`insufficient_permission`**; também `create_lead_note` e `create_proposal` → `insufficient_permission` |
| Nada gravado (somente leitura) | nota intacta, status "Sem conflito", 2 propostas, 0 anotações/convites/verificações de teste | ← | nota intacta, 2 propostas, 0 registros de teste (conferido de novo após o visualizador) |

### 7.2 Supabase Auth hospedado: Site URL, Redirect URLs e confirmação real (§6, §6.1)

**Domínios atuais (Vercel CLI, `vercel ls`/`alias ls`/`inspect`):**
produção `praxis-crm-eight.vercel.app` e `praxis-crm-johllls-projects.vercel.app`
(mesmo deploy); preview da PR `praxis-crm-git-feat-a9-perfil-360-johllls-projects.vercel.app`.

**Configuração, verificada sem credencial:** `GET /auth/v1/verify` com token
inválido e `redirect_to` candidato. O GoTrue redireciona para o destino
pedido quando ele está na allow-list e para o Site URL quando não está.
- `/auth/confirm` nos dois domínios de produção e no preview → aceitos;
- domínio inexistente → cai em `https://praxis-crm-eight.vercel.app` (Site URL);
- `/auth/v1/settings`: cadastro por e-mail ligado, `mailer_autoconfirm: false`.

A configuração antiga (`localhost:3000`) já tinha sido corrigida no painel.
**Nenhum ajuste manual necessário.**

**Cadastro e link real — primeira rodada, com o provedor padrão:**
1. Cadastro pelo formulário do preview → "Cadastro criado…"; banco com
   `confirmation_sent_at` e `email_confirmed_at` nulo.
2. Link aberto depois de 1 hora → `otp_expired` do próprio Auth; o app
   levou a `/entrar` **com** o aviso; sem sessão.
3. Link novo aberto 4 minutos depois do cadastro, no mesmo navegador:
   `303 /auth/v1/verify` → `307 <preview>/auth/confirm?code=…` → `200 /onboarding`
   com os cookies de sessão. Só funciona com a correção do `057fcf9`.
4. Outro cadastro, link aberto 13 minutos depois: `/auth/confirm?code=…` →
   `/entrar` com o aviso, sem sessão, `auth.flow_state` com código emitido e
   não consumido e `email_confirmed_at` preenchido. Causa provável em §6.2.
5. O terceiro cadastro seguido foi recusado sem enviar e-mail (limite do
   provedor padrão, 2/h).

**SMTP próprio e modelo novo (autorizado nesta rodada):**
- Resend, domínio `mail.collios.cloud` (região São Paulo), plano gratuito.
  DNS na Vercel (`collios.cloud`; comprado na Hostinger, mas os nameservers
  são `ns1/ns2.vercel-dns.com`). Registros adicionados: DKIM
  (`resend._domainkey.mail`), SPF e MX (`send.mail`), DMARC
  (`_dmarc.mail`, `p=none`). Conferidos por consulta DNS externa. O DMARC
  tinha sido criado por engano no domínio raiz e foi movido: publiquei no
  subdomínio, confirmei, e só então removi o do raiz — que não existia
  antes desta rodada (listagem anterior tinha apenas ALIAS, curinga e três
  CAA). ALIAS, curinga, CAA, SPF, DKIM e MX intactos.
- SMTP no Supabase: `smtp.resend.com`, porta 587, usuário `resend`,
  remetente `nao-responda@mail.collios.cloud`; senha só no painel, nunca no
  repositório nem no chat. Limite de envio 2 → 30 e-mails/h.
- Modelo "Confirm signup" (editável só com SMTP próprio):
  `{{ if .RedirectTo }}{{ .RedirectTo }}{{ else }}{{ .SiteURL }}/auth/confirm{{ end }}?token_hash={{ .TokenHash }}&type=email`.
- **Conferência independente:** os 243 campos da configuração de Auth lidos
  antes e depois pela API de gerência; mudaram só `smtp_*`,
  `rate_limit_email_sent` (2 → 30), o corpo do modelo de confirmação e a
  marca de modelo personalizado. `site_url`, `uri_allow_list`,
  `mailer_subjects_confirmation`, `mailer_otp_exp` e `mailer_autoconfirm`
  inalterados.

**Cenários com o modelo novo (dois cadastros de QA às 17:48 UTC, links
abertos às 18:2x — mais de 5 minutos depois do envio e dentro da validade
de 1 hora):** o link chegou como `<preview>/auth/confirm?token_hash=…&type=email`,
ou seja, o cadastro feito no preview confirma no preview.

| Cenário | Resultado |
|---|---|
| Outro navegador (contexto novo, sem nenhum dado do cadastro), 34 min depois do envio | `307 /auth/confirm` → `200 /onboarding`, com sessão; nenhum cookie PKCE presente |
| Navegador original do cadastro | `307 /auth/confirm` → `200 /onboarding`, com sessão |
| Link reutilizado (já consumido) | `/entrar?erro=link_invalido` com o aviso que fala do link e **não** afirma nada sobre a conta — que, neste caso, está confirmada |
| Login com a conta confirmada | `/visao-geral` |
| Aceite do convite | `/visao-geral` no "Escritorio QA Praxis A3", papel `viewer` ativo |


**Contas de QA criadas para estes cenários** (fictícias, no
"Escritorio QA Praxis A3" quando aplicável; senhas só em arquivo local):
`+praxisqaconfirmaoutro0916` (confirmada em outro navegador, convite
`viewer` aceito) e `+praxisqaconfirmamesmo0916` (confirmada no navegador
original, sem workspace). Somadas às de §7.1, são quatro contas de QA desta
rodada, todas confirmadas pelo fluxo oficial.

### 7.3 Falha de CI investigada, não reexecutada (run 35130297401, `e23a500`)

O e2e `leads — A4 / 2. edição básica` falhou uma vez: o campo Resumo ficou
com o texto novo seguido do texto que o servidor tinha mandado
("…audiência marcada" + "Rescisão indireta", que era o valor salvo no
banco). Nada no commit tocava leads.

**Causa:** o teste preencheu o campo antes de o React hidratar. Até a
hidratação, o `<textarea>` é HTML do servidor; depois dela o React é a
autoridade sobre o valor, e o preenchimento que cai no meio disso mistura
os dois. É corrida do teste com o carregamento — o valor gravado no banco
seguia correto, e o campo controlado (§5b) continua sendo a autoridade
depois de hidratado.

**Tratamento:** nenhuma asserção foi afrouxada e o retry do Playwright
continua desligado. O e2e passou a esperar a marca que o React deixa no
próprio nó ao hidratar (`__reactFiber$…`) antes de digitar
(`waitForHydration` em `tests/e2e/helpers.ts`), usada nos dois pontos do
`leads.spec.ts` que digitam logo após a navegação.

**Desdobramento:** a suposição de que "não é perda de dado" estava errada.
A investigação pedida em seguida reproduziu o caso no ambiente hospedado e
mostrou o texto concatenado também no payload e no banco — virou o defeito
§5c, corrigido no próprio formulário. Com o campo bloqueado até a
hidratação, a espera que eu tinha acrescentado ao e2e deixou de ser
necessária e foi removida junto com o helper.
