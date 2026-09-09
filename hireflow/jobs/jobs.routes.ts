import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createHfRouter } from "../hireflow.env.js";
import { db } from "../../src/db/client.js";
import { getOrCreateDefaultPipeline } from "../pipelines/pipelines.service.js";

const router = createHfRouter();

const JOB_STATUSES = ["draft", "open", "on_hold", "closed", "cancelled"] as const;
const EMP_TYPES    = ["full_time", "part_time", "contract", "internship"]  as const;
const WORK_MODES   = ["onsite", "remote", "hybrid"]                        as const;

const createJobSchema = z.object({
  title:               z.string().min(1).max(255),
  department:          z.string().max(255).optional().nullable(),
  location:            z.string().max(255).optional().nullable(),
  employmentType:      z.enum(EMP_TYPES).optional().nullable(),
  workMode:            z.enum(WORK_MODES).optional().nullable(),
  hiringManager:       z.string().max(255).optional().nullable(),
  recruiter:           z.string().max(255).optional().nullable(),
  openPositions:       z.number().int().min(1).default(1),
  status:              z.enum(JOB_STATUSES).default("draft"),
  description:         z.string().optional().nullable(),
  pipelineId:          z.string().uuid().optional().nullable(),
});

const patchJobSchema = createJobSchema.partial();

// ─── GET /jobs ────────────────────────────────────────────────────────────────

router.get("/", async (c) => {
  const orgId  = c.get("orgId");
  const status = c.req.query("status");
  const q      = c.req.query("q");

  const jobs = await db.hfJob.findMany({
    where: {
      organizationId: orgId,
      deletedAt: null,
      ...(status ? { status } : {}),
      ...(q ? {
        OR: [
          { title:      { contains: q, mode: "insensitive" } },
          { department: { contains: q, mode: "insensitive" } },
          { location:   { contains: q, mode: "insensitive" } },
        ],
      } : {}),
    },
    include: {
      _count: { select: { applications: { where: { deletedAt: null } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  return c.json(jobs.map(j => ({
    id:             j.id,
    organizationId: j.organizationId,
    pipelineId:     j.pipelineId,
    title:          j.title,
    department:     j.department,
    location:       j.location,
    employmentType: j.employmentType,
    workMode:       j.workMode,
    hiringManager:  j.hiringManagerUserId,
    recruiter:      j.recruiterUserId,
    openPositions:  j.openPositions,
    status:         j.status,
    description:    j.description,
    createdAt:      j.createdAt,
    updatedAt:      j.updatedAt,
    _count:         j._count,
  })));
});

// ─── POST /jobs ───────────────────────────────────────────────────────────────

router.post("/", zValidator("json", createJobSchema), async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const body  = c.req.valid("json");

  // Resolve pipeline — use provided or create org default
  let pipelineId = body.pipelineId ?? null;
  if (!pipelineId) {
    const pipeline = await getOrCreateDefaultPipeline(orgId);
    pipelineId = pipeline.id;
  }

  const job = await db.hfJob.create({
    data: {
      organizationId:      orgId,
      pipelineId,
      title:               body.title,
      department:          body.department ?? null,
      location:            body.location ?? null,
      employmentType:      body.employmentType ?? null,
      workMode:            body.workMode ?? null,
      hiringManagerUserId: body.hiringManager ?? null,
      recruiterUserId:     body.recruiter ?? null,
      openPositions:       body.openPositions,
      status:              body.status,
      description:         body.description ?? null,
    },
  });

  // Emit activity (fire-and-forget)
  void db.hfApplicationActivity.create({
    data: {
      organizationId: orgId,
      applicationId:  "00000000-0000-0000-0000-000000000000", // placeholder — no application yet
      activityType:   "JOB_CREATED",
      actorUserId:    user.id,
      metadata:       { jobId: job.id, title: job.title },
    },
  }).catch(() => {});

  return c.json({
    id:             job.id,
    organizationId: job.organizationId,
    pipelineId:     job.pipelineId,
    title:          job.title,
    department:     job.department,
    location:       job.location,
    employmentType: job.employmentType,
    workMode:       job.workMode,
    hiringManager:  job.hiringManagerUserId,
    recruiter:      job.recruiterUserId,
    openPositions:  job.openPositions,
    status:         job.status,
    description:    job.description,
    createdAt:      job.createdAt,
    updatedAt:      job.updatedAt,
  }, 201);
});

// ─── GET /jobs/:jobId ─────────────────────────────────────────────────────────

router.get("/:jobId", async (c) => {
  const orgId = c.get("orgId");
  const jobId = c.req.param("jobId");

  const job = await db.hfJob.findFirst({
    where: { id: jobId, organizationId: orgId, deletedAt: null },
    include: {
      pipeline: { include: { stages: { orderBy: { position: "asc" } } } },
      _count:   { select: { applications: { where: { deletedAt: null } } } },
    },
  });

  if (!job) return c.json({ error: "not_found" }, 404);

  return c.json({
    id:             job.id,
    organizationId: job.organizationId,
    pipelineId:     job.pipelineId,
    title:          job.title,
    department:     job.department,
    location:       job.location,
    employmentType: job.employmentType,
    workMode:       job.workMode,
    hiringManager:  job.hiringManagerUserId,
    recruiter:      job.recruiterUserId,
    openPositions:  job.openPositions,
    status:         job.status,
    description:    job.description,
    pipeline:       job.pipeline,
    createdAt:      job.createdAt,
    updatedAt:      job.updatedAt,
    _count:         job._count,
  });
});

// ─── PATCH /jobs/:jobId ───────────────────────────────────────────────────────

router.patch("/:jobId", zValidator("json", patchJobSchema), async (c) => {
  const orgId = c.get("orgId");
  const jobId = c.req.param("jobId");
  const body  = c.req.valid("json");

  const existing = await db.hfJob.findFirst({
    where: { id: jobId, organizationId: orgId, deletedAt: null },
  });
  if (!existing) return c.json({ error: "not_found" }, 404);

  const job = await db.hfJob.update({
    where: { id: jobId },
    data: {
      ...(body.title            !== undefined ? { title: body.title }                        : {}),
      ...(body.department       !== undefined ? { department: body.department }              : {}),
      ...(body.location         !== undefined ? { location: body.location }                  : {}),
      ...(body.employmentType   !== undefined ? { employmentType: body.employmentType }      : {}),
      ...(body.workMode         !== undefined ? { workMode: body.workMode }                  : {}),
      ...(body.hiringManager    !== undefined ? { hiringManagerUserId: body.hiringManager }  : {}),
      ...(body.recruiter        !== undefined ? { recruiterUserId: body.recruiter }          : {}),
      ...(body.openPositions    !== undefined ? { openPositions: body.openPositions }        : {}),
      ...(body.status           !== undefined ? { status: body.status }                      : {}),
      ...(body.description      !== undefined ? { description: body.description }            : {}),
    },
  });

  return c.json({
    id:             job.id,
    organizationId: job.organizationId,
    pipelineId:     job.pipelineId,
    title:          job.title,
    department:     job.department,
    location:       job.location,
    employmentType: job.employmentType,
    workMode:       job.workMode,
    hiringManager:  job.hiringManagerUserId,
    recruiter:      job.recruiterUserId,
    openPositions:  job.openPositions,
    status:         job.status,
    description:    job.description,
    createdAt:      job.createdAt,
    updatedAt:      job.updatedAt,
  });
});

// ─── DELETE /jobs/:jobId (soft) ───────────────────────────────────────────────

router.delete("/:jobId", async (c) => {
  const orgId = c.get("orgId");
  const jobId = c.req.param("jobId");

  const existing = await db.hfJob.findFirst({
    where: { id: jobId, organizationId: orgId, deletedAt: null },
  });
  if (!existing) return c.json({ error: "not_found" }, 404);

  await db.hfJob.update({
    where: { id: jobId },
    data: { deletedAt: new Date() },
  });

  return c.body(null, 204);
});

export { router as jobsRouter };
