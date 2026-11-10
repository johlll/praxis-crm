import { CustomFieldsForm } from "@/components/custom-fields/custom-fields-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getCustomFieldValues } from "@/modules/custom-fields/queries";
import type { CustomFieldEntity } from "@/modules/custom-fields/schema";

type Props = {
  entity: CustomFieldEntity;
  recordId: string;
  /** Permissão de edição da entidade (contact.edit, lead.edit, opportunity.edit, client.manage). */
  canEdit: boolean;
  /** Classe do cartão, para combinar com o da página que o recebe. */
  className?: string;
};

/**
 * Seção "Campos personalizados" de uma tela de registro. Sem nenhuma definição
 * ativa para a entidade (ou sem alcance ao registro) NÃO desenha nada — as telas
 * existentes ficam exatamente como eram. Uma falha ao carregar não derruba a
 * página inteira: aparece como aviso só nesta seção.
 */
export async function CustomFieldsSection({
  entity,
  recordId,
  canEdit,
  className = "rounded-lg border border-border bg-surface p-4",
}: Props) {
  let fields;
  try {
    fields = await getCustomFieldValues(entity, recordId);
  } catch {
    return (
      <section className={className}>
        <h2 className="mb-3 text-body font-semibold text-text">Campos personalizados</h2>
        <Alert variant="danger">
          <AlertDescription>Não foi possível carregar os campos personalizados. Recarregue a página.</AlertDescription>
        </Alert>
      </section>
    );
  }

  if (fields === null || fields.length === 0) return null;

  return (
    <section className={className} aria-label="Campos personalizados">
      <h2 className="mb-3 text-body font-semibold text-text">Campos personalizados</h2>
      <CustomFieldsForm entity={entity} recordId={recordId} fields={fields} canEdit={canEdit} />
    </section>
  );
}
