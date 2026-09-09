# A3 — Regras de detecção de duplicidade

Decisão registrada **antes** de escrever o código de detecção, conforme
pedido. Regra determinística, sem machine learning, sem mesclagem
automática — a decisão de mesclar é sempre humana (ver `contacts` e
`accept/merge` em `docs/arquitetura.md`).

## Sinais e níveis de confiança

| Sinal | Nível | Critério exato |
|---|---|---|
| CPF/CNPJ normalizado igual | **forte** (`strong`) | Mesmo `cpf_cnpj_blind_index` (já contextualizado por workspace — ver `a3-criptografia.md`), contatos diferentes, no mesmo workspace |
| Telefone normalizado igual | **revisão** (`review`) | Mesmo `value_normalized` em `contact_phones`, contatos diferentes, mesmo workspace |
| E-mail normalizado igual | **revisão** (`review`) | Mesmo `value_normalized` em `contact_emails`, contatos diferentes, mesmo workspace |
| Nome semelhante **e** cidade compatível | **baixa** (`low`) | `similarity(nome_a, nome_b) >= 0.6` (extensão `pg_trgm`) **e** mesma cidade+UF, contatos diferentes, mesmo workspace |
| Nome parecido sozinho | **não gera candidato** | Similaridade de nome sem cidade compatível não abre linha em `duplicate_candidates` — é o próprio pedido de não inflar a fila com coincidência de nome comum |

Um par de contatos pode acumular mais de um sinal (ex.: telefone igual **e**
nome+cidade parecidos) — o nível do candidato é o **mais alto** entre os
sinais presentes; todos os sinais ficam registrados (não só o vencedor), para
a interface mostrar o motivo completo.

**Telefone ou e-mail compartilhado não é, sozinho, prova de identidade** —
por isso fica em `review`, nunca em `strong`: telefone de família e e-mail
administrativo de empresa são casos reais que não podem virar mesclagem
automática nem candidato de alta prioridade.

## Explicabilidade, não probabilidade

`duplicate_candidates.signals` guarda um array estruturado (`jsonb`) com
cada sinal encontrado e seus dados (ex.: `[{"type":"phone_exact","value":"+55..."}]`,
`[{"type":"name_similarity","score":0.74},{"type":"city_match","city":"São Paulo","uf":"SP"}]`)
— a interface mostra **o motivo por extenso** ("mesmo telefone", "nome
parecido + mesma cidade"), nunca só um número.

`duplicate_candidates.priority` é um inteiro derivado do nível
(`strong=100, review=50, low=10`, mais um pequeno desempate pela quantidade
de sinais) — serve **só para ordenar a fila de revisão**, do mais
provável para o menos. Em nenhum lugar da interface ou da API isso é
apresentado como "84% de chance de ser a mesma pessoa" ou qualquer redação
que sugira probabilidade de identidade — é prioridade de fila, e a UI diz
exatamente isso.

## Quando a detecção roda

**Não é trigger de banco** (INSERT/UPDATE direto nas tabelas de contato) —
é uma chamada explícita, dentro da própria função `SECURITY DEFINER` que
cria/atualiza um contato (`create_contact_with_details`,
`update_contact_with_details`), depois que telefone/e-mail/CPF já foram
gravados na mesma transação. Motivo da escolha: um trigger disparado a cada
INSERT em `contact_phones`/`contact_emails`/`contact_sensitive`
isoladamente rodaria a comparação em estado parcial (ex.: contato ainda sem
CPF no momento em que o telefone é inserido) — chamar a detecção uma vez,
no fim da transação de escrita, com o contato já completo, é mais simples
de raciocinar e testar, e evita disparo redundante.

**Limite conhecido desta fase:** a comparação varre os contatos do mesmo
workspace a cada escrita — aceitável para o volume esperado de um único
escritório nesta fase; se o volume crescer a ponto de pesar, mover para um
job assíncrono é decisão de fase futura (Inngest, quando entrar), não
motivo para adiar a A3.

## Extensão necessária

`pg_trgm` (schema `extensions`, mesmo padrão de `pgcrypto` já usado na A2) —
só para o `similarity()` do sinal de nome+cidade.

## Teste

`supabase/tests/database/` recebe um arquivo dedicado que cobre, no mínimo:
telefone compartilhado entre dois contatos reais e distintos **não** produz
sinal `strong`; nome parecido sozinho (sem cidade) **não** cria
`duplicate_candidates`; CPF igual produz `strong`; um sinal `review` some
quando o telefone é corrigido para não bater mais (a listagem reflete o
estado atual, não histórico morto).
