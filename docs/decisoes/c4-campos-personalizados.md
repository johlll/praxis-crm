# C4 — campos personalizados mínimos

## Contrato

- Entidades: contato, lead, oportunidade e cliente.
- Tipos fechados: texto curto, número, data, sim/não e seleção única.
- Owner e admin administram definições; leitura e edição de valores repetem o alcance da entidade.
- Valores usam colunas tipadas. Opções têm ids próprios e pertencem a uma única definição.
- Há no máximo 50 definições ativas por entidade e workspace. O tipo é imutável.
- Arquivar uma definição preserva valores e a remove dos formulários ativos.
- Auditoria registra apenas ids e tipo de ação, nunca o conteúdo do valor.

## Limitações deliberadas

Não há texto rico, seleção múltipla, fórmulas, arquivos, relacionamentos, campos calculados, JSON livre, importação, exportação, anonimização nem uso dos campos em regras da C1. A interface não exclui definitivamente definições ou valores. Campos personalizados não devem guardar CPF, credenciais ou segredos.
