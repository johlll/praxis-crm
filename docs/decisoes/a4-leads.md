# A4 — Leads: decisões de modelo e segurança

## Campos de `leads`

O plano original (seção 6.3) lista para `leads`: contato, área jurídica,
resumo, etiquetas, prioridade, responsável, status. Adicionamos
**`estimated_value_cents`** (valor estimado de honorários), que não
constava ali — só aparece em `opportunities` (A5) no plano. Sem um campo
monetário em `leads`, o critério de aceite desta fase ("a resposta
serializada de um viewer não contém CPF nem valor de honorários") não
teria nada de fato a proteger. `estimated_value_cents` é o valor
*estimado* na fase de lead, antes de virar oportunidade formal — não
duplica nem antecipa `opportunities.value_cents` da A5.

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

## Por que o valor de honorários mora numa tabela separada (`lead_values`)

Mesmo raciocínio do CPF na A3 (`contact_sensitive`), mas por um motivo
diferente: não é dado cifrado, é dado com **visibilidade por papel**.
Postgres GRANT é por papel do banco, não por papel da aplicação — não há
como conceder SELECT de uma coluna para "owner" e negar para "viewer"
via GRANT, porque os dois são o mesmo `authenticated` aos olhos do
Postgres. A única forma de diferenciar é uma função que checa o papel de
aplicação internamente. Isolar o campo numa tabela sem GRANT nenhum
garante que nenhuma outra via (Data API direta, um relatório futuro, uma
nova função escrita sem essa preocupação) exponha o valor sem passar por
essa checagem.

## Projeção do valor: exato, faixa ou ausente

`private.lead_value_projection(papel, centavos)` decide o formato:

- **Exato** (`estimated_value_cents`): owner, admin, manager, lawyer.
- **Faixa** (`estimated_value_band`): sales — nunca o número exato,
  conforme a matriz do plano ("⚠️ faixa (projeção)"). Faixas fixas em
  `private.money_band_label()`: até R$2.000, R$2.000–5.000,
  R$5.000–10.000, R$10.000–25.000, acima de R$25.000.
- **Ausente**: viewer. A CHAVE não existe no jsonb devolvido — nunca um
  valor `null` presente. `jsonb_build_object(...) || projeção` garante
  isso: quando a projeção devolve `'{}'::jsonb`, nenhuma chave nova é
  acrescentada ao objeto base.

Atendimento (sales) **pode escrever** um valor exato (mesma permissão de
edição de `lead.edit`... na verdade `lead.view_value`, ver abaixo) mesmo
sem nunca conseguir lê-lo de volta como número — assimetria intencional,
mesmo padrão já aceito na A3 para revelação de CPF por atendimento (com
motivo).

`set_lead_value()` é gated por `lead.view_value`, não por `lead.edit` —
quem não pode ver o valor (viewer) também não deveria conseguir setá-lo
por fora da tela.

## "Seus + equipe" do advogado

Implementado como filtro de linha dentro de `list_leads()`/`get_lead()`:
`assigned_to = auth.uid() OR assigned_to IS NULL`. Um lead fora do
alcance responde como **não encontrado** (`lead_not_found`), nunca como
erro de permissão — mesmo princípio da seção 6.8 do plano para recursos
de outro workspace: não revela existência a quem não deveria nem saber.

## Concorrência

`update_lead_basic_fields()`, `assign_lead()`, `set_lead_status()` e
`set_lead_value()` recebem `p_expected_updated_at` opcional. Se vier
preenchido e não bater com o `updated_at` atual da linha, a função recusa
com `lead_conflict` — nunca sobrescreve silenciosamente uma edição feita
por outra pessoa entre o carregamento da tela e o envio do formulário.
`set_lead_value()` compara contra o `updated_at` de **`lead_values`**,
não de `leads` (são linhas diferentes) — por isso `get_lead()`/
`list_leads()` também expõem `value_updated_at` separado de `updated_at`
(achado escrevendo a tela de editar valor, corrigido antes de qualquer
PR: ver migration `20260909100400_a4_lead_value_updated_at.sql`).

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

Todo valor monetário é `bigint` em centavos no banco e passa por
`parseMoneyBRToCents()` (`src/lib/money.ts`) na entrada — só aritmética
inteira sobre as partes já separadas da string (parte inteira × 100 +
parte decimal), nunca uma divisão/multiplicação de ponto flutuante.
