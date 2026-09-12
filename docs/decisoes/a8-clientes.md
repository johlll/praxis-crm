# A8 — Clientes e handoff: decisões

## 1. Reaproveitamento da fundação da A5 — nenhuma segunda conversão

`clients`/`client_handoffs` e a lógica de `win_opportunity()` (criar ou
reaproveitar cliente, criar handoff pendente, tudo atômico) já existiam
desde a A5 — fundação mínima antecipada, documentada explicitamente no
schema como preparação para esta fase. A A8 **não** recria essa conversão
no frontend nem chama uma segunda RPC depois de ganhar: `winOpportunityAction`
já recebia `client_id`/`handoff_id` no retorno de `win_opportunity()` desde
a A5 — só descartava. A única mudança em `win_opportunity()` nesta fase é
zero: a função continua exatamente como estava. O que muda é que
`get_opportunity()`/`list_opportunities()` passam a expor `client_id` (join
com `client_handoffs`, aditivo, mesma assinatura) para a UI poder linkar
"Ver cliente" sem uma segunda consulta.

## 2. Histórico por cliente, não por contato

`client_handoffs.client_id + opportunity_id` identifica quais oportunidades
pertencem a QUAL cliente — nunca uma busca por `opportunities.lead.contact_id`
direto, que misturaria clientes históricos distintos do mesmo contato (ex.:
um cliente encerrado em 2024 e outro ativo criado em 2026 para a mesma
pessoa). `get_client()` sempre junta por `client_handoffs.client_id`, nunca
por contato.

Nenhum valor, modelo de honorários ou data de assinatura é copiado para
`clients` — esses dados continuam existindo só em `opportunities`, como já
decidido na A5. `get_client()` projeta o valor de CADA oportunidade do
histórico pelo papel de quem chama (reaproveitando
`private.opportunity_financial_projection()`, sem duplicar a regra) e never
devolve `client_handoffs.payload` bruto (que carrega valores exatos) nem
`last_error` — o handoff exposto ao navegador é sempre uma projeção
explícita: id, status, `target_system`, `attempts`, `completed_at`,
`created_at`, e um booleano `awaiting_integration` derivado.

## 3. Alcance por registro — reaproveitado, não reinventado

`private.lead_accessible_to_role()` (A5) já implementa "seus + sem
responsável" para o advogado, e **só** restringe o papel `lawyer` — owner/
admin/manager/sales/viewer sempre passam, com a distinção de sales/viewer
sendo inteiramente na PROJEÇÃO financeira, nunca no conjunto de linhas
visíveis. Essa é a regra vigente desde a A5 para leads/oportunidades, e a
A8 a reaproveita literalmente, sem uma segunda implementação:

- `list_clients()`/`get_client()` filtram clientes para qualquer papel que
  não seja owner/admin/manager (**revisado em §11**, item 1 — a versão
  original só filtrava `lawyer`): um cliente aparece/é acessível se tiver
  ao menos UM handoff cujo lead (herdado da oportunidade) esteja no
  alcance de quem pediu.
- Dentro de um cliente visível, `history` filtra CADA linha pelo mesmo
  alcance — ver uma oportunidade não libera as demais do mesmo cliente,
  mesmo que pertençam ao mesmo cliente. Um advogado com acesso a uma
  negociação do cliente X não vê automaticamente outra negociação do
  mesmo cliente atribuída a outro colega.
- Registro legado sem nenhum handoff vinculado (alcance indeterminável):
  fica de fora da lista de qualquer papel não administrativo — a checagem
  é "existe ao menos uma oportunidade em meu alcance", vacuamente falsa
  sem nenhuma — e permanece visível só para owner/admin/manager
  (**revisado em §11**: antes também ficava visível para sales/viewer, o
  que era o próprio achado 1 da revisão). Não é um caso especial tratado
  em código; é a mesma regra aplicada a um conjunto vazio.

Ser responsável (`owner_user_id`) por um cliente **não** concede acesso
adicional a nenhuma oportunidade ou lead — esse campo é só um rótulo de
"quem cuida deste cliente", nunca uma segunda porta de entrada para dado
restrito.

## 4. Permissões — administrativo para mudar, não para ver

`client.view`: todos os papéis (owner/admin/manager sem filtro de linha;
lawyer/sales/viewer com o alcance do item 3 — **revisado em §11**: os três
agora exigem ao menos uma negociação em seu alcance, distinguindo-se da
administração pela projeção financeira E por esse filtro de linha no caso-
limite de cliente sem nenhum handoff).
`client.manage` (mudar status, transferir responsável): só owner/admin/
manager, mesmo nível de `pipeline.configure`. Nem sales, nem viewer, nem
lawyer alteram cliente algum nesta entrega — `contact.edit` NÃO foi copiado
como autorização geral de gestão de clientes (seriam matrizes diferentes:
editar contato é operacional do dia a dia; mudar o status jurídico/
comercial de um cliente é administrativo).

## 5. Status, concorrência e o que NUNCA muda retroativamente

`clients.status` (`ativo|encerrado|suspenso`, já existente desde a A5)
ganhou `lock_version bigint` — mesmo padrão de concorrência otimista de
`opportunities`/`activities`: o `UPDATE` está condicionado no `WHERE`, nunca
lido e regravado às cegas; divergência vira `client_conflict` tratado.

Mudar o status do cliente **nunca** toca `opportunities` nem
`client_handoffs` — `update_client_status()` só tem um `UPDATE` na própria
tabela `clients`; é estruturalmente impossível essa função reescrever uma
oportunidade ganha ou um handoff já registrado, porque nenhum dos dois é
sequer referenciado no corpo dela.

**Reativação conflitante**: reativar (`encerrado`/`suspenso` → `ativo`) é
recusado com `active_client_conflict` quando já existe outro cliente ativo
para o mesmo contato — checagem explícita ANTES do `UPDATE` (mensagem
clara e imediata) e, como rede de segurança contra corrida entre duas
chamadas concorrentes, um handler de `unique_violation` ao redor do
`UPDATE` (o índice parcial `clients_one_active_per_contact_idx`, já
existente desde a A5, é quem garante o invariante de verdade). Em nenhum
caso os dois cadastros são mesclados ou apagados — a decisão de qual
cliente "vence" fica com um administrador, fora desta função.

## 6. Comportamento de `win_opportunity()` quando só há clientes encerrados/suspensos — documentado, não alterado

Achado ao ler `win_opportunity()` (A5): o `INSERT ... ON CONFLICT
(workspace_id, contact_id) WHERE status = 'ativo' DO NOTHING` só colide com
um cliente **ativo** existente — se o contato só tem clientes
`encerrado`/`suspenso`, o índice parcial não encontra conflito nenhum, e a
função cria um cliente **novo**, ativo, em vez de reabrir o antigo. Esse é
o comportamento REAL desde a A5; a A8 não o altera silenciosamente (pedido
explícito) — só o documenta e cobre com um teste pgTAP dedicado
(`13_a8_clients.test.sql`, seção 5) que prova, ao vivo, que um contato pode
acumular mais de um registro de `clients` ao longo do tempo (no máximo um
ativo por vez).

## 7. "Cliente desde" e origem

`clients.created_at` já é gravado dentro da MESMA transação de
`win_opportunity()` — é o instante real da conversão, confirmado lendo o
código da A5. "Cliente desde" reaproveita esse campo; nenhuma coluna
`converted_at` foi criada, porque seria duplicar exatamente o mesmo
instante sem semântica adicional.

A oportunidade de origem é identificada pelo primeiro `client_handoffs`
vinculado, em ordem determinística (`created_at asc, id asc` — desempate
por id cobre o caso teórico de dois handoffs no mesmo timestamp). Resolvida
no lado do cliente (`history[0]`, já que `get_client()` devolve o histórico
nessa ordem), sem uma segunda consulta ao banco. Importante: como
`history` já vem filtrado pelo alcance de quem chama, a "origem" mostrada a
um advogado é a primeira oportunidade que ELE enxerga — nunca revela a
existência de uma oportunidade anterior fora do seu alcance só para provar
qual foi "a origem de verdade" para outros papéis.

Atribuição comercial/touchpoints fica para a A11, como já decidido no
plano — nenhuma origem foi inventada, nenhuma data antiga foi preenchida
com a data desta migration.

## 8. Handoff honesto

Sem integração jurídica configurada (`target_system` nulo — nenhuma
integração real existe até hoje), a tela mostra "Aguardando integração".
Não existe reprocessamento (não há nenhuma RPC de "tentar de novo"), não
existe forma de marcar como concluído manualmente pela interface, e o
texto nunca afirma que um processo externo foi criado. `last_error` e
`payload` do handoff nunca saem do banco — `get_client()` simplesmente não
os inclui na projeção; não há como o componente `HandoffCard` vazá-los
mesmo por engano, porque o dado nunca chega ao servidor Next.js.

## 9. Integração com mesclar/desfazer contatos (A3/A4)

`merge_contacts()`/`unmerge_contact()` foram escritas antes de `clients`
existir (A5 é posterior até à integração de `leads`, feita na A4) — sem
tocar essas funções, mesclar um contato que já é cliente deixaria
`clients.contact_id` "preso" ao contato perdedor (que passa a responder
como inativo em `contacts`), quebrando "Ver cliente" a partir do contato
vencedor. A A8 estende as duas funções (mesma assinatura, `CREATE OR
REPLACE` só no corpo) para também reparentar `clients.contact_id`, com o
mesmo padrão de `moved_rows`/desfazer já usado para telefones, e-mails,
identificadores, consentimentos e leads.

**Conflito real possível**: se os DOIS contatos (vencedor e perdedor) já
têm, cada um, um cliente ATIVO próprio, mover o do perdedor para o
`contact_id` do vencedor colidiria com `clients_one_active_per_contact_idx`
— dois clientes ativos para o mesmo contato. Em vez de deixar isso estourar
como um erro de banco cru (ou, pior, silenciosamente escolher um dos dois),
`merge_contacts()` recusa a mesclagem inteira com
`client_merge_conflict_active_client` ANTES de mover qualquer linha —
mesmo espírito do ADR-007 (nenhuma união automática de entidade sem decisão
humana): um administrador precisa primeiro decidir manualmente qual dos
dois clientes ativos deve ceder (mudando o status de um deles), só depois
a mesclagem do contato é aceita. `client_handoffs` não precisa de
reparentamento próprio — referencia `client_id`, não `contact_id`, então já
segue o cliente automaticamente.

## 10. Listas e erro de carregamento — mesmo princípio de A6/A7

`listClients()` distingue falha de consulta de "workspace genuinamente sem
clientes" — a mesma correção aplicada a `ActivitiesLoadError` (A6) e
`ConversationsLoadError` (A7), desta vez desde o primeiro commit da A8, não
como correção pós-revisão: `ClientsLoadError` é lançada quando a RPC
responde com erro; `clientes/error.tsx` mostra erro tratado com "tentar
novamente", nunca uma lista vazia disfarçada de "nenhum cliente ainda".

## 11. Revisão pré-merge — 3 achados corrigidos

Revisão de código na PR #10 apontou 3 pontos antes de autorizar o merge.
Migration nova: `20260912100000_a8_review_hardening.sql` (`create or
replace` em `list_clients()`/`get_client()`, mesmas assinaturas — nenhuma
migration já aplicada foi reescrita).

**1. Cliente sem negociação vinculada.** A regra original (§3) só
restringia `lawyer` quando não havia nenhum handoff em seu alcance —
`sales`/`viewer` continuavam vendo o cliente mesmo sem NENHUMA negociação
vinculada (alcance literalmente indeterminável, não apenas "fora do
alcance"). Corrigido: `list_clients()`/`get_client()` agora exigem que
qualquer papel que não seja owner/admin/manager tenha ao menos uma
negociação em seu alcance — na prática, `sales`/`viewer` só perdem acesso
ao cliente que não tem NENHUM handoff (já que `lead_accessible_to_role()`
só restringe `lawyer` quando existe alcance a verificar). Histórico e
totais continuam filtrados individualmente por registro, sem mudança.

**2. Origem calculada a partir do histórico já filtrado.** `history[0]`
(resolvido no cliente, A8 original) podia mostrar uma oportunidade que não
é a origem real: se a origem verdadeira (primeiro handoff) estivesse fora
do alcance do advogado mas uma posterior estivesse dentro, o filtro de
alcance descartava a primeira e a segunda virava `history[0]` — parecendo
a origem sem ser. Corrigido: `get_client()` resolve a origem
separadamente, sempre a partir do primeiro handoff de VERDADE (mesma
ordenação determinística `created_at, id`), e só a inclui na resposta
(`origin`) se o usuário puder acessar aquela oportunidade específica. Caso
contrário `origin` vem `null` — a interface omite a origem, nunca a
substitui por outra oportunidade do histórico nem expõe o identificador da
restrita.

**3. 404 disfarçando falha operacional.** `getClient()` (TypeScript)
tratava qualquer erro da RPC — cliente inexistente, acesso negado, OU uma
falha real de rede/banco — do mesmo jeito: `null`, virando 404. Isso está
certo para `client_not_found`/`insufficient_permission` (mesmo princípio
de `leads/[id]`, A4), mas escondia uma falha operacional de verdade atrás
de um 404 enganoso. Corrigido: só esses dois códigos viram `null`; qualquer
outro erro lança `ClientDetailLoadError`, capturado por um novo
`clientes/[id]/error.tsx` com "Tentar novamente" — mesmo princípio de
`ActivitiesLoadError`/`ConversationsLoadError`/`ClientsLoadError`, agora
também para o detalhe de um único registro. `generateMetadata()` chama
`getClient()` também e propaga a mesma exceção (Next.js roteia para o
`error.tsx` mais próximo igual a qualquer outro erro de render).
