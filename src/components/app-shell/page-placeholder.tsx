import { Topbar } from "./topbar";
import { EmptyState } from "@/components/feedback/empty-state";
import { getShellContext } from "@/modules/shell/queries";

type PagePlaceholderProps = {
  title: string;
  subtitle?: string;
  /** Em qual subfase esta tela será construída, ex.: "A5". */
  phase: string;
  description: string;
};

/**
 * Andaime das telas ainda não construídas. Mostra a estrutura navegável sem
 * inventar dados: nenhuma métrica fictícia aparece como se fosse real.
 * Cada página substitui este componente pela tela verdadeira na sua fase.
 */
export async function PagePlaceholder({
  title,
  subtitle,
  phase,
  description,
}: PagePlaceholderProps) {
  const { user } = await getShellContext();

  return (
    <>
      <Topbar title={title} {...(subtitle ? { subtitle } : {})} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <EmptyState
          title={`${title} — em construção (fase ${phase})`}
          description={description}
        />
      </main>
    </>
  );
}
