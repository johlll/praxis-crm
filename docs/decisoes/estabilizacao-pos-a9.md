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
A coluna "Evidência" é preenchida ao fim da rodada (seção 5).

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
| A2 §7.5 | Site URL / Redirect URLs do Auth em `praxis-crm-dev` apontando para `localhost:3000` | Configuração manual no painel do Supabase; não é alterável por migration nem pelo app. Reconferir e manter como pendência externa se continuar |

## 7. Evidências

Preenchido ao fim da rodada.
