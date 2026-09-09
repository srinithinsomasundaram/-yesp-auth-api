import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createHfRouter } from "../hireflow.env.js";
import { db } from "../../src/db/client.js";

const router = createHfRouter();

const createCandidateSchema = z.object({
  firstName:   z.string().min(1).max(255),
  lastName:    z.string().min(1).max(255),
  email:       z.string().email().max(255),
  phone:       z.string().max(50).optional().nullable(),
  linkedinUrl: z.string().url().max(500).optional().nullable(),
  portfolioUrl:z.string().url().max(500).optional().nullable(),
  location:    z.string().max(255).optional().nullable(),
  source:      z.string().max(100).optional().nullable(),
  tags:        z.array(z.string().max(50)).optional(),
  notes:       z.string().optional().nullable(),
});

const patchCandidateSchema = createCandidateSchema.omit({ tags: true }).partial();

// ─── GET /candidates ──────────────────────────────────────────────────────────

router.get("/", async (c) => {
  const orgId = c.get("orgId");
  const q     = c.req.query("q");

  const candidates = await db.hfCandidate.findMany({
    where: {
      organizationId: orgId,
      deletedAt: null,
      ...(q ? {
        OR: [
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName:  { contains: q, mode: "insensitive" } },
          { email:     { contains: q, mode: "insensitive" } },
        ],
      } : {}),
    },
    include: {
      tagAssignments: { include: { tag: true } },
      _count: { select: { applications: { where: { deletedAt: null } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  return c.json(candidates.map(ca => ({
    id:           ca.id,
    firstName:    ca.firstName,
    lastName:     ca.lastName,
    email:        ca.email,
    phone:        ca.phone,
    linkedinUrl:  ca.linkedinUrl,
    portfolioUrl: ca.portfolioUrl,
    location:     ca.location,
    source:       ca.source,
    notes:        ca.notes,
    tags:         ca.tagAssignments.map(ta => ta.tag.name),
    createdAt:    ca.createdAt,
    updatedAt:    ca.updatedAt,
    _count:       ca._count,
  })));
});

// ─── POST /candidates ─────────────────────────────────────────────────────────

router.post("/", zValidator("json", createCandidateSchema), async (c) => {
  const orgId = c.get("orgId");
  const body  = c.req.valid("json");

  // Ensure email is unique within org
  const existing = await db.hfCandidate.findFirst({
    where: { organizationId: orgId, email: body.email, deletedAt: null },
  });
  if (existing) return c.json({ error: "duplicate_email" }, 409);

  const candidate = await db.hfCandidate.create({
    data: {
      organizationId: orgId,
      firstName:      body.firstName,
      lastName:       body.lastName,
      email:          body.email,
      phone:          body.phone ?? null,
      linkedinUrl:    body.linkedinUrl ?? null,
      portfolioUrl:   body.portfolioUrl ?? null,
      location:       body.location ?? null,
      source:         body.source ?? null,
      notes:          body.notes ?? null,
    },
  });

  // Attach tags
  if (body.tags?.length) {
    await attachTags(orgId, candidate.id, body.tags);
  }

  return c.json({
    id:           candidate.id,
    firstName:    candidate.firstName,
    lastName:     candidate.lastName,
    email:        candidate.email,
    phone:        candidate.phone,
    linkedinUrl:  candidate.linkedinUrl,
    portfolioUrl: candidate.portfolioUrl,
    location:     candidate.location,
    source:       candidate.source,
    notes:        candidate.notes,
    tags:         body.tags ?? [],
    createdAt:    candidate.createdAt,
    updatedAt:    candidate.updatedAt,
  }, 201);
});

// ─── GET /candidates/:candidateId ─────────────────────────────────────────────

router.get("/:candidateId", async (c) => {
  const orgId       = c.get("orgId");
  const candidateId = c.req.param("candidateId");

  const candidate = await db.hfCandidate.findFirst({
    where: { id: candidateId, organizationId: orgId, deletedAt: null },
    include: {
      tagAssignments:   { include: { tag: true } },
      documents:        { where: { deletedAt: null }, orderBy: { createdAt: "desc" } },
      applications:     {
        where: { deletedAt: null },
        include: {
          job:          { select: { id: true, title: true, status: true } },
          currentStage: { select: { id: true, name: true, stageKey: true, position: true } },
        },
        orderBy: { appliedAt: "desc" },
      },
    },
  });

  if (!candidate) return c.json({ error: "not_found" }, 404);

  return c.json({
    id:           candidate.id,
    firstName:    candidate.firstName,
    lastName:     candidate.lastName,
    email:        candidate.email,
    phone:        candidate.phone,
    linkedinUrl:  candidate.linkedinUrl,
    portfolioUrl: candidate.portfolioUrl,
    location:     candidate.location,
    source:       candidate.source,
    notes:        candidate.notes,
    tags:         candidate.tagAssignments.map(ta => ta.tag.name),
    documents:    candidate.documents,
    applications: candidate.applications.map(app => ({
      id:           app.id,
      status:       app.status,
      appliedAt:    app.appliedAt,
      job:          app.job,
      currentStage: app.currentStage,
    })),
    createdAt:    candidate.createdAt,
    updatedAt:    candidate.updatedAt,
  });
});

// ─── PATCH /candidates/:candidateId ──────────────────────────────────────────

router.patch("/:candidateId", zValidator("json", patchCandidateSchema), async (c) => {
  const orgId       = c.get("orgId");
  const candidateId = c.req.param("candidateId");
  const body        = c.req.valid("json");

  const existing = await db.hfCandidate.findFirst({
    where: { id: candidateId, organizationId: orgId, deletedAt: null },
  });
  if (!existing) return c.json({ error: "not_found" }, 404);

  // Unique email check if email is being changed
  if (body.email && body.email !== existing.email) {
    const dup = await db.hfCandidate.findFirst({
      where: { organizationId: orgId, email: body.email, deletedAt: null, NOT: { id: candidateId } },
    });
    if (dup) return c.json({ error: "duplicate_email" }, 409);
  }

  const candidate = await db.hfCandidate.update({
    where: { id: candidateId },
    data: {
      ...(body.firstName    !== undefined ? { firstName: body.firstName }       : {}),
      ...(body.lastName     !== undefined ? { lastName: body.lastName }         : {}),
      ...(body.email        !== undefined ? { email: body.email }               : {}),
      ...(body.phone        !== undefined ? { phone: body.phone }               : {}),
      ...(body.linkedinUrl  !== undefined ? { linkedinUrl: body.linkedinUrl }   : {}),
      ...(body.portfolioUrl !== undefined ? { portfolioUrl: body.portfolioUrl } : {}),
      ...(body.location     !== undefined ? { location: body.location }         : {}),
      ...(body.source       !== undefined ? { source: body.source }             : {}),
      ...(body.notes        !== undefined ? { notes: body.notes }               : {}),
    },
    include: { tagAssignments: { include: { tag: true } } },
  });

  return c.json({
    id:           candidate.id,
    firstName:    candidate.firstName,
    lastName:     candidate.lastName,
    email:        candidate.email,
    phone:        candidate.phone,
    linkedinUrl:  candidate.linkedinUrl,
    portfolioUrl: candidate.portfolioUrl,
    location:     candidate.location,
    source:       candidate.source,
    notes:        candidate.notes,
    tags:         candidate.tagAssignments.map(ta => ta.tag.name),
    createdAt:    candidate.createdAt,
    updatedAt:    candidate.updatedAt,
  });
});

// ─── DELETE /candidates/:candidateId (soft) ───────────────────────────────────

router.delete("/:candidateId", async (c) => {
  const orgId       = c.get("orgId");
  const candidateId = c.req.param("candidateId");

  const existing = await db.hfCandidate.findFirst({
    where: { id: candidateId, organizationId: orgId, deletedAt: null },
  });
  if (!existing) return c.json({ error: "not_found" }, 404);

  await db.hfCandidate.update({
    where: { id: candidateId },
    data: { deletedAt: new Date() },
  });

  return c.body(null, 204);
});

// ─── POST /candidates/:candidateId/tags ───────────────────────────────────────

router.post("/:candidateId/tags", zValidator("json", z.object({ tags: z.array(z.string().max(50)).min(1) })), async (c) => {
  const orgId       = c.get("orgId");
  const candidateId = c.req.param("candidateId");
  const { tags }    = c.req.valid("json");

  const candidate = await db.hfCandidate.findFirst({
    where: { id: candidateId, organizationId: orgId, deletedAt: null },
  });
  if (!candidate) return c.json({ error: "not_found" }, 404);

  await attachTags(orgId, candidateId, tags);

  const updated = await db.hfCandidate.findFirst({
    where: { id: candidateId },
    include: { tagAssignments: { include: { tag: true } } },
  });

  return c.json({ tags: updated!.tagAssignments.map(ta => ta.tag.name) });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

async function attachTags(orgId: string, candidateId: string, names: string[]) {
  for (const name of names) {
    const tag = await db.hfCandidateTag.upsert({
      where: { organizationId_name: { organizationId: orgId, name } },
      create: { organizationId: orgId, name },
      update: {},
    });
    await db.hfCandidateTagAssignment.upsert({
      where: { candidateId_tagId: { candidateId, tagId: tag.id } },
      create: { candidateId, tagId: tag.id },
      update: {},
    });
  }
}

export { router as candidatesRouter };
