# C4 mínima — campos personalizados

Migration: `20261111120000_c4_campos_personalizados.sql` (forward-only; **só vale
depois de aplicada no hospedado** — sem ela as telas de registro mostram só o
aviso da seção e a tela de administração mostra o erro tratado da rota).
Tela de administração: Configurações → `Campos personalizados`
(`/configuracoes/campos-personalizados`).

## Contrato

- **Entidades:** contato, lead, oportunidade e cliente.
- **Tipos (fechados):** texto curto (até 500 caracteres), número (até 14 dígitos
  inteiros e 4 casas decimais), data (`AAAA-MM-DD`, de 1900 a 2200), sim ou não e
  seleção única (de 1 a 30 opções de até 80 caracteres). Não existe texto rico,
  múltipla seleção, fórmula, arquivo, relacionamento, campo calculado, expressão
  nem JSON livre.
- **Definição:** workspace, entidade, nome (até 80), tipo, posição (0 a 1000),
  opções (só na seleção) e estado ativo ou arquivado. O identificador é gerado
  pelo banco. **Tipo e entidade não mudam** depois de criados (trigger). Nome único
  entre os campos ativos da entidade. **No máximo 50 campos ativos** por entidade e
  workspace (trigger, sob trava).
- **Valor:** uma linha por definição e registro, em **colunas tipadas**
  (`value_text`, `value_number`, `value_date`, `value_boolean`, `option_id`). O
  banco prende, por chaves compostas e CHECK: mesmo workspace, definição da
  entidade certa, registro existente, tipo do valor igual ao da definição e opção
  pertencente à própria definição. Limpar um campo deixa a linha com valor vazio
  (nada é apagado pela interface).
- **Opções:** tabela própria (`custom_field_options`) para a chave composta garantir
  que a opção é da definição. Opção **já usada não sai da lista**: a edição é
  recusada com mensagem clara (renomear é permitido). Opção sem uso pode sair.
- **Gravar valores** é uma chamada só (`set_custom_field_values`), portanto uma
  transação: qualquer item inválido desfaz a chamada inteira.

## Permissões e isolamento

- **Administrar definições** (criar, editar, arquivar, restaurar, listar): só owner
  e admin (`custom_field.manage`).
- **Ler valores:** a permissão de leitura da entidade e o **mesmo alcance por
  registro** da tela dela (advogado só vê leads e oportunidades "seus + sem
  responsável"; cliente exige alcance a uma negociação). **Editar valores:** a
  permissão de edição da entidade (contato, lead e oportunidade: todos menos
  visualizador; cliente: owner, admin e manager). Não existe permissão própria para
  valores: campo personalizado nunca amplia o acesso ao registro.
- O workspace de um valor **vem do registro**, nunca do formulário. Registro,
  definição ou workspace de outro workspace respondem "não encontrado".
- As três tabelas têm RLS habilitada e forçada, sem policy e sem grant: tudo passa
  por RPC `SECURITY DEFINER` com `search_path` vazio e EXECUTE só para
  `authenticated`.

## Arquivamento

Arquivar **preserva todos os valores**; o campo some dos formulários ativos e não
aceita novas gravações. Restaurar o devolve (respeita o limite de 50 e a unicidade
do nome). Nada é excluído definitivamente pela interface.

## Auditoria e privacidade

Registra definição criada, alterada, arquivada e restaurada, e valor alterado.
Guarda **só ids e a ação** (definição, entidade e registro). Nunca o conteúdo do
valor, a opção escolhida, texto digitado, PII, valor anterior ou novo. A tela de
configuração avisa para **não usar campos personalizados para CPF, credenciais ou
segredos**.

## Telas

Seção "Campos personalizados" em contato, lead, oportunidade (também no detalhe do
lead, para a oportunidade principal) e cliente. Sem campos ativos na entidade, a
seção não aparece e a tela fica como era. Falha ao carregar vira aviso só na seção.

## Limitações conhecidas

- Sem integração com as condições da C1, a importação (C2) nem a exportação ou
  anonimização (C3): os valores ainda não entram nelas.
- Sem busca, filtro ou coluna de lista por campo personalizado.
- Mesclar contatos **não move** os valores do contato mesclado para o que ficou.
- Número: no máximo 4 casas decimais e 14 dígitos inteiros; data sem hora; sem
  reordenar opções além da ordem em que foram salvas; sem expurgo de definições
  arquivadas.
