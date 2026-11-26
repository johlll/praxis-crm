import type { Metadata } from "next";
import { FlaskConical } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { AttentionBanner, PeriodKpis, SecondaryStrip } from "@/components/dashboard/metric-cards";
import { FunnelCard } from "@/components/dashboard/funnel-card";
import { AttributionCard } from "@/components/dashboard/attribution-card";
import { getDashboardAttribution } from "@/modules/attribution/queries";
import { ATTRIBUTION_MODELS, NO_SOURCE_FILTER } from "@/modules/forms/schema";
import { SeriesCard } from "@/components/dashboard/series-card";
import { AttentionList } from "@/components/dashboard/attention-list";
import { AgendaToday } from "@/components/dashboard/agenda-today";
import { InsightsSection, TeamTable } from "@/components/dashboard/team-and-insights";
import { DashboardFilterBar } from "@/components/dashboard/filter-bar";
import { PeriodProblem, REJECTED_PERIOD_MESSAGE, UNAVAILABLE_PERIOD_MESSAGE } from "@/components/dashboard/period-problem";
import { OpportunityPanel } from "@/components/dashboard/opportunity-panel";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { roleHasPermission } from "@/lib/roles";
import { dateTimeInputParts, formatDateTime } from "@/lib/timezone";
import { PeriodRangeError } from "@/modules/dashboard/period-query";
import { getDashboard } from "@/modules/dashboard/queries";
import { dashboardHref, parseDashboardFilters, type DashboardFilters } from "@/modules/dashboard/schema";
import { buildInsights, daysSince, greeting, periodTexts } from "@/modules/dashboard/presentation";
import { getOpportunity } from "@/modules/opportunities/queries";
import { listTeamMembers } from "@/modules/team/queries";

export const metadata: Metadata = {
  title: "Visão geral — Praxis CRM Jurídico",
};

function SectionLabel({ title, detail }: { title: string; detail: string }) {
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-meta text-text-tertiary">
      <span className="text-label font-semibold tracking-[1.3px] text-text-secondary uppercase">{title}</span>
      <span>{detail}</span>
    </p>
  );
}

type ShellUser = Awaited<ReturnType<typeof getShellContext>>["user"];

/** A página com o motivo de o período pedido não aparecer: sem indicador nenhum. */
function ProblemPage({ user, filters, message }: { user: ShellUser; filters: DashboardFilters; message: string }) {
  return (
    <>
      <Topbar title="Visão geral" subtitle="Acompanhe o desempenho comercial do escritório" user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
          <PeriodProblem filters={filters} today={dateTimeInputParts(new Date().toISOString(), false).date} message={message} />
        </div>
      </main>
    </>
  );
}

/**
 * Visão geral (A10). Tudo vem de public.get_dashboard — alcance por
 * registro e projeção financeira aplicados no banco antes de qualquer
 * agregação. Indicadores do período e posições atuais ficam em blocos
 * separados e rotulados; posições nunca têm comparação com o passado.
 */
export default async function VisaoGeralPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const filters = parseDashboardFilters(await searchParams);
  // Datas inválidas no endereço: nem se consulta o banco.
  if (filters.rangeError) return <ProblemPage user={user} filters={filters} message={filters.rangeError} />;

  const load = () =>
    Promise.all([
      getDashboard(workspaceId, filters),
      // A11: bloco de origem. Falha de consulta vira erro tratado pelo
      // error.tsx da rota, nunca "nenhuma origem".
      getDashboardAttribution(workspaceId, {
        periodDays: filters.periodDays,
        range: filters.range,
        model: filters.attributionModel,
        source: filters.source,
        assignedTo: filters.assignedTo,
        onlyUnassigned: filters.onlyUnassigned,
        legalArea: filters.legalArea,
      }),
      listTeamMembers(workspaceId, user.id),
      filters.selectedOpportunityId ? getOpportunity(filters.selectedOpportunityId) : Promise.resolve(null),
    ]);
  let loaded: Awaited<ReturnType<typeof load>>;
  try {
    loaded = await load();
  } catch (error) {
    if (!(error instanceof PeriodRangeError)) throw error;
    const message = error.reason === "unavailable" ? UNAVAILABLE_PERIOD_MESSAGE : REJECTED_PERIOD_MESSAGE;
    return <ProblemPage user={user} filters={filters} message={message} />;
  }
  const [dashboard, attribution, members, selectedRaw] = loaded;
  const texts = periodTexts(dashboard.period);
  // Uma oportunidade de outro escritório do mesmo usuário não aparece aqui.
  const selected = selectedRaw && selectedRaw.workspaceId === workspaceId ? selectedRaw : null;

  const closeHref = dashboardHref(filters, { selectedOpportunityId: null });
  const attentionHrefs = Object.fromEntries(
    dashboard.attention.items.map((item) => [item.id, dashboardHref(filters, { selectedOpportunityId: item.id })]),
  );
  const pipelineHrefs = Object.fromEntries(
    dashboard.pipelines.map((p) => [
      p.id,
      dashboardHref(filters, { pipelineId: p.isDefault ? null : p.id, selectedOpportunityId: null }),
    ]),
  );

  // A11: modelo e origem viajam na URL, como os demais filtros — assim
  // aplicar, limpar, voltar e avançar continuam sincronizados.
  const modelHrefs = Object.fromEntries(
    ATTRIBUTION_MODELS.map((model) => [
      model,
      dashboardHref(filters, { attributionModel: model, selectedOpportunityId: null }),
    ]),
  );
  const sourceHrefs = Object.fromEntries(
    attribution.sources.map((row) => [
      row.source ?? NO_SOURCE_FILTER,
      dashboardHref(filters, { source: row.source ?? NO_SOURCE_FILTER, selectedOpportunityId: null }),
    ]),
  );
  const clearSourceHref = dashboardHref(filters, { source: null, selectedOpportunityId: null });

  const firstName = user.fullName.split(/\s+/)[0] ?? user.fullName;
  const hasActiveFilters = Boolean(filters.assignedTo || filters.onlyUnassigned || filters.legalArea || filters.range || filters.periodDays !== 30);

  return (
    <>
      <Topbar
        title={greeting(new Date(dashboard.generatedAt), firstName)}
        subtitle="Visão geral · acompanhe o desempenho comercial do escritório"
        user={user}
      />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
          {dashboard.isDemo ? (
            <p
              role="note"
              className="m-0 flex items-center gap-2 rounded-md border border-purple/30 bg-purple-bg px-3 py-2 text-small text-purple"
            >
              <FlaskConical size={14} aria-hidden />
              <strong>Dados demonstrativos.</strong> Este escritório existe só para demonstração: todos os nomes e números são
              fictícios.
            </p>
          ) : null}

          <DashboardFilterBar
            filters={filters}
            members={members
              .filter((m) => m.role !== "viewer")
              .map((m) => ({ userId: m.userId, name: m.fullName ?? m.email }))}
            legalAreas={dashboard.legalAreas}
            hasActiveFilters={hasActiveFilters}
            today={dashboard.period.today}
          />

          <SectionLabel
            title="No período"
            detail={`${texts.current} · comparado com ${texts.previous} · cada indicador pela sua própria data`}
          />
          <PeriodKpis dashboard={dashboard} />

          <SectionLabel
            title="Agora"
            detail={`Posição em ${formatDateTime(dashboard.generatedAt)} · sem comparação com o passado`}
          />
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)]">
            <SecondaryStrip dashboard={dashboard} />
            <AttentionBanner dashboard={dashboard} />
          </div>

          {/* Funil em painel largo: as etapas reais do pipeline, com os nomes inteiros. */}
          <FunnelCard dashboard={dashboard} pipelineHrefs={pipelineHrefs} />

          {/* Gráficos e painel operacional lado a lado (três colunas a partir de 1280 px). */}
          <div className="grid items-stretch gap-4 md:grid-cols-2 lg:grid-cols-3">
            <SeriesCard dashboard={dashboard} />
            <AttributionCard
              attribution={attribution}
              modelHrefs={modelHrefs}
              sourceHrefs={sourceHrefs}
              clearSourceHref={clearSourceHref}
            />
            <div className="flex min-w-0 flex-col gap-4 md:col-span-2 lg:col-span-1">
              {selected ? (
                <OpportunityPanel
                  opportunity={selected}
                  canEdit={roleHasPermission(user.role, "opportunity.edit")}
                  closeHref={closeHref}
                  stalledDays={selected.status === "open" ? daysSince(selected.stageEnteredAt, dashboard.generatedAt) : null}
                />
              ) : null}
              <AttentionList dashboard={dashboard} hrefFor={attentionHrefs} selectedId={selected?.id ?? null} />
            </div>
          </div>

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <AgendaToday
              items={dashboard.agendaToday.items}
              total={dashboard.agendaToday.total}
              pending={dashboard.positions.todayActivitiesPending}
              canEdit={roleHasPermission(user.role, "activity.edit")}
            />
            <TeamTable rows={dashboard.team} periodLabel={dashboard.period.custom ? texts.current : `últimos ${dashboard.period.days} dias`} />
          </div>
          <InsightsSection insights={buildInsights(dashboard)} />
        </div>
      </main>
    </>
  );
}
