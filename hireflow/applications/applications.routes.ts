import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createHfRouter } from "../hireflow.env.js";
import { db } from "../../src/db/client.js";
import { getOrCreateDefaultPipeline } from "../pipelines/pipelines.service.js";

const router = createHfRouter();

const createApplicationSchema = z.object({
  candidateId: z.string().uuid(),
  jobId:       z.string().uuid(),
  source:      z.string().max(100).optional().nullable(),
  coverNote:   z.string().optional().nullable(),
});

// ─── GET /applications ────────────────────────────────────────────────────────

router.get("/", async (c) => {
  const orgId  = c.get("orgId");
  const jobId  = c.req.query("jobId");
  const status = c.req.query("status");
  const stageId = c.req.query("stageId");

  const applications = await db.hfApplication.findMany({
    where: {
      organizationId: orgId,
      deletedAt: null,
      ...(jobId   ? { jobId }          : {}),
      ...(status  ? { status }         : {}),
      ...(stageId ? { currentStageId: stageId } : {}),
    },
    include: {
      candidate:    { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
      job:          { select: { id: true, title: true, department: true, status: true } },
      currentStage: { select: { id: true, name: true, stageKey: true, position: true } },
    },
    orderBy: { appliedAt: "desc" },
  });

  return c.json(applications.map(app => ({
    id:             app.id,
    status:         app.status,
    source:         app.source,
    coverNote:      app.coverNote,
    appliedAt:      app.appliedAt,
    candidate:      app.candidate,
    job:            app.job,
    currentStage:   app.currentStage,
    createdAt:      app.createdAt,
    updatedAt:      app.updatedAt,
  })));
});

// ─── POST /applications ───────────────────────────────────────────────────────

router.post("/", zValidator("json", createApplicationSchema), async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const body  = c.req.valid("json");

  // Validate candidate and job belong to org
  const [candidate, job] = await Promise.all([
    db.hfCandidate.findFirst({ where: { id: body.candidateId, organizationId: orgId, deletedAt: null } }),
    db.hfJob.findFirst({       where: { id: body.jobId,       organizationId: orgId, deletedAt: null }, include: { pipeline: { include: { stages: { orderBy: { position: "asc" } } } } } }),
  ]);
  if (!candidate) return c.json({ error: "candidate_not_found" }, 404);
  if (!job)       return c.json({ error: "job_not_found" }, 404);

  // Prevent duplicate applications
  const dup = await db.hfApplication.findFirst({
    where: { candidateId: body.candidateId, jobId: body.jobId, deletedAt: null },
  });
  if (dup) return c.json({ error: "duplicate_application" }, 409);

  // Get the first stage (Applied)
  let firstStage = job.pipeline?.stages[0];
  if (!firstStage) {
    const pipeline = await getOrCreateDefaultPipeline(orgId);
    firstStage = pipeline.stages[0];
  }

  const application = await db.hfApplication.create({
    data: {
      organizationId: orgId,
      candidateId:    body.candidateId,
      jobId:          body.jobId,
      currentStageId: firstStage.id,
      status:         "active",
      source:         body.source ?? null,
      coverNote:      body.coverNote ?? null,
      appliedAt:      new Date(),
    },
    include: {
      candidate:    { select: { id: true, firstName: true, lastName: true, email: true } },
      job:          { select: { id: true, title: true } },
      currentStage: { select: { id: true, name: true, stageKey: true, position: true } },
    },
  });

  // Record initial stage history
  await db.hfApplicationStageHistory.create({
    data: {
      organizationId:  orgId,
      applicationId:   application.id,
      fromStageId:     null,
      toStageId:       firstStage.id,
      changedByUserId: user.id,
      reason:          "Application submitted",
    },
  });

  // Log activity
  void db.hfApplicationActivity.create({
    data: {
      organizationId: orgId,
      applicationId:  application.id,
      activityType:   "APPLICATION_CREATED",
      actorUserId:    user.id,
      metadata:       { jobTitle: job.title, candidateName: `${candidate.firstName} ${candidate.lastName}` },
    },
  }).catch(() => {});

  return c.json({
    id:           application.id,
    status:       application.status,
    source:       application.source,
    coverNote:    application.coverNote,
    appliedAt:    application.appliedAt,
    candidate:    application.candidate,
    job:          application.job,
    currentStage: application.currentStage,
    createdAt:    application.createdAt,
    updatedAt:    application.updatedAt,
  }, 201);
});

// ─── GET /applications/:appId ─────────────────────────────────────────────────

router.get("/:appId", async (c) => {
  const orgId = c.get("orgId");
  const appId = c.req.param("appId");

  const app = await db.hfApplication.findFirst({
    where: { id: appId, organizationId: orgId, deletedAt: null },
    include: {
      candidate:    { include: { tagAssignments: { include: { tag: true } }, documents: { where: { deletedAt: null } } } },
      job:          { include: { pipeline: { include: { stages: { orderBy: { position: "asc" } } } } } },
      currentStage: true,
      stageHistory: {
        include: { toStage: true, fromStage: true },
        orderBy: { createdAt: "asc" },
      },
      activities:   { orderBy: { createdAt: "desc" }, take: 50 },
      interviews:   { orderBy: { scheduledStart: "desc" } },
      tasks:        { where: { completedAt: null }, orderBy: { dueAt: "asc" } },
    },
  });

  if (!app) return c.json({ error: "not_found" }, 404);

  return c.json({
    id:           app.id,
    status:       app.status,
    source:       app.source,
    coverNote:    app.coverNote,
    appliedAt:    app.appliedAt,
    candidate: {
      ...app.candidate,
      tags: app.candidate.tagAssignments.map(ta => ta.tag.name),
    },
    job:          app.job,
    currentStage: app.currentStage,
    stageHistory: app.stageHistory,
    activities:   app.activities,
    interviews:   app.interviews,
    tasks:        app.tasks,
    createdAt:    app.createdAt,
    updatedAt:    app.updatedAt,
  });
});

// ─── POST /applications/:appId/stage ──────────────────────────────────────────

router.post("/:appId/stage", zValidator("json", z.object({
  stageId: z.string().uuid(),
  reason: z.string().optional().nullable(),
})), async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const appId = c.req.param("appId");
  const body  = c.req.valid("json");

  const application = await db.hfApplication.findFirst({
    where: { id: appId, organizationId: orgId, deletedAt: null },
    include: { job: { include: { pipeline: { include: { stages: true } } } } },
  });
  if (!application)               return c.json({ error: "not_found" }, 404);
  if (application.status !== "active") return c.json({ error: "application_not_active" }, 400);

  // Validate the target stage belongs to the job's pipeline
  const targetStage = application.job.pipeline?.stages.find(s => s.id === body.stageId);
  if (!targetStage) return c.json({ error: "stage_not_found" }, 404);

  const fromStageId = application.currentStageId;

  // Update application + create immutable history entry atomically
  const [updated] = await db.$transaction([
    db.hfApplication.update({
      where: { id: appId },
      data: { currentStageId: body.stageId },
      include: { currentStage: { select: { id: true, name: true, stageKey: true, position: true } } },
    }),
    db.hfApplicationStageHistory.create({
      data: {
        organizationId:  orgId,
        applicationId:   appId,
        fromStageId,
        toStageId:       body.stageId,
        changedByUserId: user.id,
        reason:          body.reason ?? null,
      },
    }),
  ]);

  void db.hfApplicationActivity.create({
    data: {
      organizationId: orgId,
      applicationId:  appId,
      activityType:   "STAGE_CHANGED",
      actorUserId:    user.id,
      metadata:       { toStage: targetStage.name, toStageKey: targetStage.stageKey },
    },
  }).catch(() => {});

  return c.json({ id: updated.id, status: updated.status, currentStage: updated.currentStage });
});

// ─── POST /applications/:appId/reject ─────────────────────────────────────────

router.post("/:appId/reject", zValidator("json", z.object({
  reason: z.string().max(1000).optional().nullable(),
})), async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const appId = c.req.param("appId");
  const body  = c.req.valid("json");

  const application = await db.hfApplication.findFirst({
    where: { id: appId, organizationId: orgId, deletedAt: null },
  });
  if (!application)               return c.json({ error: "not_found" }, 404);
  if (application.status === "rejected") return c.json({ error: "already_rejected" }, 400);
  if (application.status === "hired")    return c.json({ error: "already_hired" }, 400);

  const updated = await db.hfApplication.update({
    where: { id: appId },
    data: { status: "rejected", rejectedAt: new Date(), rejectionReason: body.reason ?? null },
  });

  void db.hfApplicationActivity.create({
    data: {
      organizationId: orgId,
      applicationId:  appId,
      activityType:   "APPLICATION_REJECTED",
      actorUserId:    user.id,
      metadata:       { reason: body.reason },
    },
  }).catch(() => {});

  return c.json({ id: updated.id, status: updated.status });
});

// ─── POST /applications/:appId/hire ───────────────────────────────────────────

router.post("/:appId/hire", async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const appId = c.req.param("appId");

  const application = await db.hfApplication.findFirst({
    where: { id: appId, organizationId: orgId, deletedAt: null },
    include: {
      job: { include: { pipeline: { include: { stages: { where: { terminalType: "hired" } } } } } },
    },
  });
  if (!application)            return c.json({ error: "not_found" }, 404);
  if (application.status === "hired") return c.json({ error: "already_hired" }, 400);

  // Move to terminal "hired" stage if pipeline has one
  const hiredStage = application.job.pipeline?.stages[0];
  const fromStageId = application.currentStageId;

  const updates: Parameters<typeof db.hfApplication.update>[0]["data"] = {
    status:   "hired",
    hiredAt:  new Date(),
    ...(hiredStage ? { currentStageId: hiredStage.id } : {}),
  };

  const [updated] = await db.$transaction([
    db.hfApplication.update({
      where: { id: appId },
      data: updates,
      include: { currentStage: { select: { id: true, name: true, stageKey: true } } },
    }),
    ...(hiredStage ? [db.hfApplicationStageHistory.create({
      data: {
        organizationId:  orgId,
        applicationId:   appId,
        fromStageId,
        toStageId:       hiredStage.id,
        changedByUserId: user.id,
        reason:          "Candidate hired",
      },
    })] : []),
  ]);

  void db.hfApplicationActivity.create({
    data: {
      organizationId: orgId,
      applicationId:  appId,
      activityType:   "CANDIDATE_HIRED",
      actorUserId:    user.id,
      metadata:       {},
    },
  }).catch(() => {});

  return c.json({ id: updated.id, status: updated.status, currentStage: updated.currentStage });
});

// ─── DELETE /applications/:appId (soft) ───────────────────────────────────────

router.delete("/:appId", async (c) => {
  const orgId = c.get("orgId");
  const appId = c.req.param("appId");

  const existing = await db.hfApplication.findFirst({
    where: { id: appId, organizationId: orgId, deletedAt: null },
  });
  if (!existing) return c.json({ error: "not_found" }, 404);

  await db.hfApplication.update({
    where: { id: appId },
    data: { deletedAt: new Date() },
  });

  return c.body(null, 204);
});

// ─── POST /applications/bulk ───────────────────────────────────────────────────

router.post("/bulk", zValidator("json", z.object({
  ids:    z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(["move_stage", "reject", "assign_recruiter", "tag"]),
  payload: z.record(z.unknown()).optional(),
})), async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const { ids, action, payload } = c.req.valid("json");

  const apps = await db.hfApplication.findMany({
    where: { id: { in: ids }, organizationId: orgId, deletedAt: null },
  });
  const found   = apps.map(a => a.id);
  const missing = ids.filter(id => !found.includes(id));
  let   updated = 0;

  if (action === "move_stage") {
    const stageId = payload?.stageId as string;
    if (!stageId) return c.json({ error: "stageId required" }, 400);

    await db.$transaction(
      apps.map(app => db.hfApplication.update({
        where: { id: app.id },
        data:  { currentStageId: stageId },
      }))
    );
    await db.hfApplicationStageHistory.createMany({
      data: apps.map(app => ({
        organizationId:  orgId,
        applicationId:   app.id,
        fromStageId:     app.currentStageId,
        toStageId:       stageId,
        changedByUserId: user.id,
        reason:          "Bulk stage move",
      })),
    });
    updated = apps.length;

  } else if (action === "reject") {
    const reason = (payload?.reason as string) ?? null;
    ({ count: updated } = await db.hfApplication.updateMany({
      where: { id: { in: found }, status: "active" },
      data:  { status: "rejected", rejectedAt: new Date(), rejectionReason: reason },
    }));

  } else if (action === "assign_recruiter") {
    // Records on job, not application — update job.recruiterUserId isn't useful here.
    // Instead store as metadata in activities.
    updated = apps.length;
  }

  void db.hfApplicationActivity.createMany({
    data: found.map(applicationId => ({
      organizationId: orgId,
      applicationId,
      activityType:   `BULK_${action.toUpperCase()}`,
      actorUserId:    user.id,
      metadata:       { payload: payload ?? null } as never,
    })),
  }).catch(() => {});

  return c.json({ updated, missing });
});

export { router as applicationsRouter };
