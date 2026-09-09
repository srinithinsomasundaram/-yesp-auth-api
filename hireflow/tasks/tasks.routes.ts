import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createHfRouter } from "../hireflow.env.js";
import { db } from "../../src/db/client.js";
import { requirePermission } from "../middleware/permissions.middleware.js";
import { emitActivity, emitAudit } from "../shared/activity.js";

const router = createHfRouter();

const TASK_STATUSES   = ["pending", "in_progress", "completed", "cancelled", "snoozed"] as const;
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

const createSchema = z.object({
  taskType:        z.string().min(1).max(100),
  title:           z.string().min(1).max(500),
  description:     z.string().optional().nullable(),
  status:          z.enum(TASK_STATUSES).default("pending"),
  priority:        z.enum(TASK_PRIORITIES).default("normal"),
  assignedToUserId:z.string().uuid().optional().nullable(),
  applicationId:   z.string().uuid().optional().nullable(),
  candidateId:     z.string().uuid().optional().nullable(),
  jobId:           z.string().uuid().optional().nullable(),
  dueAt:           z.string().datetime().optional().nullable(),
  sourceEvent:     z.string().max(100).optional().nullable(),
});

const patchSchema = createSchema.partial();

// ─── GET /tasks ────────────────────────────────────────────────────────────────

router.get("/", requirePermission("task.view"), async (c) => {
  const orgId  = c.get("orgId");
  const status = c.req.query("status");
  const assignedToUserId = c.req.query("assignedTo");
  const applicationId    = c.req.query("applicationId");
  const jobId            = c.req.query("jobId");
  const priority         = c.req.query("priority");
  const overdue          = c.req.query("overdue") === "true";

  const tasks = await db.hfTask.findMany({
    where: {
      organizationId: orgId,
      deletedAt: null,
      ...(status            ? { status }            : {}),
      ...(assignedToUserId  ? { assignedToUserId }  : {}),
      ...(applicationId     ? { applicationId }     : {}),
      ...(jobId             ? { jobId }             : {}),
      ...(priority          ? { priority }          : {}),
      ...(overdue ? { dueAt: { lt: new Date() }, status: { notIn: ["completed", "cancelled"] } } : {}),
    },
    orderBy: [{ priority: "desc" }, { dueAt: "asc" }],
  });

  return c.json(tasks);
});

// ─── POST /tasks ───────────────────────────────────────────────────────────────

router.post("/", requirePermission("task.assign"), zValidator("json", createSchema), async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const body  = c.req.valid("json");

  const task = await db.hfTask.create({
    data: {
      organizationId:   orgId,
      taskType:         body.taskType,
      title:            body.title,
      description:      body.description      ?? null,
      status:           body.status,
      priority:         body.priority,
      assignedToUserId: body.assignedToUserId ?? null,
      applicationId:    body.applicationId    ?? null,
      candidateId:      body.candidateId      ?? null,
      jobId:            body.jobId            ?? null,
      dueAt:            body.dueAt ? new Date(body.dueAt) : null,
      sourceEvent:      body.sourceEvent      ?? null,
    },
  });

  if (body.applicationId) {
    void emitActivity(orgId, body.applicationId, "TASK_CREATED", user.id, {
      taskId: task.id, title: task.title, assignedToUserId: task.assignedToUserId,
    });
  }

  return c.json(task, 201);
});

// ─── GET /tasks/:id ────────────────────────────────────────────────────────────

router.get("/:id", requirePermission("task.view"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const task = await db.hfTask.findFirst({
    where: { id, organizationId: orgId, deletedAt: null },
    include: {
      application: { select: { id: true, jobId: true, candidateId: true, status: true } },
      candidate:   { select: { id: true, firstName: true, lastName: true, email: true } },
      job:         { select: { id: true, title: true } },
    },
  });
  if (!task) return c.json({ error: "not_found" }, 404);

  return c.json(task);
});

// ─── PATCH /tasks/:id ─────────────────────────────────────────────────────────

router.patch("/:id", requirePermission("task.assign"), zValidator("json", patchSchema), async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const id    = c.req.param("id");
  const body  = c.req.valid("json");

  const existing = await db.hfTask.findFirst({ where: { id, organizationId: orgId, deletedAt: null } });
  if (!existing) return c.json({ error: "not_found" }, 404);

  const completedAt = body.status === "completed" && !existing.completedAt ? new Date() : existing.completedAt;

  const task = await db.hfTask.update({
    where: { id },
    data: {
      ...(body.title            !== undefined ? { title: body.title }                             : {}),
      ...(body.description      !== undefined ? { description: body.description }                 : {}),
      ...(body.status           !== undefined ? { status: body.status, completedAt }              : {}),
      ...(body.priority         !== undefined ? { priority: body.priority }                       : {}),
      ...(body.assignedToUserId !== undefined ? { assignedToUserId: body.assignedToUserId }       : {}),
      ...(body.dueAt            !== undefined ? { dueAt: body.dueAt ? new Date(body.dueAt) : null } : {}),
    },
  });

  if (task.applicationId) {
    const type = body.status === "completed" ? "TASK_COMPLETED"
               : body.assignedToUserId !== existing.assignedToUserId ? "TASK_REASSIGNED"
               : "TASK_UPDATED";
    void emitActivity(orgId, task.applicationId, type, user.id, { taskId: id });
  }

  void emitAudit(orgId, user.id, "TASK_UPDATED", "task", id, existing, task);
  return c.json(task);
});

// ─── POST /tasks/:id/complete ─────────────────────────────────────────────────

router.post("/:id/complete", requirePermission("task.complete"), async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const id    = c.req.param("id");

  const existing = await db.hfTask.findFirst({ where: { id, organizationId: orgId, deletedAt: null } });
  if (!existing)                        return c.json({ error: "not_found" }, 404);
  if (existing.status === "completed")  return c.json({ error: "already_completed" }, 400);
  if (existing.status === "cancelled")  return c.json({ error: "task_cancelled" }, 400);

  const task = await db.hfTask.update({
    where: { id },
    data: { status: "completed", completedAt: new Date() },
  });

  if (task.applicationId) {
    void emitActivity(orgId, task.applicationId, "TASK_COMPLETED", user.id, { taskId: id, title: task.title });
  }

  return c.json(task);
});

// ─── DELETE /tasks/:id (soft) ─────────────────────────────────────────────────

router.delete("/:id", requirePermission("task.assign"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const existing = await db.hfTask.findFirst({ where: { id, organizationId: orgId, deletedAt: null } });
  if (!existing) return c.json({ error: "not_found" }, 404);

  await db.hfTask.update({ where: { id }, data: { deletedAt: new Date() } });
  return c.body(null, 204);
});

// ─── POST /tasks/bulk ─────────────────────────────────────────────────────────

router.post("/bulk", requirePermission("task.assign"), zValidator("json", z.object({
  ids:    z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(["complete", "cancel", "assign", "set_priority"]),
  payload: z.record(z.unknown()).optional(),
})), async (c) => {
  const orgId = c.get("orgId");
  const { ids, action, payload } = c.req.valid("json");

  const tasks = await db.hfTask.findMany({
    where: { id: { in: ids }, organizationId: orgId, deletedAt: null },
  });

  const found = tasks.map(t => t.id);
  const missing = ids.filter(id => !found.includes(id));

  let updated = 0;
  switch (action) {
    case "complete":
      ({ count: updated } = await db.hfTask.updateMany({
        where: { id: { in: found }, status: { notIn: ["completed", "cancelled"] } },
        data:  { status: "completed", completedAt: new Date() },
      }));
      break;
    case "cancel":
      ({ count: updated } = await db.hfTask.updateMany({
        where: { id: { in: found } },
        data:  { status: "cancelled" },
      }));
      break;
    case "assign":
      ({ count: updated } = await db.hfTask.updateMany({
        where: { id: { in: found } },
        data:  { assignedToUserId: (payload?.userId as string) ?? null },
      }));
      break;
    case "set_priority":
      ({ count: updated } = await db.hfTask.updateMany({
        where: { id: { in: found } },
        data:  { priority: payload?.priority as string ?? "normal" },
      }));
      break;
  }

  return c.json({ updated, missing });
});

export { router as tasksRouter };
