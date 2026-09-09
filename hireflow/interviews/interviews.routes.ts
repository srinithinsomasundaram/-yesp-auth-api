import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createHfRouter } from "../hireflow.env.js";
import { db } from "../../src/db/client.js";
import { requirePermission } from "../middleware/permissions.middleware.js";
import { emitActivity } from "../shared/activity.js";

const router = createHfRouter();

// Status machine transitions
const VALID_TRANSITIONS: Record<string, string[]> = {
  requested:         ["scheduled", "cancelled"],
  scheduled:         ["confirmed", "cancelled", "completed"],
  confirmed:         ["completed", "cancelled"],
  completed:         ["feedback_pending"],
  feedback_pending:  ["feedback_complete"],
  feedback_complete: [],
  cancelled:         [],
};

function canTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

const createSchema = z.object({
  applicationId:  z.string().uuid(),
  roundId:        z.string().uuid().optional().nullable(),
  scorecardId:    z.string().uuid().optional().nullable(),
  title:          z.string().min(1).max(255),
  roundNumber:    z.number().int().min(1).optional().nullable(),
  scheduledStart: z.string().datetime().optional().nullable(),
  scheduledEnd:   z.string().datetime().optional().nullable(),
  timezone:       z.string().max(100).optional().nullable(),
  meetingUrl:     z.string().url().max(500).optional().nullable(),
  location:       z.string().max(500).optional().nullable(),
  status:         z.enum(["requested", "scheduled"]).default("scheduled"),
  participants:   z.array(z.object({
    userId:          z.string().uuid(),
    participantType: z.enum(["interviewer", "observer"]),
    feedbackRequired: z.boolean().default(true),
  })).optional(),
});

const patchSchema = z.object({
  title:          z.string().min(1).max(255).optional(),
  roundId:        z.string().uuid().optional().nullable(),
  scorecardId:    z.string().uuid().optional().nullable(),
  scheduledStart: z.string().datetime().optional().nullable(),
  scheduledEnd:   z.string().datetime().optional().nullable(),
  timezone:       z.string().max(100).optional().nullable(),
  meetingUrl:     z.string().url().max(500).optional().nullable(),
  location:       z.string().max(500).optional().nullable(),
});

const INCLUDE = {
  application: { select: { id: true, jobId: true, candidateId: true } },
  participants: true,
  feedbacks: { select: { id: true, participantId: true, recommendation: true, submittedAt: true } },
} as const;

// ─── GET /interviews ───────────────────────────────────────────────────────────

router.get("/", requirePermission("interview.view"), async (c) => {
  const orgId         = c.get("orgId");
  const applicationId = c.req.query("applicationId");
  const status        = c.req.query("status");
  const from          = c.req.query("from");
  const to            = c.req.query("to");

  const interviews = await db.hfInterview.findMany({
    where: {
      organizationId: orgId,
      ...(applicationId ? { applicationId } : {}),
      ...(status        ? { status }        : {}),
      ...(from || to    ? {
        scheduledStart: {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to   ? { lte: new Date(to)   } : {}),
        },
      } : {}),
    },
    include: INCLUDE,
    orderBy: { scheduledStart: "asc" },
  });

  return c.json(interviews);
});

// ─── POST /interviews ──────────────────────────────────────────────────────────

router.post("/", requirePermission("interview.schedule"), zValidator("json", createSchema), async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const body  = c.req.valid("json");

  const application = await db.hfApplication.findFirst({
    where: { id: body.applicationId, organizationId: orgId, deletedAt: null },
  });
  if (!application) return c.json({ error: "application_not_found" }, 404);

  const interview = await db.hfInterview.create({
    data: {
      organizationId:  orgId,
      applicationId:   body.applicationId,
      roundId:         body.roundId ?? null,
      scorecardId:     body.scorecardId ?? null,
      title:           body.title,
      roundNumber:     body.roundNumber ?? null,
      scheduledStart:  body.scheduledStart ? new Date(body.scheduledStart) : null,
      scheduledEnd:    body.scheduledEnd   ? new Date(body.scheduledEnd)   : null,
      timezone:        body.timezone  ?? null,
      meetingUrl:      body.meetingUrl ?? null,
      location:        body.location  ?? null,
      status:          body.status,
      createdByUserId: user.id,
      participants:    body.participants?.length ? {
        create: body.participants.map(p => ({
          userId:           p.userId,
          participantType:  p.participantType,
          feedbackRequired: p.feedbackRequired,
        })),
      } : undefined,
    },
    include: INCLUDE,
  });

  void emitActivity(orgId, body.applicationId, "INTERVIEW_SCHEDULED", user.id, {
    interviewId: interview.id,
    title:       interview.title,
    scheduledStart: interview.scheduledStart,
  });

  return c.json(interview, 201);
});

// ─── GET /interviews/:id ───────────────────────────────────────────────────────

router.get("/:id", requirePermission("interview.view"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const interview = await db.hfInterview.findFirst({
    where: { id, organizationId: orgId },
    include: {
      ...INCLUDE,
      feedbacks: {
        include: { answers: { include: { competency: true } } },
      },
    },
  });
  if (!interview) return c.json({ error: "not_found" }, 404);

  return c.json(interview);
});

// ─── PATCH /interviews/:id ────────────────────────────────────────────────────

router.patch("/:id", requirePermission("interview.edit"), zValidator("json", patchSchema), async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const id    = c.req.param("id");
  const body  = c.req.valid("json");

  const existing = await db.hfInterview.findFirst({ where: { id, organizationId: orgId } });
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.status === "cancelled" || existing.status === "feedback_complete") {
    return c.json({ error: "interview_locked" }, 400);
  }

  const interview = await db.hfInterview.update({
    where: { id },
    data: {
      ...(body.title          !== undefined ? { title: body.title }                  : {}),
      ...(body.roundId        !== undefined ? { roundId: body.roundId }              : {}),
      ...(body.scorecardId    !== undefined ? { scorecardId: body.scorecardId }      : {}),
      ...(body.scheduledStart !== undefined ? { scheduledStart: body.scheduledStart ? new Date(body.scheduledStart) : null } : {}),
      ...(body.scheduledEnd   !== undefined ? { scheduledEnd:   body.scheduledEnd   ? new Date(body.scheduledEnd)   : null } : {}),
      ...(body.timezone       !== undefined ? { timezone:  body.timezone }           : {}),
      ...(body.meetingUrl     !== undefined ? { meetingUrl: body.meetingUrl }        : {}),
      ...(body.location       !== undefined ? { location:  body.location }           : {}),
    },
    include: INCLUDE,
  });

  void emitActivity(orgId, existing.applicationId, "INTERVIEW_RESCHEDULED", user.id, { interviewId: id });

  return c.json(interview);
});

// ─── POST /interviews/:id/status ──────────────────────────────────────────────

router.post("/:id/status", requirePermission("interview.edit"), zValidator("json", z.object({
  status: z.string(),
  reason: z.string().optional().nullable(),
})), async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const id    = c.req.param("id");
  const { status, reason } = c.req.valid("json");

  const existing = await db.hfInterview.findFirst({ where: { id, organizationId: orgId } });
  if (!existing) return c.json({ error: "not_found" }, 404);

  if (!canTransition(existing.status, status)) {
    return c.json({ error: "invalid_transition", from: existing.status, to: status }, 400);
  }

  const data: Record<string, unknown> = { status };
  if (status === "completed")        data.completedAt = new Date();
  if (status === "cancelled")        { data.cancelledAt = new Date(); data.cancelReason = reason ?? null; }
  if (status === "feedback_pending") data.completedAt = data.completedAt ?? existing.completedAt ?? new Date();

  const interview = await db.hfInterview.update({ where: { id }, data, include: INCLUDE });

  const activityType = status === "cancelled"
    ? "INTERVIEW_CANCELLED"
    : status === "completed"
    ? "INTERVIEW_COMPLETED"
    : "INTERVIEW_STATUS_CHANGED";

  void emitActivity(orgId, existing.applicationId, activityType, user.id, { interviewId: id, status, reason });

  return c.json(interview);
});

// ─── POST /interviews/:id/cancel ──────────────────────────────────────────────

router.post("/:id/cancel", requirePermission("interview.cancel"), zValidator("json", z.object({
  reason: z.string().optional().nullable(),
})), async (c) => {
  const orgId   = c.get("orgId");
  const user    = c.get("user");
  const id      = c.req.param("id");
  const { reason } = c.req.valid("json");

  const existing = await db.hfInterview.findFirst({ where: { id, organizationId: orgId } });
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (!canTransition(existing.status, "cancelled")) {
    return c.json({ error: "cannot_cancel", status: existing.status }, 400);
  }

  const interview = await db.hfInterview.update({
    where: { id },
    data: { status: "cancelled", cancelledAt: new Date(), cancelReason: reason ?? null },
    include: INCLUDE,
  });

  void emitActivity(orgId, existing.applicationId, "INTERVIEW_CANCELLED", user.id, { interviewId: id, reason });

  return c.json(interview);
});

// ─── POST /interviews/:id/participants ─────────────────────────────────────────

router.post("/:id/participants", requirePermission("interview.edit"), zValidator("json", z.object({
  participants: z.array(z.object({
    userId:           z.string().uuid(),
    participantType:  z.enum(["interviewer", "observer"]),
    feedbackRequired: z.boolean().default(true),
  })).min(1),
})), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { participants } = c.req.valid("json");

  const existing = await db.hfInterview.findFirst({ where: { id, organizationId: orgId } });
  if (!existing) return c.json({ error: "not_found" }, 404);

  await Promise.all(participants.map(p =>
    db.hfInterviewParticipant.upsert({
      where: { interviewId_userId: { interviewId: id, userId: p.userId } },
      create: { interviewId: id, userId: p.userId, participantType: p.participantType, feedbackRequired: p.feedbackRequired },
      update: { participantType: p.participantType, feedbackRequired: p.feedbackRequired },
    })
  ));

  const updated = await db.hfInterview.findFirst({ where: { id }, include: INCLUDE });
  return c.json(updated);
});

// ─── DELETE /interviews/:id/participants/:userId ───────────────────────────────

router.delete("/:id/participants/:userId", requirePermission("interview.edit"), async (c) => {
  const orgId   = c.get("orgId");
  const id      = c.req.param("id");
  const userId  = c.req.param("userId");

  const existing = await db.hfInterview.findFirst({ where: { id, organizationId: orgId } });
  if (!existing) return c.json({ error: "not_found" }, 404);

  await db.hfInterviewParticipant.deleteMany({ where: { interviewId: id, userId } });
  return c.body(null, 204);
});

export { router as interviewsRouter };
