import { describe, expect, it } from "vitest";

import {
  answersConfigSchema,
  buildAnswersSchema,
  correctLinkSchema,
  formEndpointSchema,
  setStatusSchema,
} from "@/modules/forms/schema";
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

describe("answers_config (item 6 da auditoria pós-dry-run)", () => {
  it("aceita uma configuração válida", () => {
    const result = answersConfigSchema.safeParse({
      fields: [{ key: "motivo", label: "Motivo", type: "text", required: true, maxLength: 500 }],
    });
    expect(result.success).toBe(true);
  });

  it("recusa chave fora do padrão (só minúsculas/números/underscore)", () => {
    expect(
      answersConfigSchema.safeParse({ fields: [{ key: "Motivo Legal", label: "x", type: "text" }] }).success,
    ).toBe(false);
  });

  it("recusa tipo fora da lista fechada", () => {
    expect(
      answersConfigSchema.safeParse({ fields: [{ key: "anexo", label: "x", type: "arquivo" }] }).success,
    ).toBe(false);
  });

  it("recusa chaves duplicadas", () => {
    expect(
      answersConfigSchema.safeParse({
        fields: [
          { key: "motivo", label: "a", type: "text" },
          { key: "motivo", label: "b", type: "text" },
        ],
      }).success,
    ).toBe(false);
  });

  it("buildAnswersSchema recusa campo NÃO CONFIGURADO", () => {
    const schema = buildAnswersSchema({ fields: [{ key: "motivo", label: "Motivo", type: "text", required: false }] });
    expect(schema.safeParse({ motivo: "ok", campo_extra: "x" }).success).toBe(false);
  });

  it("buildAnswersSchema recusa OBRIGATÓRIO ausente", () => {
    const schema = buildAnswersSchema({ fields: [{ key: "motivo", label: "Motivo", type: "text", required: true }] });
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ motivo: "ok" }).success).toBe(true);
  });

  it("buildAnswersSchema recusa TIPO errado", () => {
    const schema = buildAnswersSchema({ fields: [{ key: "urgente", label: "Urgente?", type: "boolean", required: false }] });
    expect(schema.safeParse({ urgente: "sim" }).success).toBe(false);
    expect(schema.safeParse({ urgente: true }).success).toBe(true);
  });

  it("buildAnswersSchema recusa TEXTO acima do maxLength configurado", () => {
    const schema = buildAnswersSchema({
      fields: [{ key: "motivo", label: "Motivo", type: "text", required: false, maxLength: 10 }],
    });
    expect(schema.safeParse({ motivo: "a".repeat(11) }).success).toBe(false);
    expect(schema.safeParse({ motivo: "a".repeat(10) }).success).toBe(true);
  });

  it("formEndpointSchema aceita answersConfigJson serializado e o valida de novo", () => {
    const json = JSON.stringify({ fields: [{ key: "motivo", label: "Motivo", type: "text", required: true }] });
    const result = formEndpointSchema.safeParse({ ...valid, answersConfigJson: json });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.answersConfigJson.fields).toHaveLength(1);
    }
  });

  it("formEndpointSchema recusa answersConfigJson malformado", () => {
    expect(formEndpointSchema.safeParse({ ...valid, answersConfigJson: "{not json" }).success).toBe(false);
  });

  it("formEndpointSchema sem answersConfigJson usa a lista vazia (compatível com formulários já existentes)", () => {
    const result = formEndpointSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.answersConfigJson).toEqual({ fields: [] });
    }
  });
});
