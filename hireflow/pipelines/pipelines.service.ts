import { db } from "../../src/db/client.js";

const DEFAULT_STAGES = [
  { name: "Applied",    stageKey: "applied",    position: 1 },
  { name: "Screening",  stageKey: "screening",  position: 2 },
  { name: "Interview",  stageKey: "interview",  position: 3 },
  { name: "Assessment", stageKey: "assessment", position: 4 },
  { name: "Offer",      stageKey: "offer",      position: 5 },
  { name: "Hired",      stageKey: "hired",      position: 6, isTerminal: true, terminalType: "hired" },
];

/**
 * Returns the org's default pipeline, creating it (with standard stages) if
 * it doesn't exist yet. This is the pipeline attached to every new job unless
 * the caller provides an explicit pipelineId.
 */
export async function getOrCreateDefaultPipeline(organizationId: string) {
  const existing = await db.hfPipeline.findFirst({
    where: { organizationId, isTemplate: true, isActive: true },
    include: { stages: { orderBy: { position: "asc" } } },
  });
  if (existing) return existing;

  return db.hfPipeline.create({
    data: {
      organizationId,
      name: "Standard Hiring Pipeline",
      isTemplate: true,
      isActive: true,
      stages: {
        create: DEFAULT_STAGES.map(s => ({ ...s, organizationId })),
      },
    },
    include: { stages: { orderBy: { position: "asc" } } },
  });
}
