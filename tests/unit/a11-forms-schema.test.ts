import { describe, expect, it } from "vitest";

import { correctLinkSchema, formEndpointSchema, setStatusSchema } from "@/modules/forms/schema";
import { submissionSchema } from "@/server/ingest/submission";

/**
 * Ids internos (pipeline, etapa, endpoint, touchpoint, lead...) seguem o
 * formato solto de src/lib/uuid.ts: os ids fixos do seed e dos dados
 * demonstrativos não têm versão RFC válida, e `z.string().uuid()` do Zod 4
 * os recusa. Foi o que derrubou o e2e "owner configura um formulário": a
 * tela respondia "Confira os campos" com o pipeline do seed.
 *
 * Já o source_event_id vem do navegador por crypto.randomUUID() e continua
 * exigindo UUID v4 válido (contrato §4).
 */
const SEED_PIPELINE = "50000000-0000-0000-0000-000000000010";
const SEED_STAGE = "51000000-0000-0000-0000-000000000010";

const valid = {
  name: "Captação",
  pipelineId: SEED_PIPELINE,
  stageId: SEED_STAGE,
  legalArea: "Trabalhista",
  initialActivityType: "call",
  initialActivityDueMinutes: "90",
  captureMode: "new_intake",
  turnstileAction: "formulario",
  allowedHostnames: "localhost",
};

describe("ids internos das telas de formulário", () => {
  it("aceita pipeline e etapa com os ids fixos do seed", () => {
    expect(formEndpointSchema.safeParse(valid).success).toBe(true);
  });

  it("continua recusando texto que não tem formato de id", () => {
    expect(formEndpointSchema.safeParse({ ...valid, pipelineId: "pipeline-1" }).success).toBe(false);
  });

  it("status e correção de vínculo aceitam ids do seed", () => {
    expect(setStatusSchema.safeParse({ formEndpointId: SEED_PIPELINE, status: "disabled" }).success).toBe(true);
    expect(
      correctLinkSchema.safeParse({
        touchpointId: SEED_PIPELINE,
        expectedCurrentLinkId: "",
        action: "assign",
        opportunityId: SEED_STAGE,
        leadId: SEED_STAGE,
      }).success,
    ).toBe(true);
  });
});

describe("source_event_id do navegador", () => {
  it("continua exigindo UUID v4 válido", () => {
    const sourceEventId = submissionSchema.shape.sourceEventId;
    expect(sourceEventId.safeParse(crypto.randomUUID()).success).toBe(true);
    expect(sourceEventId.safeParse(SEED_PIPELINE).success).toBe(false);
  });
});
