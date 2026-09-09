import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createHfRouter } from "../hireflow.env.js";
import { db } from "../../src/db/client.js";
import { requirePermission } from "../middleware/permissions.middleware.js";
import { emitActivity, emitAudit } from "../shared/activity.js";

const router = createHfRouter();

const competencySchema = z.object({
  name:        z.string().min(1).max(255),
  description: z.string().optional().nullable(),
  ratingMin:   z.number().int().min(1).default(1),
  ratingMax:   z.number().int().max(10).default(5),
  weight:      z.number().min(0.1).max(10).default(1),
  isRequired:  z.boolean().default(true),
  position:    z.number().int().min(0).default(0),
});

const createTemplateSchema = z.object({
  name:         z.string().min(1).max(255),
  description:  z.string().optional().nullable(),
  isDefault:    z.boolean().default(false),
  competencies: z.array(competencySchema).min(1),
});

// ─── GET /scorecards ───────────────────────────────────────────────────────────

router.get("/", requirePermission("scorecard.manage"), async (c) => {
  const orgId = c.get("orgId");
  const templates = await db.hfScorecardTemplate.findMany({
    where: { organizationId: orgId },
    include: { competencies: { orderBy: { position: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  return c.json(templates);
});

// ─── POST /scorecards ──────────────────────────────────────────────────────────

router.post("/", requirePermission("scorecard.manage"), zValidator("json", createTemplateSchema), async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const body  = c.req.valid("json");

  // Ensure only one default per org
  if (body.isDefault) {
    await db.hfScorecardTemplate.updateMany({
      where: { organizationId: orgId, isDefault: true },
      data:  { isDefault: false },
    });
  }

  const template = await db.hfScorecardTemplate.create({
    data: {
      organizationId: orgId,
      name:           body.name,
      description:    body.description ?? null,
      isDefault:      body.isDefault,
      competencies: {
        create: body.competencies.map(c => ({
          name: c.name, description: c.description ?? null,
          ratingMin: c.ratingMin, ratingMax: c.ratingMax,
          weight: c.weight, isRequired: c.isRequired, position: c.position,
        })),
      },
    },
    include: { competencies: { orderBy: { position: "asc" } } },
  });

  void emitAudit(orgId, user.id, "SCORECARD_CREATED", "scorecard", template.id, null, template);
  return c.json(template, 201);
});

// ─── GET /scorecards/:id ───────────────────────────────────────────────────────

router.get("/:id", requirePermission("scorecard.manage"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const template = await db.hfScorecardTemplate.findFirst({
    where: { id, organizationId: orgId },
    include: { competencies: { orderBy: { position: "asc" } } },
  });
  if (!template) return c.json({ error: "not_found" }, 404);
  return c.json(template);
});

// ─── PATCH /scorecards/:id ────────────────────────────────────────────────────

router.patch("/:id", requirePermission("scorecard.manage"), zValidator("json", createTemplateSchema.partial()), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const body  = c.req.valid("json");

  const existing = await db.hfScorecardTemplate.findFirst({ where: { id, organizationId: orgId } });
  if (!existing) return c.json({ error: "not_found" }, 404);

  if (body.isDefault) {
    await db.hfScorecardTemplate.updateMany({
      where: { organizationId: orgId, isDefault: true, NOT: { id } },
      data:  { isDefault: false },
    });
  }

  const template = await db.hfScorecardTemplate.update({
    where: { id },
    data: {
      ...(body.name        !== undefined ? { name: body.name }               : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.isDefault   !== undefined ? { isDefault: body.isDefault }     : {}),
    },
    include: { competencies: { orderBy: { position: "asc" } } },
  });

  return c.json(template);
});

// ─── DELETE /scorecards/:id ───────────────────────────────────────────────────

router.delete("/:id", requirePermission("scorecard.manage"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const existing = await db.hfScorecardTemplate.findFirst({ where: { id, organizationId: orgId } });
  if (!existing) return c.json({ error: "not_found" }, 404);

  await db.hfScorecardTemplate.delete({ where: { id } });
  return c.body(null, 204);
});

export { router as scorecardsRouter };
