import type { Metadata } from "next";

import { Topbar } from "@/components/app-shell/topbar";
import { CustomFieldManager } from "@/components/custom-fields/custom-field-manager";
import { listCustomFieldDefinitions } from "@/modules/custom-fields/queries";
import { getShellContext } from "@/modules/shell/queries";
import { requirePermission } from "@/server/authz/permissions";

export const metadata: Metadata = { title: "Campos personalizados — Praxis CRM Jurídico" };

export default async function CamposPersonalizadosPage() {
  const { user } = await getShellContext();
  const membership = await requirePermission("custom_field.manage");
  const definitions = await listCustomFieldDefinitions(membership.workspaceId);
  return (
    <>
      <Topbar title="Campos personalizados" subtitle="Definições tipadas do workspace" user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-[720px]"><CustomFieldManager definitions={definitions} /></div>
      </main>
    </>
  );
}
