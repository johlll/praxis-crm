import type { Campaign, Metrics, TrafficDataset } from "./report";
import { addDays } from "./schema";

/**
 * Tráfego Pago — dados FICTÍCIOS de demonstração (docs/decisoes/trafego-pago.md). Vivem só no código: nada é
 * gravado no banco e nenhuma plataforma é consultada. A página só entrega este conjunto a escritórios com
 * `workspaces.is_demo = true` (coluna que o app não consegue alterar).
 *
 * O conjunto é relativo a "hoje" e determinístico: 180 dias em seis blocos de 30. Os dois blocos mais recentes
 * têm totais fixos (os "últimos 30 dias" e o período anterior deles); os mais antigos são frações do anterior.
 */

export const DEMO_COVERAGE_DAYS = 180;
const BLOCK_DAYS = 30;

type Totals = readonly [investmentCents: number, conversations: number, qualifiedLeads: number, contracts: number];

type DemoCampaign = Campaign & {
  /** Dias sem veiculação no fim (pausada ou encerrada há N dias). */
  idleDays: number;
  last30: Totals;
  previous30: Totals;
};

const CAMPAIGNS: readonly DemoCampaign[] = [
  {
    id: "demo-1",
    name: "Usucapião – Captação de Leads",
    platform: "meta",
    legalArea: "Usucapião",
    status: "ativa",
    idleDays: 0,
    last30: [248_000, 104, 41, 7],
    previous30: [220_000, 90, 33, 5],
  },
  {
    id: "demo-2",
    name: "Inventário – Consultoria Inicial",
    platform: "google",
    legalArea: "Inventário",
    status: "ativa",
    idleDays: 0,
    last30: [192_000, 78, 32, 6],
    previous30: [171_000, 66, 26, 4],
  },
  {
    id: "demo-3",
    name: "Direito Imobiliário – Avaliação de Caso",
    platform: "meta",
    legalArea: "Imobiliário",
    status: "ativa",
    idleDays: 0,
    last30: [178_520, 62, 28, 4],
    previous30: [160_957, 52, 22, 3],
  },
  {
    id: "demo-4",
    name: "Inventário Extrajudicial – Alta Conversão",
    platform: "google",
    legalArea: "Inventário",
    status: "pausada",
    idleDays: 3,
    last30: [98_000, 44, 18, 3],
    previous30: [86_000, 34, 14, 2],
  },
  {
    id: "demo-5",
    name: "Usucapião Extrajudicial – Oportunidades",
    platform: "google",
    legalArea: "Usucapião",
    status: "encerrada",
    idleDays: 8,
    last30: [72_480, 30, 8, 1],
    previous30: [64_000, 26, 7, 1],
  },
];

/** Blocos 3º a 6º (do mais recente ao mais antigo), como fração do período anterior. */
const OLDER_FACTORS = [0.93, 0.88, 0.8, 0.72] as const;

/** Ruído determinístico pequeno (0..mod-1). */
function noise(a: number, b: number, c: number, mod: number): number {
  let x = (a * 73_856_093) ^ (b * 19_349_663) ^ (c * 83_492_791);
  x = Math.imul(x ^ (x >>> 13), 1_274_126_177);
  return ((x ^ (x >>> 16)) >>> 0) % mod;
}

/**
 * Reparte um total inteiro pelos pesos, em ordem cronológica, por arredondamento acumulado: a soma é EXATA e
 * contagens pequenas ficam espalhadas pelo período em vez de amontoadas.
 */
function spread(total: number, weights: readonly number[], phase: number): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  let cumulative = 0;
  let given = 0;
  return weights.map((w, i) => {
    cumulative += w;
    const upTo = i === weights.length - 1 ? total : Math.floor((total * cumulative) / sum + phase);
    const value = upTo - given;
    given = upTo;
    return value;
  });
}

export function buildDemoDataset(today: string): TrafficDataset {
  const daily: TrafficDataset["daily"] = [];

  CAMPAIGNS.forEach((campaign, c) => {
    const blocks: Totals[] = [
      campaign.last30,
      campaign.previous30,
      ...OLDER_FACTORS.map((f) => campaign.previous30.map((v) => Math.round(v * f)) as unknown as Totals),
    ];
    blocks.forEach((totals, block) => {
      const idle = block === 0 ? campaign.idleDays : 0;
      // Deslocamentos em dias atrás de hoje, do mais antigo ao mais recente.
      const offsets: number[] = [];
      for (let o = block * BLOCK_DAYS + BLOCK_DAYS - 1; o >= block * BLOCK_DAYS + idle; o -= 1) offsets.push(o);
      const series = totals.map((total, metric) =>
        spread(
          total,
          // Leve alta ao longo do bloco, com variação de um dia para o outro.
          offsets.map((o, i) => 20 + Math.round((10 * i) / offsets.length) + noise(c + 1, metric + 1, o + 1, 14)),
          ((c * 2 + metric * 3) % 10) / 10 + 0.05,
        ),
      );
      offsets.forEach((offset, i) => {
        const metrics: Metrics = {
          investmentCents: series[0]![i]!,
          conversations: series[1]![i]!,
          qualifiedLeads: series[2]![i]!,
          contracts: series[3]![i]!,
        };
        daily.push({ campaignId: campaign.id, date: addDays(today, -offset), ...metrics });
      });
    });
  });

  return {
    coverage: { from: addDays(today, -(DEMO_COVERAGE_DAYS - 1)), to: today },
    campaigns: CAMPAIGNS.map(({ id, name, platform, legalArea, status }) => ({ id, name, platform, legalArea, status })),
    daily,
  };
}
