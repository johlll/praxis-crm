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

## 6. Pendências externas conhecidas (fora do código)

| Origem | Item | Situação |
|---|---|---|
| A2 §7.5 | Site URL / Redirect URLs do Auth em `praxis-crm-dev` apontando para `localhost:3000` | **Aberta, não reconferida nesta rodada.** Configuração manual no painel do Supabase (Authentication → URL Configuration); não é alterável por migration nem pelo app, e ler a configuração exigiria as credenciais da CLI, que não foram usadas. Valores e passos exatos continuam em A2-HANDOFF §7.5 |

## 7. Evidências

Legenda de onde cada verificação rodou: **local** = `npm test`/`typecheck`/
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
- **Atendimento e visualizador (pendente, não realizado):** só existe
  credencial autorizada de owner em `praxis-crm-dev`, e a mesma senha não
  foi testada em outras contas. Para concluir: uma conta de QA com papel
  **atendimento** e uma com papel **visualizador** no workspace
  "Escritorio QA Praxis A3" de `praxis-crm-dev` (a conta "QA Sales Teste"
  já existe nesse workspace; falta uma de visualizador), entregues em
  arquivo local — não no chat. Com elas: abrir o lead fictício "Cliente A9
  Revalidação", conferir no payload que `note` vem nulo para os dois
  papéis, que atendimento recebe só `value_band` e visualizador não recebe
  valor, e o mesmo na tela. Até lá, essa proteção está demonstrada só pelo
  pgTAP (`14_a9_perfil_360`) e pelo e2e no CI.
