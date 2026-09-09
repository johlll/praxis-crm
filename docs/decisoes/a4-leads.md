# A4 — Leads: decisões de modelo e segurança

> Este documento foi reescrito após a revisão do commit `1c6e753` (antes
> do merge do PR #4). A primeira versão da A4 continha três problemas
> reais, corrigidos na migration `20260909100500_a4_review_hardening.sql`
> — o texto abaixo já descreve o estado FINAL, corrigido; a seção
> "O que a revisão corrigiu" no fim documenta o que existia antes e por
> quê estava errado, para quem chegar depois via histórico do PR.

## Campos de `leads`

O plano original (seção 6.3) lista para `leads`: contato, área jurídica,
resumo, etiquetas, prioridade, responsável, status. **Não inclui nenhum
campo monetário** — valor (`value_cents`) só aparece em `opportunities`
(A5). A primeira versão da A4 adicionou `estimated_value_cents` a `leads`
mesmo assim, com a justificativa de que sem um campo monetário o critério
de aceite ("a resposta serializada de um viewer não contém CPF nem valor
de honorários") não teria nada de fato a proteger. **Essa justificativa
foi rejeitada na revisão**: o modelo de dados aprovado não previa esse
campo em `leads`, e criá-lo só para ter algo a testar inverte a ordem
certa (o modelo de dados não se molda ao teste).

`estimated_value_cents`/`lead_values` foram **retirados do contrato ativo
da A4** (ver "O que a revisão corrigiu" abaixo) — honorários fica
inteiramente para a A5, quando `opportunities.value_cents` existir. O
critério de aceite continua satisfeito, e de forma mais direta: não existe
NENHUMA chave de valor no payload de nenhum papel, porque o campo
simplesmente não existe no modelo de leads. A proteção de CPF é a mesma
já validada na A3 (`contact_sensitive`), reaproveitada sem alteração —
`get_lead()`/`list_leads()` nunca retornaram CPF, só `contact_name`.

`status` é deliberadamente mínimo nesta fase: `ativo` | `arquivado`.
Nenhum conceito de estágio de pipeline, ganho/perdido — isso é da A5.

## Por que `leads` fica totalmente trancado (RLS deny-all), diferente de `contacts`

`contacts` permite SELECT direto via RLS (escopado por workspace). Para
`leads`, isso não bastaria: a regra "advogado só vê os leads dele + sem
responsável" (matriz do plano, coluna "Advogado") é um filtro de LINHA
que depende do **papel de aplicação** (`memberships.role`), não do papel
do Postgres — todo usuário autenticado compartilha o mesmo papel de banco
(`authenticated`), então uma policy de RLS não consegue, sozinha,
diferenciar "advogado" de "proprietário" sem reimplementar a mesma lógica
de duas formas (policy E função). Preferimos uma única fonte de verdade:
`leads`/`lead_values` não têm NENHUMA policy que permita acesso — toda
leitura e escrita passa por `list_leads()`/`get_lead()`/`create_lead()`/
etc., que aplicam a regra uma vez só.

## "Seus + sem responsável" do advogado — leitura E escrita

A matriz do plano diz "seus + equipe" para o advogado, mas o plano nunca
definiu "equipe" — não existe tabela de equipe nem hierarquia de
gerência no schema. Confirmado com o dono do produto: "equipe" significa
**seus leads + os que ainda não têm responsável** (fila compartilhada
que qualquer advogado pode assumir), não uma estrutura de time formal.

Essa regra tem uma única implementação, `private.lead_accessible_to_role
(papel, assigned_to, ator)`, usada em:

- **Leitura** — `get_lead()`/`list_leads()`: um lead fora do alcance
  responde como **não encontrado** (`lead_not_found`), nunca como erro de
  permissão — mesmo princípio da seção 6.8 do plano para recursos de
  outro workspace: não revela existência a quem não deveria nem saber.
- **Escrita** — `update_lead_basic_fields()`/`assign_lead()`/
  `set_lead_status()`: a MESMA checagem, mesmo raciocínio de negação.
  Esta parte não existia na primeira versão da A4 (ver "O que a revisão
  corrigiu") — um advogado conseguia editar, arquivar ou se autoatribuir
  um lead fora do alcance chamando a RPC direto, mesmo sem nunca ver
  esse lead pela tela.

## Concorrência: checagem atômica, não check-then-write

`update_lead_basic_fields()`, `assign_lead()` e `set_lead_status()`
recebem `p_expected_updated_at`, agora **obrigatório** (sem default) —
toda edição de um lead já existente tem uma versão atual pra comparar,
não existe "pular a checagem" numa edição normal. A comparação acontece
**dentro do `WHERE` do próprio `UPDATE`**
(`where id = p_lead_id and updated_at = p_expected_updated_at`), não como
um `SELECT` seguido de comparação em PL/pgSQL: checar e gravar são a
MESMA operação atômica. Se zero linhas forem afetadas, `lead_conflict`.

Isso importa porque a versão anterior fazia `SELECT`, comparava em
PL/pgSQL, e só DEPOIS rodava um `UPDATE` sem nenhuma condição de versão
no `WHERE` — havia uma janela real entre checar e gravar em que outra
transação podia gravar no meio, e a segunda gravação vencia em silêncio,
sem nunca acusar conflito (ver "O que a revisão corrigiu").

## Vínculo com contato: integridade também no banco

`leads.contact_id` usa uma FK **composta** contra
`contacts (workspace_id, id)` (constraint nova em `contacts`:
`unique (workspace_id, id)`), não uma FK simples contra `contacts.id`.
Isso garante, no próprio banco, que um lead nunca aponte para um contato
de outro workspace — mesmo que a validação da aplicação tivesse um bug.

## Integração com mesclagem de contatos (A3)

`merge_contacts()`/`unmerge_contact()` foram estendidas (`CREATE OR
REPLACE`, mesma assinatura) para reconhecer `leads` como mais uma tabela
reparentável no formato já genérico de `moved_rows`
(`{"table", "id", "previous_updated_at"}`). Mesclar move os leads do
contato perdedor para o vencedor; desfazer restaura, com a mesma trava de
conflito (linha editada ou apagada depois da mesclagem) já usada para
telefone/e-mail/consentimento. O reparentamento usa
`UPDATE ... RETURNING updated_at` (nunca `SELECT` antes do `UPDATE`) —
mesma correção do achado 7 da A3, aplicada aqui desde o primeiro commit,
não depois de um bug em produção.

## Dinheiro sem ponto flutuante

`parseMoneyBRToCents()` (`src/lib/money.ts`) segue no repositório mesmo
sem nenhum chamador em leads hoje — é utilitário genérico, sem
acoplamento a leads, e a A5 vai precisar exatamente dele para
`opportunities.value_cents`. Recriá-lo do zero na A5 seria retrabalho sem
benefício. Só aritmética inteira sobre as partes já separadas da string
(parte inteira × 100 + parte decimal), nunca uma divisão/multiplicação de
ponto flutuante — testado em `tests/unit/money.test.ts`.

## O que a revisão corrigiu (commit `1c6e753` → `20260909100500_a4_review_hardening.sql`)

Três problemas reais, nenhum deles hipotético — todos com teste que
falharia antes da correção e passa depois:

1. **Alcance por registro só valia na leitura.** `update_lead_basic_
   fields()`/`assign_lead()`/`set_lead_status()`/`set_lead_value()`
   checavam só `has_workspace_role()` (membership + papel), sem checar se
   o REGISTRO estava no alcance do advogado. Corrigido centralizando a
   regra em `private.lead_accessible_to_role()`, chamada pelas quatro
   funções de escrita além das duas de leitura.
2. **Concorrência com janela real entre checar e gravar.** Descrito acima
   — corrigido movendo a comparação de versão para dentro do `WHERE` do
   `UPDATE`/`INSERT ... ON CONFLICT DO UPDATE ... WHERE` (atômico), e
   tornando `p_expected_updated_at` obrigatório nas três funções de
   edição de lead (antes tinha default nulo, que pulava a checagem por
   completo quando omitido).
3. **Honorários antecipado sem aprovação.** Descrito na primeira seção —
   corrigido retirando o fluxo do contrato ativo:
   - `create_lead()` não aceita mais `p_estimated_value_cents` (parâmetro
     removido — assinatura foi de 8 para 7 parâmetros; precisou de
     `DROP FUNCTION` + `CREATE FUNCTION`, não só `CREATE OR REPLACE`,
     porque remover um parâmetro muda a assinatura);
   - `get_lead()`/`list_leads()` nunca mais projetam nenhuma chave de
     valor, para nenhum papel (nem o proprietário);
   - `set_lead_value()` teve o `EXECUTE` **revogado de `authenticated`**
     — a função continua existindo (corrigida quanto aos achados 1 e 2,
     por consistência), mas ninguém, por nenhuma via, consegue mais
     chamá-la.

   **Nada foi apagado.** `lead_values`, `private.lead_value_projection()`
   e `private.money_band_label()` continuam existindo, intocadas, como
   estrutura residual — inclusive a única linha real gravada no ambiente
   hospedado `praxis-crm-dev` durante o teste manual da A4 (um lead de
   teste, R$ 5.500,00, criado ao validar a UI no preview antes da
   revisão) permanece lá, sem uso pelo contrato ativo. A A5 decide o
   destino dessa estrutura quando `opportunities.value_cents` existir —
   provavelmente descartá-la em favor da tabela nova, com sua própria
   migration e sua própria decisão sobre os dados residuais.

Nenhuma das três correções tocou as migrations da A4 já aplicadas
(`20260909100000` a `20260909100400`) — tudo entrou como migration nova
(`20260909100500`), aditiva, seguindo a mesma disciplina forward-only já
usada da A2 em diante.
